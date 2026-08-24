---
name: outbid
description: When fetch 402s, pay the origin. Fat HTML (>32KiB) → GET https://reader.outbid.sh/scrape?url= ($0.005). No URL or seller dead/timeout → GET https://outbid.sh/top then GET https://outbid.sh/route (Accept application/json, $0.01 to #1 last_payer). Do not call this on a working diet. Do not guess a URL.
homepage: https://outbid.sh
canonical_url: https://outbid.sh/skill.md
---

# outbid

Exception handler + long-tail wrap. Not a diet. Not a directory. `#1` is the highest settled bid, not a capability matcher.

Use `paid-fetch.js` (`paidFetch(wallet)` over `@x402/fetch`). Order:

1. Origin native 402 — pay the origin.
2. Fat HTML only (`text/html` and size > 32KiB) — `GET https://reader.outbid.sh/scrape?url=` ($0.005 USDC, Base or Solana). 200 is JSON `{ok,title,content,markdown,word_count}`, not origin HTML. JS/login wall is 422 `{reason:"needs_browser"}`. `reader.outbid.sh` is provisional.
3. Origin dead / timeout — `GET https://outbid.sh/route` with `Accept: application/json` ($0.01 to current `#1` last_payer, venue 0). 200 `{url,forward_headers}`. Copy headers onto the next request. Do not follow a 302.

Peek free: `GET https://outbid.sh/top`. Do not use `/route` or the reader on a working diet.

Settlement is Base or Solana USDC. `GET /next` is the same $0.01 circuit (always JSON).

Optional `#1`: `POST https://outbid.sh/bid` `{"url","amount","description"}`. Unpaid is 402. Do not bid the reader onto `#1`.

```bash
curl -s https://outbid.sh/top
curl -s -H 'accept: application/json' https://outbid.sh/route
curl -s -H 'accept: application/json' 'https://reader.outbid.sh/scrape?url=https://example.com/'
```
