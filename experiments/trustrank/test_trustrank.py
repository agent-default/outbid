"""Drive the shipped TrustRank function — star-forest fixture, not the corpus."""
from __future__ import annotations

import unittest

from trustrank import (
    graph_from_edges,
    ranks,
    seed_teleport,
    topic_sensitive_pagerank,
    uniform_teleport,
)


def _star_forest():
    """100 exclusive payers → SINK; two roamers → VALUE and OTHER."""
    edges = []
    captives = [f"c{i:03d}" for i in range(100)]
    for c in captives:
        edges.append((c, "SINK"))
    edges.append(("roamerA", "VALUE"))
    edges.append(("roamerA", "OTHER"))
    edges.append(("roamerB", "VALUE"))
    edges.append(("roamerB", "OTHER"))
    g = graph_from_edges(edges)
    return g, captives


class TrustRankFixture(unittest.TestCase):
    def test_uniform_pagerank_ranks_the_captive_sink_first(self):
        g, _ = _star_forest()
        score = topic_sensitive_pagerank(g, uniform_teleport(list(g)))
        r = ranks(score)
        self.assertLess(r["SINK"], r["VALUE"])
        self.assertGreater(score["SINK"], score["VALUE"])

    def test_organic_seeds_rank_value_above_sink(self):
        g, _ = _star_forest()
        score = topic_sensitive_pagerank(
            g, seed_teleport(["roamerA", "roamerB"])
        )
        r = ranks(score)
        self.assertLess(r["VALUE"], r["SINK"])
        self.assertGreater(score["VALUE"], score["SINK"])
        self.assertEqual(score["SINK"], 0.0)

    def test_replacing_a_seed_with_a_captive_flips_sink_vs_value(self):
        g, captives = _star_forest()
        primary = topic_sensitive_pagerank(
            g, seed_teleport(["roamerA", "roamerB"])
        )
        alt = topic_sensitive_pagerank(
            g, seed_teleport(["roamerA", captives[0]])
        )
        self.assertGreater(primary["VALUE"], primary["SINK"])
        self.assertGreater(alt["SINK"], alt["VALUE"])

    def test_empty_teleport_raises(self):
        g, _ = _star_forest()
        with self.assertRaises(ValueError):
            topic_sensitive_pagerank(g, {})

    def test_graph_from_edges_includes_sinks(self):
        g = graph_from_edges([("p", "m")])
        self.assertEqual(g["m"], [])
        self.assertEqual(g["p"], ["m"])


if __name__ == "__main__":
    unittest.main()
