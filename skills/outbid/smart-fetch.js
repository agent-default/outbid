// smartFetch(url, options, wallet). One paid /route max. Payment fail ≠ origin fail.
export const FAT_HTML_BYTES = 32 * 1024;
export const metrics = {
  origin_402_paid: 0, origin_rate_limited: 0, origin_failure: 0, reader_paid: 0, browse_paid: 0,
  route_paid: 0, payment_authorization_failed: 0, fallback_success: 0, fallback_failed: 0,
  preflight_allow: 0, preflight_warn: 0, preflight_block: 0, preflight_unavailable: 0,
};
export const circuits = new Map();
const STRIP = /^(authorization|proxy-authorization|cookie|set-cookie|payment|payment-signature|payment-required|payment-response|x-payment|x-api-key)$/i;
const PAY_MSG = /failed to (parse payment|create payment payload)|payment already attempted|invalid x402/i;
const bump = (k) => { metrics[k]++; };
const cancel = (r) => { try { r.body?.cancel?.(); } catch { /* undici */ } };
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
export function browseFromScrape(scrapeBase) {
  try {
    const u = new URL(scrapeBase);
    u.search = "";
    u.pathname = `${u.pathname.replace(/\/scrape\/?$/, "")}/browse`;
    return u.toString().replace(/\/$/, "");
  } catch {
    return "https://reader.outbid.sh/browse";
  }
}
// --- TWZRD CHECK (optional, default off) -------------------------------------
// Free pre-spend readiness before the payer signs. Opt in per call with
// { preflight: "twzrd" } or env X402_PREFLIGHT=twzrd. Never custody.
// Assessment v1 is challenge-bound: wallet + endpoint observations, a mandate
// decision, and delivered=null until a later paid check. If the accepted
// challenge changes, the previous assessment cannot authorize it.
export const TWZRD_PREFLIGHT_URL = process.env.TWZRD_PREFLIGHT_URL || "https://intel.twzrd.xyz/v1/intel/preflight";
export const PREFLIGHT_TTL_MS = 5 * 60_000;
export const PREFLIGHT_TIMEOUT_MS = 4000;
export const ASSESSMENT_VERSION = 1;
export const verdicts = new Map();

const b64json = (raw) => { try { return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8")); } catch { return null; } };

export function normNetwork(n) {
  const s = String(n || "");
  if (s === "base" || s === "eip155:8453") return "eip155:8453";
  if (s === "solana" || s === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  return s;
}

export function challengeBind(url, method, accepts) {
  const rails = [];
  for (const a of accepts || []) {
    if (!a?.payTo) continue;
    rails.push({
      payTo: String(a.payTo),
      network: normNetwork(a.network),
      asset: String(a.asset || ""),
      amount: String(a.maxAmountRequired ?? a.amount ?? ""),
      scheme: String(a.scheme || "exact"),
    });
  }
  rails.sort((a, b) => `${a.network}:${a.payTo}`.localeCompare(`${b.network}:${b.payTo}`));
  return { url: String(url || ""), method: String(method || "GET").toUpperCase(), rails };
}

export function challengeFingerprint(bind) {
  return JSON.stringify({ url: bind.url, method: bind.method, rails: bind.rails });
}

export function assessmentAuthorizes(assessment, bind) {
  return !!assessment && assessment.version === ASSESSMENT_VERSION
    && challengeFingerprint(assessment.challenge) === challengeFingerprint(bind);
}

export function acceptedFromPayment(raw) {
  const p = b64json(raw);
  if (!p) return null;
  const a = p.accepted || p;
  if (!a?.payTo) return null;
  return {
    payTo: String(a.payTo),
    network: normNetwork(a.network),
    asset: String(a.asset || ""),
    amount: String(a.amount ?? a.maxAmountRequired ?? ""),
    scheme: String(a.scheme || "exact"),
  };
}

export function assessmentCoversAccepted(assessment, accepted) {
  if (!assessment || assessment.version !== ASSESSMENT_VERSION || !accepted?.payTo) return false;
  return (assessment.challenge.rails || []).some((r) => (
    r.payTo === accepted.payTo
    && r.network === accepted.network
    && r.amount === accepted.amount
    // Fail closed on asset: an assessed rail names an asset, so a payment that
    // omits the field is not covered by it. Treating a missing asset as a match
    // let a payment drop the field and slip a bound term.
    && (r.asset ? r.asset === accepted.asset : true)
    && r.scheme === accepted.scheme
  ));
}

export function sellersFromInvoice(body, header) {
  const accepts = (b64json(header)?.accepts) || body?.accepts || [];
  const out = [];
  for (const a of accepts) {
    if (!a?.payTo) continue;
    const atomic = Number(a.maxAmountRequired ?? a.amount ?? 0);
    out.push({ seller: String(a.payTo), price: Number.isFinite(atomic) && atomic > 0 ? atomic / 1e6 : 0 });
  }
  return out;
}

export async function twzrdCheck(seller, price, { url = TWZRD_PREFLIGHT_URL, now = Date.now() } = {}) {
  const hit = verdicts.get(seller);
  if (hit && now - hit.at < PREFLIGHT_TTL_MS) return hit;
  let v = { seller, decision: "unavailable", cap: null, at: now };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seller_wallet: seller, price_usdc: price, agent_intent: "preflight" }),
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    const card = r.ok ? (await r.json())?.readiness_card : null;
    const d = card?.decision;
    if (d === "allow" || d === "warn" || d === "block") {
      v = { seller, decision: d, cap: card.recommended_cap_usdc ?? null, at: now };
    }
  } catch { /* unreachable gate never becomes a block */ }
  verdicts.set(seller, v);
  bump(`preflight_${v.decision === "unavailable" ? "unavailable" : v.decision}`);
  return v;
}

