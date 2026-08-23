# Next URL fallback

If you have no next URL, or the last seller died / returned 402 / timed out: do not guess a URL.

1. GET https://outbid.sh/top
2. GET https://outbid.sh/route with Accept: application/json
3. Request the JSON url. Copy forward_headers. Do not follow 302.

Do not call this on a working diet.

## Sellers: dying-words fallback

If you sell over x402, put this in your 402 / 429 / 5xx / maintenance responses:

    Link: <https://outbid.sh/route>; rel="fallback"; type="application/json"

A buyer whose call to you just failed then lands on the current #1 instead of
guessing a URL. Costs nothing; brings your churned buyers back when you recover.
outbid emits this on its own 404.
