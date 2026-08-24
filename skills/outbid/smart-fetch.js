// smartFetch(url, options, wallet) over @x402/fetch.
// 1. Origin native 402 → pay the origin.
// 2. After origin text/html 200: fat HTML (> FAT_HTML_BYTES) or {markdown:true}
//    → GET https://reader.outbid.sh/scrape?url= ($0.005). 200 is JSON
//    {ok,title,content,markdown,word_count}, not origin HTML.
//    JS wall still spends; return 422 only if wantMd, else keep origin HTML.
//    Reader/size throw: keep origin. Do not fall into /route.
// 3. Origin dead / timeout → peek /top (free), paid GET /route
//    Accept application/json → {url, forward_headers}. Copy headers. No 302.
// Reachable origin 404/5xx is returned, not hopped (that would be /route on a diet).
export const FAT_HTML_BYTES = 32 * 1024;

function cancel(r) { try { r.body?.cancel?.(); } catch { /* undici */ } }

export async function smartFetch(url, options = {}, wallet) {
  const { markdown: wantMd = false, reader, paid, ...rest } = options;
  const base = reader || process.env.X402_READER_URL || "https://reader.outbid.sh/scrape";
  const x = paid || (await import("@x402/fetch")).wrapFetchWithPayment(fetch, wallet);
  try {
    const r = await x(url, rest);
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.includes("text/html")) {
      try {
        const n = Number(r.headers.get("content-length"));
        const bytes = n > 0 ? n : (await r.clone().arrayBuffer()).byteLength;
        if (wantMd || bytes > FAT_HTML_BYTES) {
          const s = await x(`${base}?url=${encodeURIComponent(String(url))}`);
          if (s.ok || (s.status === 422 && wantMd)) { cancel(r); return s; }
        }
      } catch { /* reader/size hop failed; origin is alive */ }
    }
    return r;
  } catch {
    try { await fetch("https://outbid.sh/top"); } catch { /* peek is free */ }
    const n = await x("https://outbid.sh/route", { headers: { accept: "application/json" } });
    const j = await n.json();
    if (typeof j?.url !== "string") throw new Error("outbid /route missing url");
    return x(j.url, { ...rest, headers: { ...rest.headers, ...(j.forward_headers || {}) } });
  }
}

export function paidFetch(client, reader, paid) {
  return (url, init = {}) => smartFetch(url, { ...init, reader, paid }, client);
}
