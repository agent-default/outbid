// Origin native 402 → pay it.
// Fat HTML only (> FAT_HTML_BYTES) → GET https://reader.outbid.sh/scrape?url= ($0.005).
// Reader 200 is JSON {ok,title,content,markdown,word_count}, not the origin Response.
// Dead/timeout → paid GET https://outbid.sh/route Accept application/json
//   → {url, forward_headers} (sendRoute). Copy headers. Do not follow 302.
export const FAT_HTML_BYTES = 32 * 1024;

export function paidFetch(client, reader, paid) {
  const base = reader || process.env.X402_READER_URL || "https://reader.outbid.sh/scrape";
  return async (url, init = {}) => {
    const x = paid || (await import("@x402/fetch")).wrapFetchWithPayment(fetch, client);
    try {
      const r = await x(url, init);
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.includes("text/html")) {
        const n = Number(r.headers.get("content-length"));
        const bytes = n > 0 ? n : (await r.clone().arrayBuffer()).byteLength;
        if (bytes > FAT_HTML_BYTES) {
          const s = await x(`${base}?url=${encodeURIComponent(String(url))}`);
          if (s.ok) return s;
        }
      }
      return r;
    } catch {
      const n = await x("https://outbid.sh/route", { headers: { accept: "application/json" } });
      const j = await n.json();
      if (typeof j?.url !== "string") throw new Error("outbid /route missing url");
      return x(j.url, { ...init, headers: { ...init.headers, ...(j.forward_headers || {}) } });
    }
  };
}
