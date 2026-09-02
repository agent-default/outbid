import assert from "node:assert/strict";
import { test } from "node:test";
import { browseFromScrape, circuits, metrics, smartFetch } from "../skills/outbid/smart-fetch.js";

const reset = () => {
  for (const k of Object.keys(metrics)) metrics[k] = 0;
  circuits.clear();
};

const namedError = (name, message) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

const html = new Response("<html><body>hi</body></html>", { status: 200, headers: { "content-type": "text/html" } });
const rec = (calls) => async (u) => {
  const s = String(u);
  calls.push(s);
  if (s.includes("/browse")) return new Response(JSON.stringify({ ok: true, markdown: "b" }), { status: 200 });
  if (s.includes("/scrape")) return new Response(JSON.stringify({ ok: false, reason: "needs_browser" }), { status: 422 });
  return html.clone();
};

test("browser:true pays /browse not /scrape; markdown 422 does not follow browse", async () => {
  assert.equal(browseFromScrape("https://reader.outbid.sh/scrape"), "https://reader.outbid.sh/browse");
  const a = [];
  const r = await smartFetch("https://example.com/", { browser: true, paid: rec(a) }, {});
  assert.equal(r.status, 200);
  assert.ok(a.some((u) => u.startsWith("https://reader.outbid.sh/browse?url=")));
  assert.ok(!a.some((u) => u.includes("/scrape")));
  const b = [];
  const s = await smartFetch("https://example.com/p", { markdown: true, paid: rec(b) }, {});
  assert.equal(s.status, 422);
  assert.ok(b.some((u) => u.includes("/scrape?url=")));
  assert.ok(!b.some((u) => u.includes("/browse")));
});

test("a wash/policy abort from paid() is terminal — never hops /route, never counts as origin_failure", async () => {
  const seen = [];
  const paid = async (u) => { seen.push(String(u)); throw namedError("TwzrdPolicyAbortError", "budget"); };

  reset();
  await assert.rejects(
    () => smartFetch("https://origin.example/paid", { paid }, {}),
    (err) => err.name === "SmartFetchError" && err.stage === "policy" && err.paymentAttempted === false,
  );
  assert.equal(seen.some((u) => u.includes("outbid.sh/route")), false);
  assert.equal(metrics.route_paid, 0);
  assert.equal(metrics.origin_failure, 0);

  seen.length = 0;
  reset();
  const washPaid = async (u) => { seen.push(String(u)); throw namedError("TwzrdWashAbortError", "wash"); };
  await assert.rejects(
    () => smartFetch("https://origin2.example/paid", { paid: washPaid }, {}),
    (err) => err.name === "SmartFetchError" && err.stage === "policy",
  );
  assert.equal(seen.some((u) => u.includes("outbid.sh/route")), false);
  assert.equal(metrics.route_paid, 0);
  assert.equal(metrics.origin_failure, 0);
});

test("a plain (unnamed) paid() failure still falls through to one /route hop", async () => {
  reset();
  const calls = [];
  const paid = async (u) => {
    const s = String(u);
    calls.push(s);
    if (s.includes("outbid.sh/route")) {
      return new Response(JSON.stringify({ url: "https://fallback.example/top" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (s.includes("fallback.example")) return html.clone();
    throw new TypeError("network blip");
  };
  const r = await smartFetch("https://origin3.example/paid", { paid }, {});
  assert.equal(r.status, 200);
  assert.ok(calls.some((u) => u.includes("outbid.sh/route")));
  assert.equal(metrics.origin_failure, 1);
  assert.equal(metrics.route_paid, 1);
});
