#!/usr/bin/env python3
"""L1-hourly (a.k.a. D1 policy run) — mechanical DLMM band policy vs passive.

Verbatim re-statement of the run recorded in memory/experiments.md
(2026-09-08T01:3xZ). Parameters were fixed BEFORE the run and are not retuned:
the first set failed, and that is the result.

Verdict: KILL a — net yield <= the higher pre-registered baseline (HODL 50/50)
at every width tested.

Disclosed model choice (not fabricated data): an in-range position is granted
the pool's realised average fee rate for that day. Per-tick liquidity, which
would give exact fee share, is not in the free sources. This grant is
GENEROUS to the strategy.

Known bias, also against the strategy's favour being overstated: impermanent
loss is applied only against the FINAL anchor, so divergence realised at
earlier rebalances is uncharged. True LVR is worse than reported.

Inputs are stored beside this file so the run reproduces without network.
Run: python3 sim.py
"""
import json, math, datetime as dt, pathlib

HERE = pathlib.Path(__file__).parent
PX = HERE / "inputs/coingecko_sol_hourly_60d.json"
POOL = HERE / "inputs/defillama_orca_sol_usdc_chart.json"

# --- PARAMETERS FIXED BEFORE THE RUN (overfitting rule) ---
WIDTHS = [0.05, 0.10, 0.20]   # +/- band half-width around the anchor
SWAP_FEE = 0.0004             # Orca lpFeeRate for this pool, 4 bps
SLIPPAGE = 0.0010             # 10 bps on the rebalanced half
PRIORITY_FEE_USD = 0.03       # priority fee + Jito tip per rebalance tx
CAPITAL = 100_000.0
KAMINO_BLENDED_APY = 0.0408   # (3.26 USDC + 4.89 SOL) / 2, DefiLlama spot


def load():
    px = [(dt.datetime.fromtimestamp(t / 1000, dt.UTC), p)
          for t, p in json.loads(PX.read_text())["prices"]]
    chart = {r["timestamp"][:10]: r for r in json.loads(POOL.read_text())["data"]
             if r.get("apyBase") is not None}
    px = [(t, p) for t, p in px if t.strftime("%Y-%m-%d") in chart]
    return px, chart


def simulate(px, chart, w):
    """One band policy. Returns final value and internals."""
    def hourly_fee_rate(t):
        return chart[t.strftime("%Y-%m-%d")]["apyBase"] / 100.0 / 365 / 24

    p0 = px[0][1]
    val, anchor = CAPITAL, p0
    lo, hi = p0 * (1 - w), p0 * (1 + w)
    fees = friction = 0.0
    rebalances = in_range = 0

    for t, p in px:
        if lo <= p <= hi:
            f = val * hourly_fee_rate(t)
            fees += f
            val += f
            in_range += 1
        else:
            cost = val * 0.5 * (SWAP_FEE + SLIPPAGE) + PRIORITY_FEE_USD
            val -= cost
            friction += cost
            rebalances += 1
            anchor = p
            lo, hi = p * (1 - w), p * (1 + w)

    # terminal IL of the position against the anchor it was last set at
    r_anchor = px[-1][1] / anchor
    lp_mult = math.sqrt(r_anchor) / (0.5 * r_anchor + 0.5)
    return dict(width=w, final=val * lp_mult, fees=fees, friction=friction,
                rebalances=rebalances, in_range=in_range / len(px))


def main():
    px, chart = load()
    p0, p1 = px[0][1], px[-1][1]
    r = p1 / p0
    days = (px[-1][0] - px[0][0]).total_seconds() / 86400
    hodl = CAPITAL * (0.5 * r + 0.5)
    hodl_sol = CAPITAL * r
    lend = CAPITAL * ((1 + KAMINO_BLENDED_APY) ** (days / 365))

    print(f"hours {len(px)}  {px[0][0].date()} -> {px[-1][0].date()}  ({days:.1f}d)")
    print(f"SOL ${p0:,.2f} -> ${p1:,.2f}  ({(r-1)*100:+.2f}%)\n")
    print(f"{'width':>6} {'final $':>11} {'fees $':>10} {'friction $':>11} "
          f"{'rebal':>6} {'in-range':>9} {'vs HODL50':>11} {'vs SOL':>10} {'vs lend':>10}")

    rows = []
    for w in WIDTHS:
        s = simulate(px, chart, w)
        rows.append(s)
        print(f"{w*100:>5.0f}% {s['final']:>11,.0f} {s['fees']:>10,.0f} "
              f"{s['friction']:>11,.0f} {s['rebalances']:>6d} "
              f"{s['in_range']*100:>8.1f}% {(s['final']-hodl)/CAPITAL*100:>10.2f}pp "
              f"{(s['final']-hodl_sol)/CAPITAL*100:>9.2f}pp "
              f"{(s['final']-lend)/CAPITAL*100:>9.2f}pp")

    print(f"\nbaselines: HODL50/50 ${hodl:,.0f} ({(hodl/CAPITAL-1)*100:+.2f}%)  "
          f"100% SOL ${hodl_sol:,.0f} ({(hodl_sol/CAPITAL-1)*100:+.2f}%)  "
          f"Kamino ${lend:,.0f} ({(lend/CAPITAL-1)*100:+.2f}%)")
    kill = all(s["final"] <= hodl for s in rows)
    print(f"\nKILL a (net <= higher baseline) at every width: {kill}")


if __name__ == "__main__":
    main()
