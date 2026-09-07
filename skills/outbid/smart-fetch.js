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
// Free pre-spend readiness on the seller a 402 names, before the payer signs.
// Opt in per call with { preflight: "twzrd" } or env X402_PREFLIGHT=twzrd.
// Never custody, never a payment path: one free POST, and block throws unpaid.
export const TWZRD_PREFLIGHT_URL = process.env.TWZRD_PREFLIGHT_URL || "https://intel.twzrd.xyz/v1/intel/preflight";
export const PREFLIGHT_TTL_MS = 5 * 60_000;
export const PREFLIGHT_TIMEOUT_MS = 4000;
export const verdicts = new Map();

const b64json = (raw) => { try { return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8")); } catch { return null; } };

// Both rails of one 402 are the same seller, so any advertised payTo that blocks
// blocks the hop. Over-refusing an unpaid hop is the safe direction.
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
  } catch { /* the CHECK is advisory and free: an unreachable gate never becomes a block */ }
  verdicts.set(seller, v);
  bump(`preflight_${v.decision === "unavailable" ? "unavailable" : v.decision}`);
  return v;
}

// Reuses the name the payer catch already treats as terminal: no /route, no retry.
export function policyAbort(v) {
  const e = new Error(`twzrd preflight decision=block seller=${v.seller}`);
  e.name = "TwzrdPolicyAbortError";
  e.twzrd = v;
  return e;
}

export async function gate402(res, seen, check = twzrdCheck) {
  const header = res.headers.get("payment-required");
  let body = null;
  if (!header) { try { body = await res.clone().json(); } catch { /* not a JSON invoice */ } }
  const blocked = [];
  for (const { seller, price } of sellersFromInvoice(body, header)) {
    const v = await check(seller, price);
    seen.push(v);
    if (v.decision === "block") blocked.push(v);
  }
  if (blocked.length) throw policyAbort(blocked[0]);
}

export class SmartFetchError extends Error {
  constructor(message, info) { super(message); this.name = "SmartFetchError"; Object.assign(this, info); }
}
function fail(stage, errorClass, extra = {}) {
  throw new SmartFetchError(extra.message || errorClass, {
    stage, errorClass, status: extra.status, paymentAttempted: !!extra.paymentAttempted, retryable: extra.retryable === true,
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
  if (r && seen.length) { try { Object.defineProperty(r, "twzrd", { value: seen.slice(), enumerable: false }); } catch { /* frozen */ } }
  return r;
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
    const h = new Request(input, init).headers;
    const paying = h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT");
    if (paying) payAttempted = true;
    const res = await fetch(input, init);
    // The unpaid 402 is the only place the seller is known and nothing is spent yet.
    if (checking && !paying && res.status === 402) await gate402(res, seen);
    return res;
  };
  const x = paid || (await import("@x402/fetch")).wrapFetchWithPayment(inner, wallet);
  let r;
  try { r = await x(url, rest); }
  catch (err) {
    const m = String(err?.message || err);
    if (err?.name === "TwzrdPolicyAbortError" || err?.name === "TwzrdWashAbortError") {
      fail("policy", err.name, { paymentAttempted: false, retryable: false, message: m });
    }
    if (PAY_MSG.test(m) || payAttempted) {
      bump("payment_authorization_failed");
      fail("origin", payAttempted && !PAY_MSG.test(m) ? "pay_uncertain" : "pay_fail", { paymentAttempted: true, retryable: false, message: m });
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
        if (s.ok || s.status === 422) { if (s.ok) bump("browse_paid"); cancel(r); return s; }
        cancel(s);
      } else {
        const n = Number(r.headers.get("content-length"));
        const bytes = n > 0 ? n : (await r.clone().arrayBuffer()).byteLength;
        if (wantMd || bytes > FAT_HTML_BYTES) {
          let s; try { s = await x(`${base}?${q}`); } catch { return r; }
          if (s.ok || (s.status === 422 && wantMd)) { bump("reader_paid"); cancel(r); return s; }
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
