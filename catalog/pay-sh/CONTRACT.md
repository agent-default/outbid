# Live payment contracts — intel.twzrd.xyz paid endpoints

Captured from the live service 2026-09-08, read-only, zero spend. These are
the authoritative terms; any listing copy must match them, not the reverse.

| | `/v1/intel/quick/{pubkey}` | `/v1/intel/trust/{pubkey}` |
|---|---|---|
| Price | **$0.001** (1000 atomic) | **$0.05** (50000 atomic) |
| x402Version | 2 | 2 |
| Scheme | `exact` | `exact` |
| Query params | — | `seller_wallet` (optional) |
| Responses | 200 / 402 / 503 | 200 / 402 / 503 |

Both advertise two rails:

| Rail | Network | Asset | payTo | maxTimeout | feePayer |
|---|---|---|---|---|---|
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjFWdd5…TDt1v` (USDC) | `GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs` | 45s | **`BFK9TLC3edb1…` (sponsored)** |
| Base | `eip155:8453` | `0x833589fC…02913` (USDC) | `0xfB9819456bd9248A9D3c9E12F4cb7bBda5fc2578` | 3600s | — |

Source of truth already published by the service:
`GET /openapi.json` (3.1.0, `TWZRD Agent Intel` v0.5.9, 42 paths) and
`GET /.well-known/x402` (x402_version 2, with `paid_resources` / `resources` /
`free_resources` / `receipt` / `proof` blocks). `openapi.intel-paid.json` here
is a mechanical two-path extract of that live spec — not hand-written.

## Two discrepancies found while verifying

**1. The Base `payTo` is the house payer.** `0xfB9819456bd9248A9D3c9E12F4cb7bBda5fc2578`
is the same address listed in `x402-reader/src/settle.js:4` `DEFAULT_HOUSE_PAYERS`
and hard-coded as `HOUSE_PAYER` in `outbid/scripts/watch-path-a-1.py:13`. It is our
own dogfood wallet, paying on the reader and receiving on intel's Base rail.
Internally consistent, but it breaks any foreign-payment measurement that keys on
that address: a genuine outside payment to intel-on-Base would land on a wallet our
own tooling classifies as house. **The Solana `payTo` (`GFpLvoc…`) is distinct and
clean** — which is the rail a pay.sh listing would use anyway.

**2. `resource` is null in the live 402 accepts** but populated in the
`.well-known/x402` entries. Harmless for a hand-written client; a strict catalog
validator may reject the 402 body for the missing field. Worth confirming before
any submission.
