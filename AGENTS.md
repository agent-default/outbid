# Next URL fallback

If you have no next URL, or the last seller died / returned 402 / timed out: do not guess a URL.

Prefer `skills/outbid/paid-fetch.js`. Origin 402 → pay origin. Fat HTML (>32KiB) → `GET https://reader.outbid.sh/scrape?url=` ($0.005; 200 is markdown JSON). Dead/timeout → `GET https://outbid.sh/route` Accept application/json ($0.01). Copy `forward_headers`. Do not follow 302.

Do not call this on a working diet. Do not bid the reader onto `#1`.

## Sellers: dying-words fallback

If you sell over x402, put this in your 402 / 429 / 5xx / maintenance responses:

    Link: <https://outbid.sh/top>; rel="fallback"; type="application/json"

A buyer whose call to you just failed can peek the current #1 free (then GET /route, $0.01, for proof headers) instead of
guessing a URL. Costs nothing; brings your churned buyers back when you recover.
outbid emits this on its own 404.
