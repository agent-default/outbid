#!/usr/bin/env python3
"""LIVE PRODUCTION smoke test: 60 unpaid GETs to reader.outbid.sh/outbid.sh.

Run manually or as a bounded deployment check, never in a tight loop.
Only User-Agent varies; every request uses urllib's HTTP/TLS stack.
This does not test real requests/httpx clients or their TLS fingerprints.
Exit nonzero unless paid routes return USDC 402 terms and free routes are 200.
Board GET /bid advertises payment; this never submits a paid POST /bid.
"""

import argparse
import json
from urllib.error import HTTPError
from urllib.request import Request, build_opener

CLIENTS = [
    "Python-urllib/3.12", "Python-urllib/3.13", "python-requests/2.32.3",
    "python-httpx/0.28.1", "curl/8.10.1", "node", "undici",
    "x402-fetch", "Claude-User", None,
]
# Prices are pinned in atomic USDC; update with any deliberate price change.
ENDPOINTS = {"scrape": 5000, "browse": 50000}
BOARD_PATHS = {"llms.txt": None, "top": None, "route": 10000, "bid": 10000}
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"


def probe(url, amount, user_agent):
    opener = build_opener()
    opener.addheaders = []
    headers = {"Accept": "application/json"}
    if user_agent is not None:
        headers["User-Agent"] = user_agent
    request = Request(url, headers=headers)
    try:
        response = opener.open(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        expected = 200 if amount is None else 402
        if response.status != expected:
            raise ValueError(f"expected {expected}, got {response.status}")
        if amount is None:
            if not response.read().strip():
                raise ValueError("empty discovery response")
            return
        body = json.load(response)
    for terms in body.get("accepts", []):
        network = terms.get("network")
        quoted = terms.get("amount", terms.get("maxAmountRequired"))
        if (network in ("base", "eip155:8453")
                and terms.get("asset", "").lower() == USDC
                and int(quoted or 0) == amount
                and terms.get("scheme") == "exact"
                and terms.get("payTo")):
            return
    raise ValueError("missing expected Base USDC payment terms")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--surface", choices=["all", "reader", "board"], default="all")
    args = parser.parse_args()
    endpoints = []
    if args.surface in ("all", "reader"):
        endpoints.extend((f"https://reader.outbid.sh/{name}?url=https%3A%2F%2Fexample.com", amount)
                         for name, amount in ENDPOINTS.items())
    if args.surface in ("all", "board"):
        endpoints.extend((f"https://outbid.sh/{name}", amount) for name, amount in BOARD_PATHS.items())
    failed = 0
    for endpoint, amount in endpoints:
        for user_agent in CLIENTS:
            label = f"{endpoint} {user_agent or '(no UA)'}"
            try:
                probe(endpoint, amount, user_agent)
                print(f"PASS {label}")
            except Exception as error:
                failed += 1
                print(f"FAIL {label}: {error}")
    return int(failed > 0)


if __name__ == "__main__":
    raise SystemExit(main())
