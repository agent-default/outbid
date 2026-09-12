#!/usr/bin/env python3
"""Pin the revenue brief to live local funnel numbers. No network."""
import importlib.util
import json
import pathlib
import unittest

_HERE = pathlib.Path(__file__).resolve().parent
_BRIEF = _HERE.parent / "memory" / "2026-09-12-revenue-conversion-brief.md"
_CHECKPOINT = _HERE.parent / "data" / "path-a-checkpoint.json"
_spec = importlib.util.spec_from_file_location("pulse", _HERE / "path-a-conversion-pulse.py")
pulse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pulse)


class Brief(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = _BRIEF.read_text()
        cls.c = pulse.collect()
        cls.cp = json.loads(_CHECKPOINT.read_text())

    def test_brief_exists_and_is_decision_length(self):
        self.assertTrue(_BRIEF.exists())
        n = len(self.text.split())
        self.assertGreater(n, 200)
        self.assertLess(n, 2000)

    def test_pins_witness_live_funnel(self):
        self.assertIn("%d quotes" % self.c["witness_live_quote"], self.text)
        self.assertIn("%d × 402" % self.c["witness_live_402"], self.text)
        self.assertIn("%d receipts" % self.c["witness_live_receipt"], self.text)

    def test_pins_outbid_path_a_1_zero(self):
        self.assertEqual(self.c["outbid_paid200_foreign_ip"], 0)
        self.assertIn("%d paid_hdr 200" % self.c["outbid_paid200"], self.text)
        self.assertIn("0 foreign-looking IP", self.text)
        self.assertIn("Path A 1 is still unlanded", self.text)

    def test_pins_intel_counters_from_checkpoint(self):
        h = self.cp["handoff_counters"]
        self.assertIn("**0**", self.text)
        self.assertIn(str(h["feed_distinct_pay_to"]), self.text)
        self.assertIn("true 3 / 3", self.text)
        self.assertIn("false 208 / 21", self.text)

    def test_insight_rejects_closed_theses(self):
        t = self.text.lower()
        self.assertIn("not the wall", t)
        self.assertIn("dialect", t)
        self.assertIn("monitor", t)
        self.assertIn("demand composition", t)
        self.assertIn("do not rebuild", t)

    def test_highest_leverage_is_held_completions_keyhole(self):
        t = self.text.lower()
        self.assertIn("chat/completions", t)
        self.assertIn("do not land tonight", t)
        self.assertIn("premium_gating_enabled", t)
        self.assertIn("completions.rs", t)
        self.assertIn("/home/twzrd/worktrees/completions-x402-keyhole", self.text)
        self.assertIn("bd020a26", self.text)
        self.assertIn("#2655", self.text)
        self.assertNotIn("mint now", t)

    def test_does_not_authorize_free_quote_removal(self):
        self.assertIn("Do not", self.text)
        self.assertIn("free witness `/quote`", self.text)


if __name__ == "__main__":
    unittest.main()
