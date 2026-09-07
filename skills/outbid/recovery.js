// Structured recovery: turn what already happened into the one next action the
// mandate permits, with unknowns named rather than guessed.
//
// This adds no behaviour. Every input below is produced today by smart-fetch;
// this maps them into a small closed vocabulary an agent can branch on without
// parsing prose, and refuses to invent a next step it cannot justify.
import { PREFLIGHT_TTL_MS } from "./smart-fetch.js";

// Closed set. Adding a member is a breaking change for consumers.
export const NEXT = {
  DO_NOT_PAY: "do_not_pay",                   // authority refuses; only the mandate owner can change this
  REASSESS: "reassess",                        // get a fresh assessment for the current challenge, then decide
  REFRESH_EVIDENCE: "refresh_evidence",        // assessment still binds, its evidence is stale
  RECONCILE_SETTLEMENT: "reconcile_settlement",// money may have moved; establish that before paying anything
  WAIT_AND_RETRY: "wait_and_retry",            // transient; same terms are still valid
  STOP_ATTEMPT: "stop_attempt",                // this path cannot succeed; try another route or ask for authority
  ABORT: "abort",                              // terminal for this task step
  VERIFY_DELIVERY: "verify_delivery",          // paid and returned; delivery is not established
};

export const EVIDENCE_TTL_MS = PREFLIGHT_TTL_MS;

const rec = (o) => ({
  reason: o.reason, stage: o.stage ?? null,
  paid: o.paid ?? "no",                 // no | maybe | yes
  settlement: o.settlement ?? "none",   // none | uncertain | settled
  next: o.next,
  retry_same_terms: o.retry_same_terms ?? false,
  needs_authority: o.needs_authority ?? false,
  unknown: o.unknown ?? [],
  detail: o.detail ?? null,
});

function fromError(err) {
  const stage = err?.stage ?? null;
  const cls = err?.errorClass ?? err?.name ?? "unknown";
  switch (cls) {
    case "TwzrdPolicyAbortError":
      return rec({ reason: "refused_by_assessment", stage, next: NEXT.DO_NOT_PAY, needs_authority: true,
        detail: err?.twzrd?.decided ?? null });
    case "TwzrdWashAbortError":
      return rec({ reason: "refused_counterparty", stage, next: NEXT.DO_NOT_PAY, needs_authority: true });
    case "TwzrdChallengeChangedError":
      // Nothing was sent: the refusal happens before the request leaves.
      return rec({ reason: "challenge_changed", stage, next: NEXT.REASSESS,
        detail: err?.twzrd ? { assessed: err.twzrd.previous?.challenge ?? null, presented: err.twzrd.next ?? null } : null });
    case "cooldown":
      return rec({ reason: "origin_cooldown", stage, next: NEXT.WAIT_AND_RETRY, retry_same_terms: true });
    case "pay_uncertain":
      // The payer sent a signed payment and never got a usable answer.
      return rec({ reason: "settlement_uncertain", stage, paid: "maybe", settlement: "uncertain",
        next: NEXT.RECONCILE_SETTLEMENT, unknown: ["settlement_state"] });
    case "pay_fail":
      return stage === "route"
        ? rec({ reason: "route_payment_rejected", stage, next: NEXT.ABORT })
        : rec({ reason: "payment_rejected", stage, next: NEXT.REASSESS, detail: { status: err?.status ?? null } });
    case "route_fail":
      return rec({ reason: "fallback_unavailable", stage, paid: "maybe", settlement: "uncertain",
        next: NEXT.ABORT, unknown: ["settlement_state"] });
    case "fallback_fail":
      return rec({ reason: "fallback_failed_after_payment", stage, paid: "yes", settlement: "settled", next: NEXT.ABORT });
    default:
      return rec({ reason: "unclassified", stage, next: NEXT.ABORT, unknown: ["failure_class"], detail: { class: cls } });
  }
}

function fromResponse(res, body) {
  const reason = body?.reason;
  if (res.status === 422 && reason === "needs_login") {
    // Authentication is not something a spending mandate can grant itself.
    return rec({ reason: "login_wall", next: NEXT.STOP_ATTEMPT, needs_authority: true });
  }
  if (res.status === 422 && reason === "needs_bot") {
    return rec({ reason: "origin_challenge", next: NEXT.STOP_ATTEMPT });
  }
  if (res.status === 422 && reason === "needs_browser") {
    return rec({ reason: "needs_rendered_fetch", next: NEXT.REASSESS, detail: { opt_in: "{ browser: true }" } });
  }
  if (res.status === 429) return rec({ reason: "origin_rate_limited", next: NEXT.WAIT_AND_RETRY, retry_same_terms: true });
  if (res.ok) {
    return rec({ reason: "returned_delivery_unverified", paid: "yes", settlement: "settled",
      next: NEXT.VERIFY_DELIVERY, unknown: ["delivery"] });
  }
  return rec({ reason: "origin_error", next: NEXT.ABORT, detail: { status: res.status } });
}

// mandate: { remaining_usdc, per_call_cap_usdc } — the operator's authority, not ours.
function applyMandate(r, mandate) {
  if (!mandate) return { ...r, allowance: null, unknown: [...r.unknown, "mandate_not_supplied"] };
  const remaining = Number(mandate.remaining_usdc);
  const allowance = { remaining_usdc: mandate.remaining_usdc ?? null, per_call_cap_usdc: mandate.per_call_cap_usdc ?? null };
  const spends = [NEXT.REASSESS, NEXT.WAIT_AND_RETRY, NEXT.REFRESH_EVIDENCE].includes(r.next);
  if (spends && Number.isFinite(remaining) && remaining <= 0) {
    return { ...r, allowance, next: NEXT.DO_NOT_PAY, needs_authority: true, reason: `${r.reason}_no_allowance` };
  }
  return { ...r, allowance };
}

/**
 * @param outcome  a thrown error from smartFetch, or { res, body } for a returned Response
 * @param opts     { assessment, mandate, now }
 */
export function recovery(outcome, { assessment, mandate, now = Date.now() } = {}) {
  let r = outcome instanceof Error
    ? fromError(outcome)
    : fromResponse(outcome?.res ?? outcome, outcome?.body);

  // Stale evidence only matters where the next step would otherwise spend.
  if (assessment?.observed?.at && (now - assessment.observed.at) > EVIDENCE_TTL_MS) {
    const age_ms = now - assessment.observed.at;
    if (r.next === NEXT.WAIT_AND_RETRY) r = { ...r, next: NEXT.REFRESH_EVIDENCE, retry_same_terms: false };
    r = { ...r, evidence_age_ms: age_ms, evidence_stale: true };
  } else if (assessment?.observed?.at) {
    r = { ...r, evidence_age_ms: now - assessment.observed.at, evidence_stale: false };
  }
  return applyMandate(r, mandate);
}
