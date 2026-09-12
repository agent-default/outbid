#!/usr/bin/env python3
"""Run TrustRank on a payer→merchant CSV. Writes graph_stats, seeds, reports, verdict.

Usage:
  python3 run.py --edges EDGES.csv --out DIR
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

from trustrank import (
    graph_from_edges,
    ranks,
    seed_teleport,
    topic_sensitive_pagerank,
    uniform_teleport,
)

NAMED = {
    "BJGdsDXJ": "BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ",
    "3MZVk97x": "3MZVk97x9SeRxbYpc3jhzRfU2fyA3emYutnqfn9kNfYX",
    "AQqnMFBwGZ": "AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA",
    "FTNMkNMm": "FTNMkNMmPcjZmdF5kkEseZ8Dn7YATULJiWiajfEQQsiP",
}

# Hand-justified AAA-cohort payers (ops-history/aaa-cohort-20260904).
# Criteria fixed before looking at named-merchant adjacency: solana, tier AAA,
# wash_events=0, fac_share=0, merchants>=5, usd>=100, not the 5k-tx grazer
# cluster. None of these eight paid the four named merchants in the 90d dump.
PRIMARY_SEEDS = [
    {
        "pubkey": "54BAreAVfDVXfa8u78VWpW1oy7AwuuHwBuVUG2Rz948n",
        "reason": "AAA cohort; $3888 across 7 merchants; top counterparty is travel.brij.fi (human travel checkout); wash_events=0, fac_share=0; last_seen 2026-09-04.",
    },
    {
        "pubkey": "Hdv8SVv47jZkFEEFfnKaUabqZAv63eSYs55kAT7BWYNB",
        "reason": "Independent second AAA spender at travel.brij.fi; $831 across 6 merchants; wash_events=0, fac_share=0; last_seen 2026-08-22.",
    },
    {
        "pubkey": "284MEfAVcwjNVz8wayBNa78z8SZkXhTxUbGjaxG2e5uc",
        "reason": "AAA cohort; $754 across 42 merchants; wash_events=0, fac_share=0; last_seen 2026-06-15.",
    },
    {
        "pubkey": "132LN4NvWjWKGpNjojMBKmkbC7UZMMR8sWUMwE6oJCFS",
        "reason": "AAA cohort; $405 across 11 merchants; wash_events=0, fac_share=0; last_seen 2026-06-15.",
    },
    {
        "pubkey": "Hvv615RDfdDuh8nXUYKGGCCm7udS3brkj919KM8LYATJ",
        "reason": "AAA cohort; $361 across 8 merchants; top counterparty Fo26Gc… (not brij.fi); wash_events=0, fac_share=0.",
    },
    {
        "pubkey": "7t1ebNJPC4n8KEuF6ZG7STuNYxtfVx5NGutmhbj2LUKf",
        "reason": "AAA cohort; $326 across 45 merchants; wash_events=0, fac_share=0; last_seen 2026-07-04.",
    },
]

# Drop both travel.brij.fi seeds; replace with two other AAA payers meeting the same bar.
ALT_SEEDS = [
    PRIMARY_SEEDS[2],
    PRIMARY_SEEDS[3],
    PRIMARY_SEEDS[4],
    PRIMARY_SEEDS[5],
    {
        "pubkey": "7qpMZR6rhQM7kJDFyhaLd8YRC7NoEYspD2ygKP29QsDL",
        "reason": "AAA cohort replacement; $723 across 113 merchants; wash_events=0, fac_share=0; last_seen 2026-06-28. Replaces the two brij.fi travel spenders.",
    },
    {
        "pubkey": "HnCF9wXyCou5piTLE3JHFMfsfWT6uFsQKrgW7HTB5cQg",
        "reason": "AAA cohort replacement; $566 across 54 merchants; wash_events=0, fac_share=0; last_seen 2026-07-22. Replaces the two brij.fi travel spenders.",
    },
]


def load_edges(path: Path):
    pairs = []
    usdc = defaultdict(int)
    tx = defaultdict(int)
    with path.open() as f:
        for row in csv.DictReader(f):
            p, m = row["payer"], row["merchant"]
            pairs.append((p, m))
            usdc[(p, m)] += int(row["usdc_micro"])
            tx[(p, m)] += int(row["tx_count"])
    return pairs, usdc, tx


def merchant_stats(pairs, usdc, tx):
    outdeg = defaultdict(int)
    for p, _m in pairs:
        outdeg[p] += 1
    payers_of = defaultdict(set)
    usdc_in = defaultdict(int)
    tx_in = defaultdict(int)
    for p, m in pairs:
        payers_of[m].add(p)
        usdc_in[m] += usdc[(p, m)]
        tx_in[m] += tx[(p, m)]
    out = {}
    for m, ps in payers_of.items():
        capt = sum(1 for p in ps if outdeg[p] == 1)
        n = len(ps)
        out[m] = {
            "unique_payers": n,
            "tx_in": tx_in[m],
            "usdc": usdc_in[m] / 1e6,
            "captive_pct": round(100.0 * capt / n, 1) if n else 0.0,
        }
    return out, outdeg


def graph_stats(pairs, usdc, tx, outdeg):
    payers = {p for p, _ in pairs}
    merchants = {m for _, m in pairs}
    nodes = payers | merchants
    respend = merchants & payers
    sinks = merchants - payers
    total_usdc = sum(usdc.values())
    sink_usdc = sum(usdc[(p, m)] for p, m in pairs if m in sinks)
    out1 = sum(1 for p in payers if outdeg[p] == 1)
    return {
        "source": "intel-prod-pg x402_solana_merchant_payer_agg_90d (read-only COPY)",
        "note": "Same grain as the reported PageRank run; 1-day corpus drift vs 43193/6016/47360.",
        "node_count": len(nodes),
        "payer_count": len(payers),
        "merchant_count": len(merchants),
        "edge_count": len(pairs),
        "merchants_that_respend": len(respend),
        "pure_sinks": len(sinks),
        "fraction_out_degree_1": round(out1 / len(payers), 4) if payers else 0.0,
        "payers_out_degree_1": out1,
        "sink_value_share": round(sink_usdc / total_usdc, 4) if total_usdc else 0.0,
        "named_present": {
            k: (v in merchants or v in payers) for k, v in NAMED.items()
        },
    }


def report_rows(score, mstats, named=NAMED):
    rnk = ranks(score)
    lines = [
        "label\tpubkey\trank\tmass\tusdc\ttx_in\tunique_payers\tcaptive_pct"
    ]
    for label, pk in named.items():
        st = mstats.get(pk, {"usdc": 0, "tx_in": 0, "unique_payers": 0, "captive_pct": 0})
        mass = score.get(pk, 0.0)
        rank = rnk.get(pk, -1)
        lines.append(
            f"{label}\t{pk}\t{rank}\t{mass:.12g}\t{st['usdc']:.2f}\t{st['tx_in']}\t{st['unique_payers']}\t{st['captive_pct']}"
        )
    return "\n".join(lines) + "\n"


def order_3mz_bjg(score):
    a = NAMED["3MZVk97x"]
    b = NAMED["BJGdsDXJ"]
    sa, sb = score.get(a, 0.0), score.get(b, 0.0)
    if sa > sb:
        return "3MZVk97x > BJGdsDXJ"
    if sb > sa:
        return "BJGdsDXJ > 3MZVk97x"
    return "3MZVk97x = BJGdsDXJ"


def seed_paid_named(pairs, seeds):
    seed_set = {s["pubkey"] for s in seeds}
    named_pks = set(NAMED.values())
    hits = []
    for p, m in pairs:
        if p in seed_set and m in named_pks:
            hits.append((p, m))
    return hits


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--edges", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    pairs, usdc, tx = load_edges(Path(args.edges))
    g = graph_from_edges(pairs)
    mstats, outdeg = merchant_stats(pairs, usdc, tx)
    stats = graph_stats(pairs, usdc, tx, outdeg)
    (out / "graph_stats.json").write_text(json.dumps(stats, indent=2) + "\n")

    missing = [
        s["pubkey"]
        for s in PRIMARY_SEEDS + ALT_SEEDS
        if s["pubkey"] not in g
    ]
    if missing:
        raise SystemExit(f"seeds missing from graph: {missing}")

    seeds_doc = {
        "primary": PRIMARY_SEEDS,
        "alt": ALT_SEEDS,
        "selection": "AAA cohort csv; not PageRank top-k; not uniform teleport.",
        "primary_paid_named_edges": [
            {"payer": p, "merchant": m} for p, m in seed_paid_named(pairs, PRIMARY_SEEDS)
        ],
        "alt_paid_named_edges": [
            {"payer": p, "merchant": m} for p, m in seed_paid_named(pairs, ALT_SEEDS)
        ],
    }
    (out / "seeds.json").write_text(json.dumps(seeds_doc, indent=2) + "\n")

    pr = topic_sensitive_pagerank(g, uniform_teleport(list(g)))
    primary = topic_sensitive_pagerank(
        g, seed_teleport([s["pubkey"] for s in PRIMARY_SEEDS])
    )
    alt = topic_sensitive_pagerank(
        g, seed_teleport([s["pubkey"] for s in ALT_SEEDS])
    )

    (out / "trustrank_primary.txt").write_text(report_rows(primary, mstats))
    (out / "trustrank_alt.txt").write_text(report_rows(alt, mstats))
    (out / "pagerank_uniform.txt").write_text(report_rows(pr, mstats))

    o1 = order_3mz_bjg(primary)
    o2 = order_3mz_bjg(alt)
    pr_order = order_3mz_bjg(pr)
    real = (
        o1.startswith("3MZVk97x >")
        and o2.startswith("3MZVk97x >")
        and pr_order.startswith("BJGdsDXJ >")
    )
    flip = o1 != o2
    verdict = "real_work" if real and not flip else "moves_arbitrariness"

    hits = seed_paid_named(pairs, PRIMARY_SEEDS) + seed_paid_named(pairs, ALT_SEEDS)
    mechanism = (
        "star-forest + out-degree-1 payers: TrustRank from payer seeds is nearly "
        "'which merchants the seeds paid'. "
        + (
            "Zero primary/alt seed edges into the four named merchants; residual mass is multi-hop or numerical floor."
            if not hits
            else f"Named-merchant seed edges: {len(hits)}."
        )
    )
    (out / "verdict.txt").write_text(
        f"{verdict}\n"
        f"primary: {o1}\n"
        f"alt: {o2}\n"
        f"pagerank_uniform: {pr_order}\n"
        f"mechanism: {mechanism}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
