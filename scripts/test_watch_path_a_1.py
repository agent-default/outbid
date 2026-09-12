#!/usr/bin/env python3
"""Unit tests for Path A 1 watch house roster. No network, no logs tailed."""
import json
import os
import pathlib
import unittest

import importlib.util

_WATCH = pathlib.Path(__file__).resolve().parent / "watch-path-a-1.py"
_spec = importlib.util.spec_from_file_location("watch_path_a_1", _WATCH)
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)

SIGNAL = pathlib.Path("/home/twzrd/outbid/data/path-a-1-signal.jsonl")
_LOCK_DIR = pathlib.Path("/home/twzrd/outbid/data")
FALSE_33W8 = "33W8HJrqCPyJsaBnVPd24AVK2wYUf3VLLutXppyAyWMo"
STRANGER = "So11111111111111111111111111111111111111112"


class HouseRoster(unittest.TestCase):
    def test_33w8_is_house(self):
        self.assertTrue(w.is_house_payer(FALSE_33W8))

    def test_3fcg_is_house(self):
        self.assertTrue(w.is_house_payer("3FcgF2jWjC63YBK8JJTGX7rkA11TgotTzZWXNBLGLxVB"))

    def test_agentcash_base_case_insensitive(self):
        self.assertTrue(w.is_house_payer("0xFB9819456bd9248A9D3c9E12F4cb7bBda5fc2578"))

    def test_stranger_svm_is_not_house(self):
        self.assertFalse(w.is_house_payer(STRANGER))


class ReaderHits(unittest.TestCase):
    def test_false_20260911_signal_rejected(self):
        self.assertTrue(SIGNAL.exists(), "signal log missing")
        first = None
        for line in SIGNAL.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("_void") is True:
                continue
            first = row
            break
        self.assertIsNotNone(first)
        self.assertEqual(first.get("payer"), FALSE_33W8)
        self.assertEqual(first.get("_source"), "reader")
        self.assertFalse(w.foreign_reader_hit(first))

    def test_house_true_short_circuits(self):
        self.assertFalse(w.foreign_reader_hit({"payer": STRANGER, "house": True}))

    def test_stranger_reader_fires(self):
        self.assertTrue(w.foreign_reader_hit({"payer": STRANGER, "house": False}))

    def test_empty_payer_does_not_fire(self):
        self.assertFalse(w.foreign_reader_hit({"payer": "", "house": False}))


class Lock(unittest.TestCase):
    def tearDown(self):
        w.release_watch_lock()

    def test_second_acquire_fails_while_held(self):
        path = _LOCK_DIR / "path-a-1-watch.lock.test"
        if path.exists():
            path.unlink()
        first = w.acquire_watch_lock(path)
        self.assertIsNotNone(first)
        second = w.acquire_watch_lock(path)
        self.assertIsNone(second)
        os.close(first)
        third = w.acquire_watch_lock(path)
        self.assertIsNotNone(third)
        os.close(third)
        path.unlink(missing_ok=True)

    def test_hold_keeps_fd_after_local_dropped(self):
        path = _LOCK_DIR / "path-a-1-watch.lock.lifetime"
        path.unlink(missing_ok=True)
        fd = w.acquire_watch_lock(path)
        w.hold_watch_lock(fd)
        fd = None
        self.assertIsNotNone(w._LOCK_FD)
        os.fstat(w._LOCK_FD)
        self.assertIsNone(w.acquire_watch_lock(path))
        w.release_watch_lock()
        third = w.acquire_watch_lock(path)
        self.assertIsNotNone(third)
        os.close(third)
        path.unlink(missing_ok=True)

    def test_lock_collision_is_systemd_success(self):
        self.assertEqual(w.already_armed_exit_code(), 0)


class OutbidHits(unittest.TestCase):
    def test_loopback_not_foreign(self):
        self.assertFalse(
            w.foreign_outbid_hit(
                {"path": "/route", "paid_hdr": True, "status": 200, "ip": "127.0.0.1"}
            )
        )

    def test_operator_ipv6_not_foreign(self):
        self.assertFalse(
            w.foreign_outbid_hit(
                {
                    "path": "/route",
                    "paid_hdr": True,
                    "status": 200,
                    "ip": "2601:2c7:4700:d2d0::7b66",
                }
            )
        )

    def test_foreign_ip_paid_route_fires(self):
        self.assertTrue(
            w.foreign_outbid_hit(
                {"path": "/route", "paid_hdr": True, "status": 200, "ip": "8.8.8.8"}
            )
        )

    def test_unpaid_402_does_not_fire(self):
        self.assertFalse(
            w.foreign_outbid_hit(
                {"path": "/route", "paid_hdr": False, "status": 402, "ip": "8.8.8.8"}
            )
        )


if __name__ == "__main__":
    unittest.main()
