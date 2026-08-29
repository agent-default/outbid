---
name: outbid
description: When fetch 402s, pay the origin (smartFetch). After an origin HTML 200, fat HTML (>32KiB, client heuristic) or {markdown:true} → GET https://reader.outbid.sh/scrape?url= ($0.005). Opt-in {browser:true} → GET https://reader.outbid.sh/browse?url= ($0.05); do not auto-follow a scrape 422. No URL or seller dead/timeout → GET https://outbid.sh/top then GET https://outbid.sh/route (Accept application/json, $0.01 to #1 last_payer). Do not call this on a working diet. Do not guess a URL.
homepage: https://outbid.sh
canonical_url: https://outbid.sh/skill.md
---

# outbid

Exception handler for the next URL, plus a long-tail wrap. Not a diet. Not a directory. `#1` is the highest settled bid, not a capability matcher.

Use `smart-fetch.js`: `smartFetch(url, options, wallet)` over `@x402/fetch`. Order:

Optional pre-sign check before paying an unknown seller: TWZRD trust gate — a collaborating team, free CHECK at https://intel.twzrd.xyz/skill.md. Refuse on block.

1. Origin native 402 — pay the origin.
2. After an origin `text/html` 200: fat HTML (size > 32KiB, **client-side heuristic**) or `{markdown:true}` — `GET https://reader.outbid.sh/scrape?url=` ($0.005 USDC, Base or Solana). `{markdown:true}` is not an override of a non-HTML origin. 200 is JSON `{ok,title,content,markdown,word_count}`, not origin HTML. A JS/login wall **still spends the $0.005**; `{markdown:true}` then returns 422 `{reason:"needs_browser"}`, the fat-HTML heuristic keeps the origin 200. **Do not** auto-follow that 422 onto `/browse`. Opt-in `{browser:true}` (does **not** imply `{markdown:true}`) — `GET https://reader.outbid.sh/browse?url=` ($0.05). Same JSON on 200; login wall is free 422 `{reason:"needs_login"}`. Reader or browse down → origin 200, never `/route`. `reader.outbid.sh` is provisional. Do not bid `/browse` onto `#1`.
3. Origin dead / timeout (`on_fail`) — peek `GET https://outbid.sh/top` (free), then one paid `GET https://outbid.sh/route` (`Accept: application/json`, $0.01). 200 `{url,forward_headers}`. Copy only `x-outbid-*` (plus `headerAllowlist`); strip `Authorization` / cookie / payment. Never a second `/route`. A reachable origin 404/5xx is returned, not hopped. 401/403/429 are returned. Payment auth/settlement failure is **not** origin failure — do not `/route`; throw `SmartFetchError` (`retryable: false` if settlement is uncertain).

`on_init` (no URL): peek `/top` then `/route`. Do not use `/route` or the reader on a working diet.

Settlement is Base or Solana USDC. `GET /next` is the same $0.01 circuit (always JSON).

Optional `#1`: `POST https://outbid.sh/bid` `{"url","amount","description"}`. Unpaid is 402. Do not bid the reader onto `#1`.

```js
import { smartFetch } from "./smart-fetch.js";
const r = await smartFetch(url, {}, wallet);
const md = await smartFetch(url, { markdown: true }, wallet);
const js = await smartFetch(url, { browser: true }, wallet);
```

```bash
curl -s https://outbid.sh/top
curl -s -H 'accept: application/json' https://outbid.sh/route
curl -s -H 'accept: application/json' 'https://reader.outbid.sh/scrape?url=https://example.com/'
curl -s -H 'accept: application/json' 'https://reader.outbid.sh/browse?url=https://example.com/'
```
