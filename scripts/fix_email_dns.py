#!/usr/bin/env python3
"""Add null-MX, SPF reject, and DMARC reject records without overwrites."""

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API_ROOT = "https://api.cloudflare.com/client/v4"
TIMEOUT_SECONDS = 20


def api_call(method, path, token, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = Request(API_ROOT + path, data=body, method=method)
    request.add_header("Authorization", "Bearer " + token)
    request.add_header("Content-Type", "application/json")
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            result = json.load(response)
    except (HTTPError, URLError) as error:
        detail = error.read().decode(errors="replace") if isinstance(error, HTTPError) else str(error)
        raise RuntimeError(f"Cloudflare API {method} failed: {detail}") from error
    if not result.get("success"):
        raise RuntimeError(f"Cloudflare API {method} failed: {json.dumps(result.get('errors'))}")
    return result.get("result")


def records_at(zone_id, name, token):
    query = urlencode({"per_page": 1000, "name.exact": name})
    return api_call("GET", f"/zones/{zone_id}/dns_records?{query}", token)


def content(record):
    value = record.get("content", "").strip()
    if record.get("type") == "TXT" and value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    return value


def matches(record, wanted):
    if record.get("type") != wanted["type"]:
        return False
    if content(record) != wanted["content"]:
        return False
    if wanted["type"] == "MX":
        return record.get("priority") == wanted["priority"]
    return True


def conflict(record, wanted):
    if record.get("type") != wanted["type"]:
        return False
    if wanted["type"] == "TXT":
        prefix = "v=spf1" if wanted["content"].lower().startswith("v=spf1") else "v=dmarc1"
        return content(record).lower().startswith(prefix)
    return True


def show_records(name, records):
    print(f"Existing records for {name}:")
    print(json.dumps(records, indent=2, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zone-id", default=os.getenv("CF_ZONE_ID"))
    parser.add_argument("--zone-name", default=os.getenv("CF_ZONE_NAME", "outbid.sh"))
    parser.add_argument("--rua", default=os.getenv("DMARC_RUA"),
                        help="optional DMARC rua, including mailto:; "
                             "omit unless the mailbox is externally authorized")
    parser.add_argument("--apply", action="store_true", help="write missing records")
    args = parser.parse_args()
    token = os.getenv("CF_API_TOKEN")
    if not token:
        parser.error("CF_API_TOKEN is required")
    if not args.zone_id:
        parser.error("--zone-id or CF_ZONE_ID is required")
    if args.rua and not args.rua.startswith("mailto:"):
        parser.error("--rua/DMARC_RUA must start with mailto: when given")

    # rua is optional and defaults off. DMARC requires only v= and p=
    # (RFC 7489). A rua inside this zone is undeliverable against the null MX
    # published above, and a cross-domain rua needs an authorization record
    # at the receiver (RFC 7489 s7.1) that we cannot publish. Either way the
    # reports silently never arrive, which reads as "no spoofing attempts".
    dmarc = "v=DMARC1; p=reject" + (f"; rua={args.rua}" if args.rua else "")

    wanted = [
        {"type": "MX", "name": args.zone_name, "content": ".", "priority": 0},
        {"type": "TXT", "name": args.zone_name, "content": "v=spf1 -all"},
        {"type": "TXT", "name": f"_dmarc.{args.zone_name}", "content": dmarc},
    ]
    states = []
    for record in wanted:
        existing = records_at(args.zone_id, record["name"], token)
        show_records(record["name"], existing)
        if any(conflict(item, record) and not matches(item, record) for item in existing):
            raise RuntimeError(f"conflicting {record['type']} at {record['name']}; refusing to overwrite")
        if any(matches(item, record) for item in existing):
            states.append(("present", record))
        else:
            states.append(("missing", record))

    missing = [record for state, record in states if state == "missing"]
    if not missing:
        print("No changes needed.")
        return 0
    print("Planned additions:")
    print(json.dumps(missing, indent=2, sort_keys=True))
    if not args.apply:
        print("Dry run. Pass --apply to write.")
        return 0
    for record in missing:
        result = api_call("POST", f"/zones/{args.zone_id}/dns_records", token, record)
        print(f"Created {record['type']} {record['name']} ({result['id']}).")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
