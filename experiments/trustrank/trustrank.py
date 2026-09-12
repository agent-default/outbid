"""Topic-sensitive PageRank (TrustRank) on a directed payer→merchant graph.

Teleport mass sits only on a caller-supplied seed vector. Uniform teleport
is ordinary PageRank. Dangling mass is redistributed on the same teleport
vector (Gyöngyi et al.). Out-edges are unweighted unique pairs — the same
out-degree normalisation that made PageRank collapse to payer-count on this
star forest.

This module is the experiment runner, not production ranking.
"""
from __future__ import annotations

from collections import defaultdict


DAMPING = 0.85
ITERS = 58


def topic_sensitive_pagerank(
    out_neighbors: dict[str, list[str]],
    teleport: dict[str, float],
    *,
    damping: float = DAMPING,
    iters: int = ITERS,
) -> dict[str, float]:
    """Return a probability vector over every node in `out_neighbors`.

    `out_neighbors` must include sinks (empty lists). `teleport` is an
    unnormalized non-negative map; missing keys are 0. Raises if the
    teleport mass is 0.
    """
    nodes = list(out_neighbors)
    n = len(nodes)
    if n == 0:
        return {}
    index = {u: i for i, u in enumerate(nodes)}
    t_raw = [float(teleport.get(u, 0.0)) for u in nodes]
    t_sum = sum(t_raw)
    if t_sum <= 0.0:
        raise ValueError("teleport mass must be positive")
    t = [x / t_sum for x in t_raw]
    outdeg = [len(out_neighbors[u]) for u in nodes]
    incoming: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for u, nbrs in out_neighbors.items():
        i = index[u]
        if not nbrs:
            continue
        w = 1.0 / len(nbrs)
        for v in nbrs:
            incoming[index[v]].append((i, w))
    r = [1.0 / n] * n
    d = damping
    for _ in range(iters):
        dangling = 0.0
        for i, deg in enumerate(outdeg):
            if deg == 0:
                dangling += r[i]
        new = [0.0] * n
        for j in range(n):
            acc = 0.0
            for i, w in incoming[j]:
                acc += r[i] * w
            new[j] = d * acc + d * dangling * t[j] + (1.0 - d) * t[j]
        r = new
    return {nodes[i]: r[i] for i in range(n)}


def uniform_teleport(nodes: list[str]) -> dict[str, float]:
    if not nodes:
        return {}
    w = 1.0 / len(nodes)
    return {u: w for u in nodes}


def seed_teleport(seeds: list[str]) -> dict[str, float]:
    if not seeds:
        raise ValueError("seed set must be non-empty")
    return {s: 1.0 for s in seeds}


def graph_from_edges(edges: list[tuple[str, str]]) -> dict[str, list[str]]:
    """Unique directed payer→merchant pairs. Sinks have empty out-lists."""
    out: dict[str, set[str]] = defaultdict(set)
    nodes: set[str] = set()
    for src, dst in edges:
        nodes.add(src)
        nodes.add(dst)
        out[src].add(dst)
        out.setdefault(dst, set())
    for u in nodes:
        out.setdefault(u, set())
    return {u: sorted(nbrs) for u, nbrs in out.items()}


def ranks(score: dict[str, float]) -> dict[str, int]:
    """1-indexed rank, ties broken by pubkey for stability."""
    order = sorted(score, key=lambda u: (-score[u], u))
    return {u: i + 1 for i, u in enumerate(order)}