export async function observeMethodHold(url, { fetchImpl = fetch, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return { method_hold: "unobserved" };
  try {
    const r = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 402) return { method_hold: "hold", status: 402 };
    if (r.status === 200) return { method_hold: "head_200", status: 200 };
    return { method_hold: "other", status: r.status };
  } catch {
    return { method_hold: "unobserved" };
  }
}

export const NEXT = {
  proceed: { action: "proceed", retry_payment: false, human: false },
  refresh_assessment: { action: "refresh_assessment", retry_payment: false, human: false },
  reassess: { action: "reassess", retry_payment: false, human: false },
  stop_auth_required: { action: "stop_auth_required", retry_payment: false, human: false },
  reconcile_settlement: { action: "reconcile_settlement", retry_payment: false, human: false },
  record_failed_delivery: { action: "record_failed_delivery", retry_payment: "only_if_mandate_allows", human: false },
  escalate: { action: "escalate", retry_payment: false, human: "missing_authority" },
};
const WALL_REASONS = new Set(["needs_login", "needs_bot", "needs_browser"]);

export function nextFor(kind) {
  const n = NEXT[kind];
  if (!n) throw new Error(`unknown next kind: ${kind}`);
  return { action: n.action, retry_payment: n.retry_payment, human: n.human };
}

export function nextForAssessment(assessment, { now = Date.now(), wallReason, payUncertain, deliveryFailed } = {}) {
  if (payUncertain) return nextFor("reconcile_settlement");
  if (WALL_REASONS.has(wallReason)) return nextFor("stop_auth_required");
  if (deliveryFailed) return nextFor("record_failed_delivery");
  if (assessment?.decided?.action === "refuse") return nextFor("escalate");
  if (assessment?.observed?.at && now - assessment.observed.at > PREFLIGHT_TTL_MS) return nextFor("refresh_assessment");
  return nextFor("proceed");
}

export function nextFromError(errorClass, extra = {}) {
  if (errorClass === "pay_uncertain") return nextFor("reconcile_settlement");
  if (errorClass === "TwzrdChallengeChangedError") return nextFor("reassess");
  if (errorClass === "TwzrdPolicyAbortError" || errorClass === "TwzrdWashAbortError") return nextFor("escalate");
  if (extra.wallReason) return nextFor("stop_auth_required");
  return extra.retryable === true ? nextFor("proceed") : nextFor("proceed");
}

export function decideMandate(wallets, endpoint) {
  const reasons = [];
  if ((wallets || []).some((v) => v.decision === "block")) {
    return { action: "refuse", reasons: ["wallet_block"], cap: null };
  }
  if (endpoint?.method_hold === "head_200") reasons.push("head_200_inspect");
  const warn = (wallets || []).filter((v) => v.decision === "warn");
  if (warn.length) {
    const caps = warn.map((v) => Number(v.cap)).filter((n) => Number.isFinite(n));
    return { action: "cap", reasons: ["wallet_warn", ...reasons], cap: caps.length ? Math.min(...caps) : null };
  }
  if ((wallets || []).length && (wallets || []).every((v) => v.decision === "unavailable")) {
    return { action: "proceed", reasons: ["wallet_unavailable", ...reasons], cap: null };
  }
  return { action: "proceed", reasons: reasons.length ? reasons : ["wallet_no_block"], cap: null };
}

