#!/usr/bin/env python3
"""Path A 1 settle watch -- observe-and-halt, no board writes, no replay.

First non-house paid_hdr on outbid /route|/bid|/next, or first non-house
payer on x402-reader settles, is the signal. Record it and stop -- any
credit/replay decision is a human call, not this script's.

House roster is documented payers/payTos and AgentCash hops (33W8, 3Fcg),
not a single Base address. A settle row with house=true is never foreign.
The 2026-09-11 reader scrape from 33W8 was a false halt.
"""
import fcntl
import json
import os
import pathlib
import time

OUTBID_LOG = pathlib.Path("/home/twzrd/outbid/data/board.mainnet.dispatches.jsonl")
READER_LOG = pathlib.Path("/home/twzrd/x402-reader/data/settles.jsonl")
FOUND_LOG = pathlib.Path("/home/twzrd/outbid/data/path-a-1-signal.jsonl")
LOCK_PATH = pathlib.Path("/home/twzrd/outbid/data/path-a-1-watch.lock")
WATCHED_PATHS = {"/route", "/bid", "/next"}

# Documented house: board dogfood, AgentCash hops, reader/witness payTos.
# Sources: graph/nodes/machine.md, WITNESS-FOREIGN-TWICE-STATUS.md,
# verify-witness-foreign-twice.mjs, x402-reader/src/settle.js.
HOUSE_PAYERS = frozenset(
    {
        "0xfb9819456bd9248a9d3c9e12f4cb7bbda5fc2578",
        "5LPpHE9cS1gB241soZvTT3NcHQuEd1r6uJoiF22Hi5h4",
        "33W8HJrqCPyJsaBnVPd24AVK2wYUf3VLLutXppyAyWMo",
        "3FcgF2jWjC63YBK8JJTGX7rkA11TgotTzZWXNBLGLxVB",
        "EDnoaoZS6esWYgZfsweC2jM6ca15NTTBjHWZikKwxc3H",
        "0x90429C151Fe83A5B0d0297D9b47e12276BbB07d4",
        "0xb36e83ab5e6128bc0e1b76b3f59fe2fd443f0788",
        "J2h49Qf8P4kttEUbhkUPdv2zHAXE6pA7QQ2gN65dhEYv",
        "0x14df772bd496bbb7f49bc3e992ce13b2c441177f",
        "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
    }
)

# Operator-box IPv6 documented in graph/nodes/now.md + live.md (not a stranger).
HOUSE_IP_PREFIXES = ("127.", "100.", "2601:2c7:4700:d2d0:")
HOUSE_IPS = frozenset({"::1"})

# Kept so older imports/docs that name HOUSE_PAYER still resolve.
HOUSE_PAYER = "0xfb9819456bd9248a9d3c9e12f4cb7bbda5fc2578"

# Flock lives on this open fd. Keep a module reference so a local in main()
# cannot be dropped by a later refactor / unused-variable cleanup. Kernel
# releases the lock when the process exits or the fd is closed.
# Second instance exits 0 so systemd Restart=on-failure does not loop.
# Do not start outbid-path-a1-watch.service while another holder has the lock.
# After reboot, systemd (WantedBy=default.target) is the intended single instance.
_LOCK_FD = None
LOCK_CONFLICT_EXIT = 0


def norm_payer(p):
    s = str(p or "").strip()
    if not s:
        return ""
    return s.lower() if s.startswith(("0x", "0X")) else s


HOUSE_NORM = frozenset(norm_payer(p) for p in HOUSE_PAYERS)


def is_house_payer(p):
    n = norm_payer(p)
    return bool(n) and n in HOUSE_NORM


def is_foreign_ip(ip):
    if not ip:
        return False
    s = str(ip)
    if s in HOUSE_IPS:
        return False
    return not s.startswith(HOUSE_IP_PREFIXES)


def foreign_outbid_hit(d):
    return (
        d.get("path") in WATCHED_PATHS
        and d.get("paid_hdr") is True
        and d.get("status") == 200
        and is_foreign_ip(d.get("ip"))
    )


def foreign_reader_hit(d):
    if d.get("house") is True:
        return False
    payer = d.get("payer")
    return bool(payer) and not is_house_payer(payer)


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


# Flock lives on this open fd. Keep a module ref so a future main() edit
# cannot drop the only local and let GC close it mid-watch.
# Second instance exits 0: systemd Restart=on-failure will not loop.
# Do not start outbid-path-a1-watch.service while another holder has the lock.
_LOCK_FD = None


def acquire_watch_lock(path=LOCK_PATH):
    """Non-blocking exclusive lock. Second instance exits 0 (already armed)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    os.fsync(fd)
    return fd


def hold_watch_lock(fd):
    """Retain the flock fd for process lifetime."""
    global _LOCK_FD
    _LOCK_FD = fd
    return fd


def release_watch_lock():
    """Close the held fd (tests / clean halt). Kernel then drops the flock."""
    global _LOCK_FD
    fd = _LOCK_FD
    _LOCK_FD = None
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


def already_armed_exit_code():
    """Lock collision: 0 so systemd Restart=on-failure stays dead."""
    return 0


def record_and_halt(source, d):
    d = {
        "_source": source,
        "_detected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **d,
    }
    with FOUND_LOG.open("a") as f:
        f.write(json.dumps(d) + "\n")
    print(f"PATH-A-1 SIGNAL ({source}): {json.dumps(d)}", flush=True)
    print(
        "Recorded to data/path-a-1-signal.jsonl and halting -- observe-and-halt, no replay, no board writes.",
        flush=True,
    )


def main():
    lock_fd = acquire_watch_lock()
    if lock_fd is None:
        print("[watch] already armed (lock held); exiting 0", flush=True)
        return already_armed_exit_code()
    hold_watch_lock(lock_fd)
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
            if d.get("_void") is True:
                continue
            if foreign_reader_hit(d):
                record_and_halt("reader", d)
                return
        time.sleep(5)


if __name__ == "__main__":
    main()
