#!/usr/bin/env python3
"""Every public surface must answer agent-shaped clients. Exit nonzero if not.

Three front doors have blocked real buyers so far: robots.txt turned away the
two UAs most likely to be agents; reader.outbid.sh 403'd Python-urllib;
outbid.sh still does across every board route including /llms.txt, the file
an agent reads FIRST to learn we take payment.

A 403 on discovery is invisible in our own logs as a lost sale. This is the
cheapest possible guard against a fourth instance.

Read-only. No payment, no auth, no writes.
"""
import sys
import urllib.error
import urllib.request

# (host, path, expected) — expected 200 for discovery, 402 for paid routes.
SURFACES = [
    ("reader.outbid.sh", "/scrape?url=https%3A%2F%2Fexample.com", 402),
    ("reader.outbid.sh", "/browse?url=https%3A%2F%2Fexample.com", 402),
    ("outbid.sh", "/llms.txt", 200),
    ("outbid.sh", "/top", 200),
    ("outbid.sh", "/route", 402),
    ("twzrd.xyz", "/llms.txt", 200),
    ("intel.twzrd.xyz", "/llms.txt", 200),
    ("intel.twzrd.xyz", "/skill.md", 200),
    ("intel.twzrd.xyz", "/.well-known/x402", 200),
    ("intel.twzrd.xyz", "/v1/intel/quick/GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs", 402),
]

# None = the stdlib default (Python-urllib/x.y), which is what BIC blocks.
CLIENTS = [None, "node", "curl/8.10.1", "python-requests/2.32.3",
           "python-httpx/0.28.1", "undici", "x402-fetch", "GPTBot", "Claude-User"]


def probe(host, path, user_agent):
    headers = {} if user_agent is None else {"User-Agent": user_agent}
    request = urllib.request.Request(f"https://{host}{path}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main():
    failures = []
    for host, path, expected in SURFACES:
        for user_agent in CLIENTS:
            label = f"{host}{path.split('?')[0]} [{user_agent or 'Python-urllib'}]"
            try:
                status = probe(host, path, user_agent)
            except Exception as error:                      # network, DNS, timeout
                failures.append(f"{label}: {error}")
                continue
            if status != expected:
                failures.append(f"{label}: expected {expected}, got {status}")

    for failure in failures:
        print(f"FAIL {failure}")
    print(f"{len(SURFACES) * len(CLIENTS) - len(failures)}"
          f"/{len(SURFACES) * len(CLIENTS)} checks passed")
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
