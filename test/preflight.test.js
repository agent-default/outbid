import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gate402, metrics, sellersFromInvoice, smartFetch, twzrdCheck, verdicts, PREFLIGHT_TTL_MS,
} from "../skills/outbid/smart-fetch.js";

const reset = () => { for (const k of Object.keys(metrics)) metrics[k] = 0; verdicts.clear(); };
const invoice = (accepts) => new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402 });
const ACC = [
  { scheme: "exact", network: "base", maxAmountRequired: "50000", payTo: "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F" },
  { scheme: "exact", network: "solana", maxAmountRequired: "50000", payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
];

test("sellers and price come off either the v1 body or the v2 header", () => {
  assert.deepEqual(sellersFromInvoice({ accepts: ACC }), [
    { seller: ACC[0].payTo, price: 0.05 }, { seller: ACC[1].payTo, price: 0.05 },
  ]);
  const hdr = Buffer.from(JSON.stringify({ accepts: [{ payTo: "Sol1", amount: "1000" }] })).toString("base64");
  assert.deepEqual(sellersFromInvoice(null, hdr), [{ seller: "Sol1", price: 0.001 }]);
  assert.deepEqual(sellersFromInvoice(null, "not-base64"), []);
});

test("block on any advertised rail aborts the hop unpaid and terminally", async () => {
  reset();
  const seen = [];
  await assert.rejects(
    () => gate402(invoice(ACC), seen, async (seller) => ({ seller, decision: seller.startsWith("0x") ? "allow" : "block", cap: null })),
    (e) => e.name === "TwzrdPolicyAbortError" && e.twzrd.decision === "block",
  );
  assert.equal(seen.length, 2, "both rails recorded on the hop");
});

test("warn and allow pass through, and the verdict rides the hop", async () => {
  reset();
  const seen = [];
  await gate402(invoice(ACC), seen, async (seller) => ({ seller, decision: "warn", cap: 0.05 }));
  assert.deepEqual(seen.map((v) => v.decision), ["warn", "warn"]);
  assert.equal(seen[0].cap, 0.05);
});

test("an unreachable CHECK is unavailable, never a block", async () => {
  reset();
  const v = await twzrdCheck("Sol1", 0.05, { url: "http://127.0.0.1:1/preflight" });
  assert.equal(v.decision, "unavailable");
  assert.equal(metrics.preflight_unavailable, 1);
  assert.equal(metrics.preflight_block, 0);
});

test("verdicts cache per seller, and a new seller re-checks mid-task", async () => {
  reset();
  let calls = 0;
  const url = "http://127.0.0.1:1/preflight";
  const stub = async (seller) => { calls++; return { seller, decision: "allow", cap: null, at: Date.now() }; };
  const seen = [];
  await gate402(invoice(ACC), seen, stub);
  await gate402(invoice(ACC), seen, stub);
  assert.equal(calls, 4, "the stub is the cache boundary here; the real one memoises");
  // real memoisation: two calls for the same seller hit the network once
  reset();
  const before = Date.now();
  await twzrdCheck("SolCached", 0.05, { url });
  await twzrdCheck("SolCached", 0.05, { url });
  assert.equal(metrics.preflight_unavailable, 1, "second call served from cache");
  assert.ok(Date.now() - before < PREFLIGHT_TTL_MS);
});

test("preflight is OFF unless asked: no CHECK, no behaviour change", async () => {
  reset();
  const hits = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { hits.push(String(u)); return origFetch(u, i); };
  try {
    const paid = async () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } });
    const r = await smartFetch("https://example.com/", { paid }, {});
    assert.equal(r.status, 200);
    assert.equal(hits.filter((u) => u.includes("intel.twzrd.xyz")).length, 0);
    assert.equal(metrics.preflight_allow + metrics.preflight_warn + metrics.preflight_block, 0);
  } finally { globalThis.fetch = origFetch; }
});