export function buildAssessment({ bind, wallets, endpoint, now = Date.now(), action, reasons, cap }) {
  const missing = ["delivery_proof"];
  if (!(wallets || []).length || (wallets || []).every((v) => v.decision === "unavailable")) missing.push("wallet_verdict");
  if (!endpoint || endpoint.method_hold === "unobserved") missing.push("method_hold");
  const assessment = {
    version: ASSESSMENT_VERSION,
    challenge: bind,
    observed: {
      at: now,
      wallet: wallets || [],
      endpoint: endpoint || { method_hold: "unobserved" },
      delivery_proof: "unverified",
      missing,
    },
    decided: { at: now, action, reasons: reasons || [], cap: cap ?? null },
    delivered: null,
  };
  assessment.next = nextForAssessment(assessment, { now });
  return assessment;
}

// A later paid check may attach delivery evidence. It must not rewrite observed or decided.
export function recordDelivered(assessment, established, now = Date.now()) {
  return { ...assessment, delivered: { at: now, ...(established || {}) } };
}

export function policyAbort(assessment) {
  const next = nextFor("escalate");
  if (assessment && !assessment.next) assessment.next = next;
  const e = new Error(`twzrd preflight decision=refuse`);
  e.name = "TwzrdPolicyAbortError";
  e.twzrd = assessment;
  e.next = next;
  return e;
}

export function challengeChanged(previous, nextChallenge) {
  const next = nextFor("reassess");
  const e = new Error("twzrd assessment does not authorize this challenge");
  e.name = "TwzrdChallengeChangedError";
  e.twzrd = { previous, next: nextChallenge };
  e.next = next;
  return e;
}

// Sit on x402 onBeforePaymentCreation / PayAI beforePayment. Abort only; never mutate terms.
export function beforePayment(selectedRequirements, assessment, { now = Date.now() } = {}) {
  if (!assessment) return { abort: true, reason: "no assessment", next: nextFor("refresh_assessment") };
  const stale = nextForAssessment(assessment, { now });
  if (stale.action === "refresh_assessment") {
    return { abort: true, reason: "assessment stale", next: stale };
  }
  if (assessment.decided?.action === "refuse") {
    return { abort: true, reason: "mandate refuse", next: nextFor("escalate") };
  }
  const accepted = {
    payTo: selectedRequirements?.payTo,
    network: normNetwork(selectedRequirements?.network),
    asset: String(selectedRequirements?.asset || ""),
    amount: String(selectedRequirements?.amount ?? selectedRequirements?.maxAmountRequired ?? ""),
    scheme: String(selectedRequirements?.scheme || "exact"),
  };
  if (!assessmentCoversAccepted(assessment, accepted)) {
    return { abort: true, reason: "challenge changed", next: nextFor("reassess") };
  }
}

export function checkBrowseExpectation(body, { minWords = 10 } = {}) {
  const reason = body?.reason;
  if (WALL_REASONS.has(reason)) {
    return { met: false, kind: "wall", reason, next: nextFor("stop_auth_required") };
  }
  const words = Number(body?.word_count);
  if (body?.ok === true && Number.isFinite(words) && words >= minWords) {
    return { met: true, kind: "output", word_count: words, next: nextFor("proceed") };
  }
  return { met: false, kind: "output", word_count: Number.isFinite(words) ? words : null, next: nextFor("record_failed_delivery") };
}

export function applyDeliveryCheck(assessment, body, opts) {
  const result = checkBrowseExpectation(body, opts);
  const out = recordDelivered(assessment, {
    met: result.met,
    kind: result.kind,
    reason: result.reason,
    word_count: result.word_count,
  });
  out.observed = assessment.observed;
  out.next = result.next;
  return out;
}

