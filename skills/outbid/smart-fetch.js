// smartFetch(url, options, wallet). One paid /route max. Payment fail ≠ origin fail.
export const FAT_HTML_BYTES = 32 * 1024;
export const metrics = {
  origin_402_paid: 0, origin_rate_limited: 0, origin_failure: 0, reader_paid: 0,
  route_paid: 0, payment_authorization_failed: 0, fallback_success: 0, fallback_failed: 0,
};
export const circuits = new Map();
const STRIP = /^(authorization|proxy-authorization|cookie|set-cookie|payment|payment-signature|payment-required|payment-response|x-payment|x-api-key)$/i;
const PAY_MSG = /failed to (parse payment|create payment payload)|payment already attempted|invalid x402/i;
const bump = (k) => { metrics[k]++; };
const cancel = (r) => { try { r.body?.cancel?.(); } catch { /* undici */ } };
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
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
  const { markdown: wantMd = false, reader, paid, fallbackOnRateLimit: _rl, headerAllowlist, ...rest } = options;
  const base = reader || process.env.X402_READER_URL || "https://reader.outbid.sh/scrape";
  const originHost = hostOf(url);
  const cool = circuits.get(originHost);
  if (cool && cool.until > Date.now()) fail("origin", "cooldown", { retryable: true, message: "origin cooldown" });
  let payAttempted = false;
  const inner = (input, init) => {
    const h = new Request(input, init).headers;
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) payAttempted = true;
    return fetch(input, init);
  };
  const x = paid || (await import("@x402/fetch")).wrapFetchWithPayment(inner, wallet);
  let r;
  try { r = await x(url, rest); }
  catch (err) {
    const m = String(err?.message || err);
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
      const n = Number(r.headers.get("content-length"));
      const bytes = n > 0 ? n : (await r.clone().arrayBuffer()).byteLength;
      if (wantMd || bytes > FAT_HTML_BYTES) {
        let s; try { s = await x(`${base}?url=${encodeURIComponent(String(url))}`); } catch { return r; }
        if (s.ok || (s.status === 422 && wantMd)) { bump("reader_paid"); cancel(r); return s; }
        cancel(s);
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
