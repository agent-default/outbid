#!/usr/bin/env python3
"""Conversion pulse: house spec hashes stripped; command exits 0."""
import importlib.util
import pathlib
import subprocess
import unittest

_PULSE = pathlib.Path(__file__).resolve().parent / "path-a-conversion-pulse.py"
_spec = importlib.util.spec_from_file_location("path_a_conversion_pulse", _PULSE)
pulse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pulse)


class Pulse(unittest.TestCase):
    def test_house_spec_prefixes_are_stripped(self):
        self.assertTrue(pulse.spec_house("e45dee4bdeadbeef"))
        self.assertTrue(pulse.spec_house("e8146dfeced7d3e6"))
        self.assertFalse(pulse.spec_house("0685fe0163821daa"))

    def test_cli_exits_zero_and_prints_live_line(self):
        r = subprocess.run(["python3", str(_PULSE)], check=False, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WITNESS live", r.stdout)
        self.assertIn("OUTBID paid_hdr", r.stdout)
        self.assertIn("path-a-1 signal", r.stdout)


if __name__ == "__main__":
    unittest.main()
