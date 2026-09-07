import assert from "node:assert/strict";
import { test } from "node:test";
import { recovery, NEXT, EVIDENCE_TTL_MS } from "../skills/outbid/recovery.js";
import { challengeBind, buildAssessment } from "../skills/outbid/smart-fetch.js";

const sfe = (stage, errorClass, extra = {}) => Object.assign(new Error(errorClass), { name: "SmartFetchError", stage, errorClass, ...extra });
const RAIL = { scheme: "exact", network: "solana", asset: "EPjF", maxAmountRequired: "50000", payTo: "F1Ab" };
const fresh = (now) => buildAssessment({ bind: challengeBind("https://x.test/r", "GET", [RAIL]), wallets: [], endpoint: { method_hold: "hold" }, action: "proceed", reasons: [], now });

test("a refusal that sent nothing is never reported as possible settlement", () => {
  const r = recovery(sfe("policy", "TwzrdChallengeChangedError"));
  assert.equal(r.reason, "challenge_changed");
  assert.equal(r.paid, "no");
  assert.equal(r.settlement, "none");
  assert.equal(r.next, NEXT.REASSESS);
  assert.equal(r.retry_same_terms, false);
});

test("possible settlement never recommends paying again", () => {
  const r = recovery(sfe("origin", "pay_uncertain"));
  assert.equal(r.settlement, "uncertain");
  assert.equal(r.paid, "maybe");
  assert.equal(r.next, NEXT.RECONCILE_SETTLEMENT);
  assert.ok(r.unknown.includes("settlement_state"));
  assert.notEqual(r.next, NEXT.WAIT_AND_RETRY);
});

test("authority-shaped stops are marked, not retried", () => {
  for (const [o, reason] of [
    [sfe("policy", "TwzrdPolicyAbortError"), "refused_by_assessment"],
    [{ res: { status: 422, ok: false }, body: { reason: "needs_login" } }, "login_wall"],
  ]) {
    const r = recovery(o);
    assert.equal(r.reason, reason);
    assert.equal(r.needs_authority, true);
    assert.equal(r.retry_same_terms, false);
  }
  // a bot gate is not an authority problem: a password would not help
  const bot = recovery({ res: { status: 422, ok: false }, body: { reason: "needs_bot" } });
  assert.equal(bot.needs_authority, false);
  assert.equal(bot.next, NEXT.STOP_ATTEMPT);
});

test("a 200 is never reported as delivered", () => {
  const r = recovery({ res: { status: 200, ok: true }, body: {} });
  assert.equal(r.reason, "returned_delivery_unverified");
  assert.equal(r.next, NEXT.VERIFY_DELIVERY);
  assert.ok(r.unknown.includes("delivery"));
});

test("stale evidence turns a retry into a refresh", () => {
  const now = Date.now();
  const old = fresh(now - EVIDENCE_TTL_MS - 1000);
  const r = recovery(sfe("origin", "cooldown"), { assessment: old, now });
  assert.equal(r.evidence_stale, true);
  assert.equal(r.next, NEXT.REFRESH_EVIDENCE);
  const ok = recovery(sfe("origin", "cooldown"), { assessment: fresh(now), now });
  assert.equal(ok.evidence_stale, false);
  assert.equal(ok.next, NEXT.WAIT_AND_RETRY);
  assert.equal(ok.retry_same_terms, true);
});

test("an exhausted mandate withdraws permission to spend again", () => {
  const spent = recovery(sfe("policy", "TwzrdChallengeChangedError"), { mandate: { remaining_usdc: 0, per_call_cap_usdc: 0.05 } });
  assert.equal(spent.next, NEXT.DO_NOT_PAY);
  assert.equal(spent.needs_authority, true);
  const left = recovery(sfe("policy", "TwzrdChallengeChangedError"), { mandate: { remaining_usdc: 1.5 } });
  assert.equal(left.next, NEXT.REASSESS);
  assert.equal(left.allowance.remaining_usdc, 1.5);
  // no mandate supplied is an explicit unknown, not an assumed allowance
  assert.ok(recovery(sfe("origin", "cooldown")).unknown.includes("mandate_not_supplied"));
});

test("an unclassified failure says so instead of guessing a next step", () => {
  const r = recovery(Object.assign(new Error("weird"), { name: "SomethingElse" }));
  assert.equal(r.reason, "unclassified");
  assert.ok(r.unknown.includes("failure_class"));
  assert.equal(r.next, NEXT.ABORT);
});