export async function gate402(res, seen, check = twzrdCheck, req = {}) {
  const header = res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
  let body = null;
  if (!header) { try { body = await res.clone().json(); } catch { /* not a JSON invoice */ } }
  const accepts = (b64json(header)?.accepts) || body?.accepts || [];
  const bind = challengeBind(req.url || "", req.method || "GET", accepts);
  const prev = [...seen].reverse().find((s) => s && s.version === ASSESSMENT_VERSION);
  if (prev && !assessmentAuthorizes(prev, bind)) throw challengeChanged(prev, bind);
  const wallets = [];
  for (const { seller, price } of sellersFromInvoice(body, header)) {
    wallets.push(await check(seller, price));
  }
  const endpoint = req.skipHead
    ? { method_hold: "unobserved" }
    : await observeMethodHold(bind.url, { fetchImpl: req.fetchImpl || fetch });
  const { action, reasons, cap } = decideMandate(wallets, endpoint);
  const assessment = buildAssessment({ bind, wallets, endpoint, action, reasons, cap });
  seen.push(assessment);
  if (action === "refuse") throw policyAbort(assessment);
}

export function assertPaymentMatchesAssessment(seen, paymentRaw) {
  const last = [...seen].reverse().find((s) => s && s.version === ASSESSMENT_VERSION);
  const accepted = acceptedFromPayment(paymentRaw);
  if (!last || !accepted) return;
  if (!assessmentCoversAccepted(last, accepted)) throw challengeChanged(last, accepted);
}

export class SmartFetchError extends Error {
  constructor(message, info) { super(message); this.name = "SmartFetchError"; Object.assign(this, info); }
}
function fail(stage, errorClass, extra = {}) {
  const next = extra.next || nextFromError(errorClass, extra);
  throw new SmartFetchError(extra.message || errorClass, {
    stage, errorClass, status: extra.status, paymentAttempted: !!extra.paymentAttempted,
    retryable: extra.retryable === true,
    next,
  });
}
function trip(h, cls, ms) {
  const b = circuits.get(h) || { n: 0, until: 0, cls };
  b.n++; b.cls = cls;
  b.until = Date.now() + (ms ?? Math.min(8000, 250 * 2 ** Math.min(b.n - 1, 5))) + Math.floor(Math.random() * 250);
  circuits.set(h, b);
}
function mixHeaders(rest, forward, allow) {
  const out = new Headers(rest || undefined);
  for (const k of [...out.keys()]) if (STRIP.test(k)) out.delete(k);
  const extra = new Set((allow || []).map((x) => String(x).toLowerCase()));
  for (const [k, v] of Object.entries(forward || {})) {
    if (v == null || STRIP.test(k)) continue;
    if (k.toLowerCase().startsWith("x-outbid-") || extra.has(k.toLowerCase())) out.set(k, String(v));
  }
  return out;
}
export async function smartFetch(url, options = {}, wallet) {
  const seen = [];
  try {
    return tag(await runFetch(url, options, wallet, seen), seen);
  } catch (err) {
    if (err instanceof SmartFetchError && seen.length) err.twzrd = seen.slice();
    throw err;
  }
}

function tag(r, seen) {
  if (r && seen.length) {
    try { Object.defineProperty(r, "twzrd", { value: seen.slice(), enumerable: false }); } catch { /* frozen */ }
    const last = [...seen].reverse().find((s) => s && s.version === ASSESSMENT_VERSION);
    if (last?.next) {
      try { Object.defineProperty(r, "next", { value: last.next, enumerable: false }); } catch { /* frozen */ }
    }
  }
  return r;
}

async function tagWall(s) {
  let reason;
  try { reason = (await s.clone().json())?.reason; } catch { /* not json */ }
  const next = nextForAssessment(null, { wallReason: WALL_REASONS.has(reason) ? reason : "needs_browser" });
  try { Object.defineProperty(s, "next", { value: next, enumerable: false }); } catch { /* frozen */ }
  return s;
}

