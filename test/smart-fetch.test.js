import assert from "node:assert/strict";
import { test } from "node:test";
import { browseFromScrape, smartFetch } from "../skills/outbid/smart-fetch.js";

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
