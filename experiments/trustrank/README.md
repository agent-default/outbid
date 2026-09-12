# TR1 — TrustRank on the Solana x402 settlement graph

Does topic-sensitive PageRank with a **hand-verified payer seed set** separate
`3MZVk97x` (Laso, high USDC) from `BJGdsDXJ` (PageRank #1, 37k captive payers),
or only move seed arbitrariness?

PageRank facts are given (star forest; flood edges untouched; do not penalize
captive). This directory does **not** change production ranking.

```sh
python3 test_trustrank.py
python3 run.py --edges EDGES.csv --out OUTDIR
```

`EDGES.csv` is a read-only COPY of `x402_solana_merchant_payer_agg_90d`
(`payer,merchant,tx_count,usdc_micro`). Not committed.