async function runFetch(url, options, wallet, seen) {
  const { markdown: wantMd = false, browser: wantBrowse = false, reader, browse, paid, preflight, fallbackOnRateLimit: _rl, headerAllowlist, ...rest } = options;
  // A caller-supplied `paid` fetch settles its own 402s out of reach of the hook.
  const checking = (preflight ?? process.env.X402_PREFLIGHT) === "twzrd" && !paid;
  const base = reader || process.env.X402_READER_URL || "https://reader.outbid.sh/scrape";
  const bbase = browse || process.env.X402_BROWSE_URL || browseFromScrape(base);
  const originHost = hostOf(url);
  const cool = circuits.get(originHost);
  if (cool && cool.until > Date.now()) fail("origin", "cooldown", { retryable: true, message: "origin cooldown" });
  let payAttempted = false;
  const inner = async (input, init) => {
    const req = new Request(input, init);
    const h = req.headers;
    const paying = h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT");
    if (paying) payAttempted = true;
    if (checking && paying) {
      assertPaymentMatchesAssessment(seen, h.get("PAYMENT-SIGNATURE") || h.get("X-PAYMENT"));
    }
    const res = await fetch(input, init);
    // The unpaid 402 is the only place the seller is known and nothing is spent yet.
    if (checking && !paying && res.status === 402) {
      await gate402(res, seen, twzrdCheck, { url: req.url, method: req.method });
    }
    return res;
  };
  const x = paid || (await import("@x402/fetch")).wrapFetchWithPayment(inner, wallet);
  let r;
  try { r = await x(url, rest); }
  catch (err) {
    const m = String(err?.message || err);
    if (err?.name === "TwzrdPolicyAbortError" || err?.name === "TwzrdWashAbortError" || err?.name === "TwzrdChallengeChangedError") {
      fail("policy", err.name, { paymentAttempted: false, retryable: false, message: m, next: err.next || nextFromError(err.name) });
    }
    if (PAY_MSG.test(m) || payAttempted) {
      bump("payment_authorization_failed");
      const cls = payAttempted && !PAY_MSG.test(m) ? "pay_uncertain" : "pay_fail";
      fail("origin", cls, { paymentAttempted: true, retryable: false, message: m, next: nextFromError(cls) });
    }
    bump("origin_failure"); trip(originHost, "origin_fail");
    return routeOnce(x, rest, headerAllowlist);
  }
  if (r.status === 402) {
    bump("payment_authorization_failed");
    fail("origin", "pay_fail", { status: 402, paymentAttempted: true, retryable: false });
  }
  if (payAttempted && r.ok) bump("origin_402_paid");
  if (r.ok) circuits.delete(originHost);
  if (r.status === 429) bump("origin_rate_limited");
  const ct = r.headers.get("content-type") || "";
  if (r.ok && ct.includes("text/html")) {
    try {
      const q = `url=${encodeURIComponent(String(url))}`;
      if (wantBrowse) {
        let s; try { s = await x(`${bbase}?${q}`); } catch { return r; }
        if (s.ok || s.status === 422) {
          if (s.ok) bump("browse_paid");
          cancel(r);
          if (s.status === 422) await tagWall(s);
          return s;
        }
        cancel(s);
      } else {
        const n = Number(r.headers.get("content-length"));
        const bytes = n > 0 ? n : (await r.clone().arrayBuffer()).byteLength;
        if (wantMd || bytes > FAT_HTML_BYTES) {
          let s; try { s = await x(`${base}?${q}`); } catch { return r; }
          if (s.ok || (s.status === 422 && wantMd)) {
            bump("reader_paid");
            cancel(r);
            if (s.status === 422) await tagWall(s);
            return s;
          }
          cancel(s);
        }
      }
    } catch { /* keep origin */ }
  }
  return r;
}

async function routeOnce(x, rest, allow) {
  try { await fetch("https://outbid.sh/top"); } catch { /* peek */ }
  let stage = "route";
  try {
    const n = await x("https://outbid.sh/route", { headers: { accept: "application/json" } });
    if (n.status === 402 || !n.ok) {
      bump(n.status === 402 ? "payment_authorization_failed" : "fallback_failed");
      fail("route", n.status === 402 ? "pay_fail" : "route_fail", { status: n.status, paymentAttempted: true, retryable: false });
    }
    bump("route_paid");
    const j = await n.json();
    if (typeof j?.url !== "string") {
      bump("fallback_failed"); fail("route", "route_fail", { paymentAttempted: true, retryable: false, message: "outbid /route missing url" });
    }
    stage = "fallback";
    const f = await x(j.url, { ...rest, headers: mixHeaders(rest.headers, j.forward_headers, allow) });
    bump(f.ok ? "fallback_success" : "fallback_failed");
    return f;
  } catch (err) {
    if (err instanceof SmartFetchError) throw err;
    const pay = PAY_MSG.test(String(err?.message));
    bump(pay ? "payment_authorization_failed" : "fallback_failed");
    fail(stage, pay ? "pay_fail" : (stage === "fallback" ? "fallback_fail" : "route_fail"), {
      paymentAttempted: true, retryable: false, message: String(err?.message || err),
    });
  }
}

export function paidFetch(client, reader, paid) {
  return (url, init = {}) => smartFetch(url, { ...init, reader, paid }, client);
}
