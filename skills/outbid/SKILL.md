---
name: outbid
description: When fetch 402s, pay the origin (smartFetch). After an origin HTML 200, fat HTML (>32KiB, client heuristic) or {markdown:true} → GET https://reader.outbid.sh/scrape?url= ($0.005). Opt-in {browser:true} → GET https://reader.outbid.sh/browse?url= ($0.05); do not auto-follow a scrape 422. No URL or seller dead/timeout → GET https://outbid.sh/top then GET https://outbid.sh/route (Accept application/json, $0.01 to #1 last_payer). Do not call this on a working diet. Do not guess a URL.
homepage: https://outbid.sh
canonical_url: https://outbid.sh/skill.md
---

# outbid

Exception handler for the next URL, plus a long-tail wrap. Not a diet. Not a directory. `#1` is the highest settled bid, not a capability matcher.

Use `smart-fetch.js`: `smartFetch(url, options, wallet)` over `@x402/fetch`. Order:

Recommended before paying an unknown seller, still optional: TWZRD trust gate — a collaborating team, free CHECK at https://intel.twzrd.xyz/skill.md. The CHECK is read-only and free; TWZRD never holds keys or funds and never signs. Opt-in `{ preflight: "twzrd" }` (or `X402_PREFLIGHT=twzrd`) binds a versioned assessment to the unpaid 402 (URL, method, advertised rails, wallet verdict, unpaid HEAD). Default off — no CHECK, no behaviour change. Wallet `block`, a changed challenge, or a payment rail outside the assessment abort unpaid (`retryable: false`, never `/route`). An unreachable CHECK is `unavailable`, never a block. Delivery stays unverified until a later paid check; that check cannot rewrite Observed or Decided. HEAD 200 is inspect, not a refusal. Refuse on block. Refusals and 422 walls carry `next` (`reassess` / `stop_auth_required` / `reconcile_settlement`) so the agent does not guess a retry.

1. Origin native 402 — pay the origin.
2. After an origin `text/html` 200: fat HTML (size > 32KiB, **client-side heuristic**) or `{markdown:true}` — `GET https://reader.outbid.sh/scrape?url=` ($0.005 USDC, Base or Solana). `{markdown:true}` is not an override of a non-HTML origin. 200 is JSON `{ok,title,content,markdown,word_count}`, not origin HTML. A JS/login wall is **free** — the scrape is probed before the paywall, so a JS-walled or login-walled URL never triggers a 402 at all; `{markdown:true}` returns 422 `{reason:"needs_browser"}` with nothing spent, the fat-HTML heuristic keeps the origin 200. **Do not** auto-follow that 422 onto `/browse`. Opt-in `{browser:true}` (does **not** imply `{markdown:true}`) — `GET https://reader.outbid.sh/browse?url=` ($0.05). Same JSON on 200. A wall costs nothing: a login wall is free 422 `{reason:"needs_login"}`, an origin bot challenge is free 422 `{reason:"needs_bot"}` — a password will not open that one. Both are terminal; do not retry. Reader or browse down → origin 200, never `/route`. `reader.outbid.sh` is provisional. Do not bid `/browse` onto `#1`.
3. Origin dead / timeout (`on_fail`) — peek `GET https://outbid.sh/top` (free), then one paid `GET https://outbid.sh/route` (`Accept: application/json`, $0.01). 200 `{url,forward_headers}`. Copy only `x-outbid-*` (plus `headerAllowlist`); strip `Authorization` / cookie / payment. Never a second `/route`. A reachable origin 404/5xx is returned, not hopped. 401/403/429 are returned. Payment auth/settlement failure is **not** origin failure — do not `/route`; throw `SmartFetchError` (`retryable: false` if settlement is uncertain).

`on_init` (no URL): peek `/top` then `/route`. Do not use `/route` or the reader on a working diet.

Settlement is Base or Solana USDC. `GET /next` is the same $0.01 circuit (always JSON).

Optional `#1`: `POST https://outbid.sh/bid` `{"url","amount","description"}`. Unpaid is 402. Do not bid the reader onto `#1`.

```js
import { smartFetch } from "./smart-fetch.js";
const r = await smartFetch(url, {}, wallet);
const md = await smartFetch(url, { markdown: true }, wallet);
const js = await smartFetch(url, { browser: true }, wallet);
const gated = await smartFetch(url, { preflight: "twzrd" }, wallet);
```

```bash
curl -s https://outbid.sh/top
curl -s -H 'accept: application/json' https://outbid.sh/route
curl -s -H 'accept: application/json' 'https://reader.outbid.sh/scrape?url=https://example.com/'
curl -s -H 'accept: application/json' 'https://reader.outbid.sh/browse?url=https://example.com/'
```
