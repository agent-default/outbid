# Next URL fallback

If you have no next URL, or the last seller died / returned 402 / timed out: do not guess a URL.

Prefer `skills/outbid/smart-fetch.js` (`smartFetch(url, options, wallet)`). Origin 402 → pay origin. After an origin HTML 200: fat HTML (>32KiB, client heuristic) or `{markdown:true}` → `GET https://reader.outbid.sh/scrape?url=` ($0.005; 200 is markdown JSON). JS wall still spends the $0.005; `{markdown:true}` returns 422 `needs_browser`, fat-HTML heuristic keeps origin HTML. Reader throw → origin, not `/route`. Dead/timeout → one `/route` ($0.01). Reachable 404/5xx is returned, not hopped. Payment fail is not origin fail — do not `/route`. Strip auth/cookie/payment on hop; only `x-outbid-*` `forward_headers`.

Do not call this on a working diet. Do not bid the reader onto `#1`.

## Sellers: dying-words fallback

If you sell over x402, put this in your 402 / 429 / 5xx / maintenance responses:

    Link: <https://outbid.sh/top>; rel="fallback"; type="application/json"

A buyer whose call to you just failed can peek the current #1 free (then GET /route, $0.01, for proof headers) instead of
guessing a URL. Costs nothing; brings your churned buyers back when you recover.
outbid emits this on its own 404.
