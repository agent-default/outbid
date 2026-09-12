#!/usr/bin/env python3
"""Read-only pulse: outbid consume + witness paid loop, house probes stripped.

Does not pay, restart, or write. Prints counts that would hide a stranger
if you only looked at raw quote_deliverable volume.
"""
import json
import pathlib
from collections import Counter

FUNNEL = pathlib.Path("/home/twzrd/witness-serve/data/funnel.ndjson")
DISPATCH = pathlib.Path("/home/twzrd/outbid/data/board.mainnet.dispatches.jsonl")
SIGNAL = pathlib.Path("/home/twzrd/outbid/data/path-a-1-signal.jsonl")

# spec_hashes inverted from witness-serve tests / house listen (funnel diagnosis).
HOUSE_SPEC_PREFIXES = (
    "e45dee4b",  # example.com/pricing + rank
    "0354e6b3",  # retrieve.test
    "a1c20d48",  # host.test
    "f1123b28",  # quote.test
    "e8146dfe",  # witness.test pricing
)


def spec_house(h):
    s = str(h or "")
    return any(s.startswith(p) for p in HOUSE_SPEC_PREFIXES)


def collect():
    """Read-only funnel counts from local logs. No network."""
    funnel = Counter()
    live = Counter()
    last = {}
    if FUNNEL.exists():
        with FUNNEL.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = (r.get("route"), r.get("status"), r.get("outcome"))
                funnel[key] += 1
                last[r.get("outcome")] = r.get("ts")
                if not spec_house(r.get("spec_hash")):
                    live[key] += 1
                    last["live_" + str(r.get("outcome"))] = r.get("ts")

    paid200 = 0
    paid200_foreign_ip = 0
    if DISPATCH.exists():
        with DISPATCH.open() as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    d.get("path") in {"/route", "/bid", "/next"}
                    and d.get("paid_hdr") is True
                    and d.get("status") == 200
                ):
                    paid200 += 1
                    ip = str(d.get("ip") or "")
                    if ip and not ip.startswith(("127.", "100.", "2601:2c7:4700:d2d0:")) and ip != "::1":
                        paid200_foreign_ip += 1

    signals = []
    voids = 0
    if SIGNAL.exists():
        with SIGNAL.open() as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("_void") is True:
                    voids += 1
                else:
                    signals.append(row)

    return {
        "witness_raw_quote": funnel.get(("/quote", 200, "quote_deliverable"), 0),
        "witness_raw_402": funnel.get(("/witness", 402, "witness_402_challenge"), 0),
        "witness_raw_receipt": funnel.get(("/witness", 200, "witness_signed_receipt"), 0),
        "witness_live_quote": live.get(("/quote", 200, "quote_deliverable"), 0),
        "witness_live_402": live.get(("/witness", 402, "witness_402_challenge"), 0),
        "witness_live_receipt": live.get(("/witness", 200, "witness_signed_receipt"), 0),
        "outbid_paid200": paid200,
        "outbid_paid200_foreign_ip": paid200_foreign_ip,
        "signal_rows": len(signals),
        "void_notes": voids,
        "last": last,
        "signals": signals,
    }


def main():
    c = collect()
    print("WITNESS raw   quote_del=%d  402=%d  receipt=%d" % (c["witness_raw_quote"], c["witness_raw_402"], c["witness_raw_receipt"]))
    print("WITNESS live  quote_del=%d  402=%d  receipt=%d  (house spec_hash stripped)" % (c["witness_live_quote"], c["witness_live_402"], c["witness_live_receipt"]))
    print("last receipt:      %s" % c["last"].get("witness_signed_receipt"))
    print("last live quote:   %s" % c["last"].get("live_quote_deliverable"))
    print("last live 402:     %s" % c["last"].get("live_witness_402_challenge"))
    print("OUTBID paid_hdr 200 on /route|/bid|/next: %d (foreign-looking IP: %d)" % (c["outbid_paid200"], c["outbid_paid200_foreign_ip"]))
    print("path-a-1 signal rows: %d  void notes: %d" % (c["signal_rows"], c["void_notes"]))
    if c["signals"]:
        s0 = c["signals"][0]
        print("first signal: source=%s payer=%s house=%s" % (s0.get("_source"), s0.get("payer"), s0.get("house")))


if __name__ == "__main__":
    main()
