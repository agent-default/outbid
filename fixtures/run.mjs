// Self-serve evaluation. No funds, no network, no wallet, no signature.
// Runs the real assessment code against deterministic evidence and compares to
// the machine-readable expectations in cases.json. Exit 0 = all matched.
// Runs are marked fixture:true so they can never be counted as external adoption.
import fs from "node:fs";
import {
  challengeBind, buildAssessment, decideMandate, assessmentAuthorizes,
  assessmentCoversAccepted, acceptedFromPayment, recordDelivered, ASSESSMENT_VERSION,
  nextFromError, checkBrowseExpectation,
} from "../skills/outbid/smart-fetch.js";


const SPEC = JSON.parse(fs.readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const URL_ = "https://fixture.invalid/paid-resource";
const RAIL = { scheme: "exact", network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxAmountRequired: "50000", payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" };
const OTHER = "9urRvUx69HqAopvnbCbLpMGN1hVoi6gQYSKz1z6ZUCA5";

const bind = (rails = [RAIL], url = URL_, method = "GET") => challengeBind(url, method, rails);
const assess = (wallets, endpoint = { method_hold: "hold" }, b = bind()) => {
  const { action, reasons, cap } = decideMandate(wallets, endpoint);
  return buildAssessment({ bind: b, wallets, endpoint, action, reasons, cap });
};
const pay = (o = {}) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: {
  scheme: o.scheme ?? "exact", network: o.network ?? "solana",
  asset: "asset" in o ? o.asset : RAIL.asset, amount: o.amount ?? "50000", payTo: o.payTo ?? RAIL.payTo,
} })).toString("base64");
const WARN = [{ seller: RAIL.payTo, decision: "warn", cap: 0.05 }];
const BLOCK = [{ seller: RAIL.payTo, decision: "block", cap: null }];
const UNAVAIL = [{ seller: RAIL.payTo, decision: "unavailable", cap: null }];

const covers = (a, o) => assessmentCoversAccepted(a, acceptedFromPayment(pay(o)));
const payOutcome = (a, o) => (covers(a, o)
  ? { outcome: "authorized" }
  : { outcome: "refused", error: "TwzrdChallengeChangedError", paid: false });

const A = assess(WARN);
const actual = {
  unchanged_terms:      payOutcome(A, {}),
  changed_recipient:    payOutcome(A, { payTo: OTHER }),
  changed_amount:       payOutcome(A, { amount: "5000000" }),
  asset_omitted:        payOutcome(A, { asset: "" }),
  scheme_changed:       payOutcome(A, { scheme: "upto" }),
  challenge_reissued:   (() => { const ok = assessmentAuthorizes(A, bind([{ ...RAIL, payTo: OTHER }])); return { outcome: ok ? "authorized" : "refused", authorizes: ok }; })(),
  wallet_block:         (() => { const d = decideMandate(BLOCK, { method_hold: "hold" }); return { outcome: d.action, reasons: d.reasons }; })(),
  wallet_warn_caps:     (() => { const d = decideMandate(WARN, { method_hold: "hold" }); return { outcome: d.action, cap: d.cap, reasons: d.reasons }; })(),
  evidence_unavailable: (() => { const a = assess(UNAVAIL); return { outcome: a.decided.action, reasons: a.decided.reasons, missing: a.observed.missing }; })(),
  head_200_inspect:     (() => { const d = decideMandate([], { method_hold: "head_200" }); return { outcome: d.action, reasons: d.reasons }; })(),
  delivery_unverified:  { delivery_proof: A.observed.delivery_proof, delivered: A.delivered },
  // Recovery: the next action the mandate permits, from failures that already exist.
  recover_challenge_changed:    nextFromError("TwzrdChallengeChangedError"),
  recover_settlement_uncertain: nextFromError("pay_uncertain"),
  recover_login_wall:           checkBrowseExpectation({ reason: "needs_login" }).next,
  recover_bot_gate:             checkBrowseExpectation({ reason: "needs_bot" }).next,
  recover_needs_browser:        checkBrowseExpectation({ reason: "needs_browser" }).next,
  recover_wallet_block:         nextFromError("TwzrdPolicyAbortError"),
  recover_paid_body_short:      checkBrowseExpectation({ ok: true, word_count: 2 }).next,
  recover_paid_body_ok:         checkBrowseExpectation({ ok: true, word_count: 500 }).next,
  recover_unclassified:         nextFromError("totally_unknown"),
};

const subset = (exp, act) => Object.entries(exp).every(([k, v]) =>
  Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(act?.[k]) : v === act?.[k]);

const results = SPEC.cases.map((c) => {
  const got = actual[c.id];
  return { id: c.id, what: c.what, expected: c.expect, actual: got, match: subset(c.expect, got) };
});
const failed = results.filter((r) => !r.match);

// A later paid check may attach delivery evidence without rewriting the decision.
const delivered = recordDelivered(A, { established: "content_hash_match" });
const recordIntact = delivered.observed.at === A.observed.at
  && JSON.stringify(delivered.decided) === JSON.stringify(A.decided)
  && delivered.delivered !== null;

const out = {
  fixture: true, suite: SPEC.suite, assessment_version: ASSESSMENT_VERSION,
  funds_required: false, network_required: false,
  cases: results.length, matched: results.length - failed.length, failed: failed.map((f) => f.id),
  delivery_record_immutable: recordIntact,
  results,
  limitations: [
    "Fixture evidence is stubbed: this proves the control enforces, not that any seller is safe.",
    "No delivery is verified here or anywhere; delivery_proof stays 'unverified' until a paid check establishes it.",
    "A passing run is integration success, not external payment validation.",
  ],
};
console.log(JSON.stringify(out, null, 1));
process.exit(failed.length || !recordIntact ? 1 : 0);
