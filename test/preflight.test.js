import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSESSMENT_VERSION, acceptedFromPayment, assessmentAuthorizes, assessmentCoversAccepted,
  challengeBind, decideMandate, gate402, metrics, observeMethodHold, recordDelivered,
  sellersFromInvoice, smartFetch, twzrdCheck, verdicts, PREFLIGHT_TTL_MS,
} from "../skills/outbid/smart-fetch.js";

const reset = () => { for (const k of Object.keys(metrics)) metrics[k] = 0; verdicts.clear(); };
const invoice = (accepts) => new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402 });
const ACC = [
  { scheme: "exact", network: "base", maxAmountRequired: "50000", payTo: "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F" },
  { scheme: "exact", network: "solana", maxAmountRequired: "50000", payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
];
const allow = async (seller) => ({ seller, decision: "allow", cap: null, at: Date.now() });
const req = { url: "https://reader.outbid.sh/browse?url=https://example.com/", method: "GET", skipHead: true };

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
    () => gate402(invoice(ACC), seen, async (seller) => ({ seller, decision: seller.startsWith("0x") ? "allow" : "block", cap: null }), req),
    (e) => e.name === "TwzrdPolicyAbortError" && e.twzrd.decided.action === "refuse",
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].version, ASSESSMENT_VERSION);
  assert.equal(seen[0].observed.wallet.length, 2, "both rails recorded on the hop");
  assert.equal(seen[0].delivered, null);
  assert.ok(seen[0].observed.missing.includes("delivery_proof"));
});

test("warn and allow pass through, and the verdict rides the hop", async () => {
  reset();
  const seen = [];
  await gate402(invoice(ACC), seen, async (seller) => ({ seller, decision: "warn", cap: 0.05 }), req);
  assert.equal(seen[0].decided.action, "cap");
  assert.equal(seen[0].decided.cap, 0.05);
  assert.equal(seen[0].delivered, null);
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
  await gate402(invoice(ACC), seen, stub, req);
  await gate402(invoice(ACC), seen, stub, req);
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

test("v1 base and v2 CAIP are the same challenge bind", () => {
  const a = challengeBind("https://x.example/p", "GET", ACC);
  const b = challengeBind("https://x.example/p", "get", [
    { ...ACC[0], network: "eip155:8453" },
    { ...ACC[1], network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  ]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("a changed amount, payTo, URL, or method cannot reuse the assessment", async () => {
  reset();
  const seen = [];
  await gate402(invoice(ACC), seen, allow, req);
  assert.equal(seen[0].decided.action, "proceed");
  const drifted = ACC.map((a) => ({ ...a, maxAmountRequired: "60000" }));
  await assert.rejects(
    () => gate402(invoice(drifted), seen, allow, req),
    (e) => e.name === "TwzrdChallengeChangedError",
  );
  await assert.rejects(
    () => gate402(invoice(ACC), seen, allow, { ...req, url: "https://other.example/" }),
    (e) => e.name === "TwzrdChallengeChangedError",
  );
  await assert.rejects(
    () => gate402(invoice(ACC), seen, allow, { ...req, method: "POST" }),
    (e) => e.name === "TwzrdChallengeChangedError",
  );
  const otherPay = [{ ...ACC[0], payTo: "0x0000000000000000000000000000000000000001" }, ACC[1]];
  await assert.rejects(
    () => gate402(invoice(otherPay), seen, allow, req),
    (e) => e.name === "TwzrdChallengeChangedError",
  );
});

test("delivered later does not rewrite observed or decided", async () => {
  reset();
  const seen = [];
  await gate402(invoice(ACC), seen, allow, req);
  const before = JSON.stringify(seen[0].observed);
  const decided = JSON.stringify(seen[0].decided);
  const later = recordDelivered(seen[0], { met: true, expectation: "word_count>=10" });
  assert.equal(seen[0].delivered, null);
  assert.equal(JSON.stringify(seen[0].observed), before);
  assert.equal(JSON.stringify(seen[0].decided), decided);
  assert.equal(later.delivered.met, true);
  assert.equal(later.observed.delivery_proof, "unverified");
});

test("HEAD 200 is inspect, not a refusal", async () => {
  const endpoint = await observeMethodHold("https://example.com/", {
    fetchImpl: async () => new Response(null, { status: 200, headers: { "content-length": "12" } }),
  });
  assert.equal(endpoint.method_hold, "head_200");
  const d = decideMandate([{ seller: "x", decision: "allow", cap: null }], endpoint);
  assert.equal(d.action, "proceed");
  assert.ok(d.reasons.includes("head_200_inspect"));
});

test("payment accepted on a rail not in the assessment is unauthorized", () => {
  const bind = challengeBind(req.url, "GET", ACC);
  const assessment = { version: ASSESSMENT_VERSION, challenge: bind };
  assert.equal(assessmentAuthorizes(assessment, bind), true);
  const pay = Buffer.from(JSON.stringify({
    accepted: { payTo: ACC[0].payTo, network: "eip155:8453", amount: "50000", scheme: "exact" },
  })).toString("base64");
  assert.equal(assessmentCoversAccepted(assessment, acceptedFromPayment(pay)), true);
  const other = Buffer.from(JSON.stringify({
    accepted: { payTo: ACC[0].payTo, network: "eip155:8453", amount: "60000", scheme: "exact" },
  })).toString("base64");
  assert.equal(assessmentCoversAccepted(assessment, acceptedFromPayment(other)), false);
});

test("a payment cannot drop a bound term to escape the assessment", async () => {
  const { challengeBind, buildAssessment, assessmentCoversAccepted, acceptedFromPayment } =
    await import("../skills/outbid/smart-fetch.js");
  const rail = { scheme: "exact", network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxAmountRequired: "50000", payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" };
  const A = buildAssessment({ bind: challengeBind("https://x.test/r", "GET", [rail]), wallets: [], endpoint: { method_hold: "hold" }, action: "proceed", reasons: [] });
  const pay = (o) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "solana", asset: rail.asset, amount: "50000", payTo: rail.payTo, ...o } })).toString("base64");
  const covers = (o) => assessmentCoversAccepted(A, acceptedFromPayment(pay(o)));
  assert.equal(covers({}), true, "the assessed terms are authorised");
  assert.equal(covers({ asset: undefined }), false, "an omitted asset is not a wildcard");
  assert.equal(covers({ asset: "So11111111111111111111111111111111111111112" }), false, "a swapped asset is refused");
  assert.equal(covers({ scheme: "upto" }), false, "scheme is a bound term");
  assert.equal(covers({ amount: "5000000" }), false);
  assert.equal(covers({ network: "base" }), false);
});
