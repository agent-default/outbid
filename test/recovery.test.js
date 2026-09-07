import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PREFLIGHT_TTL_MS, applyDeliveryCheck, beforePayment,
  buildAssessment, challengeBind, challengeChanged, checkBrowseExpectation,
  gate402, nextFor, nextForAssessment, nextFromError, policyAbort,
} from "../skills/outbid/smart-fetch.js";

const rail = {
  scheme: "exact", network: "solana",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  maxAmountRequired: "50000",
  payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const bind = challengeBind("https://example.com/paid", "GET", [rail]);
const allowWallet = [{ seller: rail.payTo, decision: "allow", cap: null, at: Date.now() }];

test("next mapper: each recovery condition, and retry_payment never true on uncertain pay or wall", () => {
  assert.deepEqual(nextFor("reassess"), { action: "reassess", retry_payment: false, human: false });
  assert.deepEqual(nextFor("stop_auth_required"), { action: "stop_auth_required", retry_payment: false, human: false });
  assert.deepEqual(nextFor("reconcile_settlement"), { action: "reconcile_settlement", retry_payment: false, human: false });
  assert.deepEqual(nextFor("escalate"), { action: "escalate", retry_payment: false, human: "missing_authority" });
  assert.equal(nextFor("record_failed_delivery").retry_payment, "only_if_mandate_allows");
  assert.equal(nextFromError("pay_uncertain").action, "reconcile_settlement");
  assert.equal(nextFromError("pay_uncertain").retry_payment, false);
  assert.equal(nextForAssessment(null, { wallReason: "needs_login" }).retry_payment, false);
  assert.equal(nextForAssessment(null, { wallReason: "needs_bot" }).action, "stop_auth_required");
  assert.equal(nextFromError("TwzrdChallengeChangedError").action, "reassess");
  assert.equal(nextFromError("TwzrdPolicyAbortError").action, "escalate");
});

test("stale assessment asks for refresh, not another payment", () => {
  const a = buildAssessment({
    bind, wallets: allowWallet, endpoint: { method_hold: "hold" },
    action: "proceed", reasons: ["wallet_no_block"], cap: null,
    now: Date.now() - PREFLIGHT_TTL_MS - 1,
  });
  const n = nextForAssessment(a, { now: Date.now() });
  assert.equal(n.action, "refresh_assessment");
  assert.equal(n.retry_payment, false);
});

test("challengeChanged and policyAbort carry next on the error", () => {
  const a = buildAssessment({
    bind, wallets: allowWallet, endpoint: { method_hold: "hold" },
    action: "proceed", reasons: ["wallet_no_block"],
  });
  const ch = challengeChanged(a, { payTo: "other" });
  assert.equal(ch.next.action, "reassess");
  assert.equal(ch.next.retry_payment, false);
  const refused = buildAssessment({
    bind, wallets: [{ seller: rail.payTo, decision: "block", cap: null }],
    endpoint: { method_hold: "hold" }, action: "refuse", reasons: ["wallet_block"],
  });
  assert.equal(refused.next.action, "escalate");
  const pe = policyAbort(refused);
  assert.equal(pe.next.action, "escalate");
  assert.equal(pe.next.human, "missing_authority");
});

test("beforePayment aborts on changed terms, stale, or refuse; never mutates", () => {
  const a = buildAssessment({
    bind, wallets: allowWallet, endpoint: { method_hold: "hold" },
    action: "proceed", reasons: ["wallet_no_block"],
  });
  assert.equal(beforePayment(rail, a), undefined);
  const drift = beforePayment({ ...rail, maxAmountRequired: "60000" }, a);
  assert.equal(drift.abort, true);
  assert.equal(drift.next.action, "reassess");
  assert.equal(drift.next.retry_payment, false);
  const stale = beforePayment(rail, a, { now: a.observed.at + PREFLIGHT_TTL_MS + 1 });
  assert.equal(stale.abort, true);
  assert.equal(stale.next.action, "refresh_assessment");
  const blocked = buildAssessment({
    bind, wallets: [{ seller: rail.payTo, decision: "block", cap: null }],
    endpoint: { method_hold: "hold" }, action: "refuse", reasons: ["wallet_block"],
  });
  const esc = beforePayment(rail, blocked);
  assert.equal(esc.abort, true);
  assert.equal(esc.next.action, "escalate");
});

test("wall 422 is stop; failed output check is record_failed_delivery; HTTP 200 is not proof", () => {
  const wall = checkBrowseExpectation({ ok: false, reason: "needs_login" });
  assert.equal(wall.next.action, "stop_auth_required");
  assert.equal(wall.next.retry_payment, false);
  const bot = checkBrowseExpectation({ ok: false, reason: "needs_bot" });
  assert.equal(bot.next.action, "stop_auth_required");
  const thin = checkBrowseExpectation({ ok: true, word_count: 2 });
  assert.equal(thin.next.action, "record_failed_delivery");
  assert.equal(thin.next.retry_payment, "only_if_mandate_allows");
  const a = buildAssessment({
    bind, wallets: allowWallet, endpoint: { method_hold: "hold" },
    action: "proceed", reasons: ["wallet_no_block"],
  });
  const after = applyDeliveryCheck(a, { ok: true, word_count: 2 });
  assert.equal(after.delivered.met, false);
  assert.equal(after.observed.delivery_proof, "unverified");
  assert.equal(JSON.stringify(after.decided), JSON.stringify(a.decided));
  const ok = checkBrowseExpectation({ ok: true, word_count: 50 });
  assert.equal(ok.met, true);
  assert.equal(ok.next.action, "proceed");
});

test("gate402 refuse still unpaid and next is escalate", async () => {
  const seen = [];
  const invoice = new Response(JSON.stringify({ x402Version: 1, accepts: [rail] }), { status: 402 });
  await assert.rejects(
    () => gate402(invoice, seen, async (seller) => ({ seller, decision: "block", cap: null }), { skipHead: true, url: bind.url, method: "GET" }),
    (e) => e.name === "TwzrdPolicyAbortError" && e.next.action === "escalate" && e.next.retry_payment === false,
  );
});

test("no failure class resolves to proceed by default", async () => {
  const { nextFromError, NEXT } = await import("../skills/outbid/smart-fetch.js");
  // The only class that may legitimately say proceed is a transient cooldown:
  // nothing was sent and the assessed terms are still valid.
  assert.equal(nextFromError("cooldown").action, "proceed");
  for (const cls of ["pay_fail", "route_fail", "fallback_fail", "totally_unknown", ""]) {
    assert.notEqual(nextFromError(cls).action, "proceed", `${cls} must not resolve to proceed`);
  }
  assert.equal(nextFromError("totally_unknown").action, "stop_unclassified");
  assert.equal(nextFromError("totally_unknown").human, "unclassified_failure");
  // Money-critical: nothing ever authorizes an unconditional repeat payment.
  for (const k of Object.keys(NEXT)) assert.notEqual(NEXT[k].retry_payment, true);
});

test("needs_browser is self-recoverable, not a human interruption", async () => {
  const { nextFromError, checkBrowseExpectation } = await import("../skills/outbid/smart-fetch.js");
  assert.equal(nextFromError("x", { wallReason: "needs_browser" }).action, "reassess");
  assert.equal(checkBrowseExpectation({ reason: "needs_browser" }).next.action, "reassess");
  // a real wall still stops
  assert.equal(checkBrowseExpectation({ reason: "needs_login" }).next.action, "stop_auth_required");
  // an unknown reason must not proceed and must not pretend to be needs_browser
  assert.equal(nextForAssessment(null, { wallReason: "needs_captcha" }).action, "stop_unclassified");
  assert.equal(nextFromError("x", { wallReason: "needs_captcha" }).action, "stop_unclassified");
});

test("an unrecognised 422 reason never buys a retry through the delivery check", async () => {
  const { checkBrowseExpectation, nextForAssessment } = await import("../skills/outbid/smart-fetch.js");
  for (const r of ["needs_captcha", "needs_something_new", "geo_blocked"]) {
    const viaCheck = checkBrowseExpectation({ reason: r }).next;
    const viaAssessment = nextForAssessment(null, { wallReason: r });
    assert.equal(viaCheck.action, "stop_unclassified", `${r} via delivery check`);
    assert.equal(viaCheck.action, viaAssessment.action, `${r}: both paths must agree`);
    assert.notEqual(viaCheck.retry_payment, "only_if_mandate_allows");
  }
  // a genuine short body is still a delivery failure, retryable under the mandate
  assert.equal(checkBrowseExpectation({ ok: true, word_count: 2 }).next.action, "record_failed_delivery");
  assert.equal(checkBrowseExpectation({ ok: true, word_count: 500 }).next.action, "proceed");
});
