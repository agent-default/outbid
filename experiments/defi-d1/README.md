# L1-hourly — mechanical DLMM band policy vs passive (KILL)

Reproducible record of the run logged in `memory/experiments.md`
(2026-09-08). Stored here because `data/` and `memory/` are gitignored, so
neither is a durable home — the same gap that made an earlier clobber on this
tree unrecoverable.

```sh
python3 sim.py      # offline, no network, ~1s
```

**Naming.** This file's experiment is `L1-hourly`. A peer ledger calls the
same run `D1`, and calls a *different* Meteora daily run `E1` — while `E1` in
`memory/experiments.md` is the wash-gate replay, which was VOID, not a kill.
See the ID COLLISION header in that file before citing anything.

**Verdict: KILL a.** Net yield <= the higher pre-registered baseline
(HODL 50/50) at all three widths. Parameters were fixed before the run and
not retuned; the first set failed and that is the result.

| Width | Final | Fees | Friction | Rebal | In-range | vs HODL 50/50 |
|---|---|---|---|---|---|---|
| ±5% | $108,537 | $9,643 | $1,096 | 15 | 99.0% | −7.32 pp |
| ±10% | $109,444 | $9,814 | $365 | 5 | 99.7% | −6.41 pp |
| ±20% | $109,698 | $9,872 | $73 | 1 | 99.9% | −6.16 pp |

Baselines over 60 days: HODL 50/50 +15.85%, 100% SOL +31.71%, Kamino +0.66%.

**Friction is not the finding.** $73 on $100k at ±20% is 0.07%. The 6 pp hole
is inventory: the band sold SOL into a +31.7% rally. Execution optimisation
(CU, tips, bare-metal) addresses a rounding error next to a loss two orders
of magnitude larger.

**Both disclosed biases favour the strategy, so the kill holds a fortiori:**
an in-range position is granted the pool's average fee rate (a mechanical band
almost certainly earns less than incumbent concentrated LPs), and IL is
charged only against the final anchor, understating true LVR.

**Cross-check.** Simulated fee capture ($9,643–9,872 on $100k = +9.6–9.9%)
independently reproduces the pool-level fee return of +9.909% computed from
the daily `apyBase` series by a different method.

**Price endpoints differ between the two runs and should:** the earlier
pool-level floor run used daily bars ($78.07 → $104.14); this policy run uses
hourly ($79.01 → $104.07). Both give +31.7% SOL and the same +15.85% HODL.

**What is NOT claimed.** KILL b (drawdown) is unevaluable — the tracked series
is accrued value, which is monotonic under fee accrual. And this kills
*long-only* LP. A delta-hedged book races USDC lending rather than HODL and is
a separate pre-registration with its own enemies (funding, liquidation).

## Inputs (as fetched, unmodified)

| File | Source |
|---|---|
| `inputs/coingecko_sol_hourly_60d.json` | CoinGecko `market_chart` SOL/USD, 1441 hourly points |
| `inputs/defillama_orca_sol_usdc_chart.json` | DefiLlama `yields.llama.fi/chart/a5c85bc8-eb41-45c0-a520-d18d7529c0d8` (orca-dex SOL-USDC, 1073 daily points) |
| `inputs/defillama_kamino_lend.json` | DefiLlama `yields.llama.fi/pools`, kamino-lend USDC/SOL rows |

No Dune credits were spent. Meteora's DLMM API returned 404 on every path
tried; Binance klines are geo-blocked (451) from this host.
