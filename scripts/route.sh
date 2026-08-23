#!/usr/bin/env bash
# Use only when next_url is empty or the last fetch died / 402'd / timed out.
set -euo pipefail
curl -s https://outbid.sh/top >/dev/null
json=$(curl -s -H 'accept: application/json' https://outbid.sh/route)
url=$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
# copy forward_headers from the JSON onto the next request. do not follow 302.
printf '%s\n' "$url"
