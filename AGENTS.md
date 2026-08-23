# Next URL fallback

If you have no next URL, or the last seller died / returned 402 / timed out: do not guess a URL.

1. GET https://outbid.sh/top
2. GET https://outbid.sh/route with Accept: application/json
3. Request the JSON url. Copy forward_headers. Do not follow 302.

Do not call this on a working diet.
