#!/usr/bin/env python3
"""Path A 1 settle watch -- observe-and-halt, no board writes, no replay.
Revived 2026-09-03 (operator) per outbid/memory/handoff.json 'revive' spec:
first non-house paid_hdr on outbid /route|/bid|/next, or first non-house
payer on x402-reader settles, is the signal. Record it and stop -- any
credit/replay decision is a human call, not this script's.
"""
import json, time, pathlib

OUTBID_LOG = pathlib.Path("/home/twzrd/outbid/data/board.mainnet.dispatches.jsonl")
READER_LOG = pathlib.Path("/home/twzrd/x402-reader/data/settles.jsonl")
FOUND_LOG = pathlib.Path("/home/twzrd/outbid/data/path-a-1-signal.jsonl")
HOUSE_PAYER = "0xfb9819456bd9248a9d3c9e12f4cb7bbda5fc2578"
WATCHED_PATHS = {"/route", "/bid", "/next"}


def is_foreign_ip(ip):
    return bool(ip) and not ip.startswith("127.") and ip != "::1" and not ip.startswith("100.")


def foreign_outbid_hit(d):
    return (d.get("path") in WATCHED_PATHS and d.get("paid_hdr") is True
            and d.get("status") == 200 and is_foreign_ip(d.get("ip")))


def foreign_reader_hit(d):
    payer = (d.get("payer") or "").lower()
    return bool(payer) and payer != HOUSE_PAYER.lower()


def new_lines(path, pos):
    if not path.exists():
        return [], pos
    size = path.stat().st_size
    if size < pos:
        pos = 0
    if size == pos:
        return [], pos
    with path.open() as f:
        f.seek(pos)
        lines = f.readlines()
        return lines, f.tell()


def record_and_halt(source, d):
    d = {"_source": source, "_detected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **d}
    with FOUND_LOG.open("a") as f:
        f.write(json.dumps(d) + "\n")
    print(f"PATH-A-1 SIGNAL ({source}): {json.dumps(d)}", flush=True)
    print("Recorded to data/path-a-1-signal.jsonl and halting -- observe-and-halt, no replay, no board writes.", flush=True)


def main():
    ob_pos = OUTBID_LOG.stat().st_size if OUTBID_LOG.exists() else 0
    rd_pos = READER_LOG.stat().st_size if READER_LOG.exists() else 0
    print(f"[watch] armed {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}", flush=True)
    while True:
        lines, ob_pos = new_lines(OUTBID_LOG, ob_pos)
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if foreign_outbid_hit(d):
                record_and_halt("outbid", d)
                return
        lines, rd_pos = new_lines(READER_LOG, rd_pos)
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if foreign_reader_hit(d):
                record_and_halt("reader", d)
                return
        time.sleep(5)


if __name__ == "__main__":
    main()
