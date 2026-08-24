# Fuse dogfood — 2026-08-24 (house-labeled)

One real run of the spend fuse, published as receipts. **Every wallet below is
ours.** This is not organic demand, counts toward no metric, and is not a
stranger settle. It exists to show the loop running in production with
receipts: wash brake → policy → pay → durable audit.

## Stack

- `twzrd-x402-gate` @ [`wzrd-final` `87c145d9`]: `createTwzrdPolicyFetch`
  (#2182) + `createFileSpendLedger` (#2183) + `dailyCeilingUsd` (#2184).
  TWZRD is a collaborating team; the gate is theirs, this board is ours.
- `@x402/fetch` 2.23, PayAI facilitator, Solana mainnet USDC.
- Policy: **$0.01 / request, $0.02 / day**, wash brake on live
  `intel.twzrd.xyz`. Payer `EDnoao…xc3H` (house dogfood seed).

## Receipts (15 in `2026-08-24-fuse-dogfood.receipts.jsonl`)

| # | What happened | Proof |
|---|---|---|
| 1 | **Armed brake refused our own wallet.** TWZRD's corpus flags this cluster's circular flow, so the default fuse refused to pay reader payTo `F1AbWu…` at all. Zero spend. | `wash_refusal_house`, `twzrd_wash_flagged` |
| 2 | **$0.005 settle** — reader scrape of a real page (5,932 words of markdown), paid under an explicit `washMaxUsdc: 0.01` soft cap with the flag recorded. | tx `kZFFy5C9h5mgzjWmabRsGw2CKNKwnCoTkeRMruvrErcCUn9mjg4P…` slot 441372283 |
| 3 | **$0.01 settle** — paid `GET /route`, then used the routed #1 seat for a live RPC `getHealth` → `"ok"`. | tx `5LyGTG1Xi6HnAhm8J2zh7PbX3JcQSEitjuFr7iQUBfPuWJhy38G9…` slot 441372290 |
| 4 | **Per-request cap refused a real invoice.** A $0.004-cap fuse met the reader's $0.005 price: `POLICY_MAX_AMOUNT`, remaining `0.004`, no signature. | signed block decision |
| 5 | **Daily ceiling refused the third payment.** $0.015 accumulated in the durable ledger; the next $0.01 bust the $0.02 ceiling: `POLICY_DAILY_CEILING`, remaining `0.005`, no signature. | signed block decision |

Every wash check, allow, and block is a line in the receipts file; allows and
blocks are signed decision tokens (`twzrd-pc-v1`) bound to the intent hash.

## The part worth reading twice

The wash brake fired on **us** first. House-to-house recycling is
wash-shaped by definition, the corpus flagged it, and the default fuse
refused it — the gate does not exempt its own operator. The two settles ran
only under a visible, bounded override (`washMaxUsdc: 0.01`), and every one
of those decisions carries `washFlagged: true` in the receipt.

## Timestamp caveat (added 2026-08-24 20:22Z)

The wash flag above is decision-time truth, not a live claim. At
10:14:53–56Z the live TWZRD card for `F1AbWu…` returned
`wash_flagged: true`, and every receipt line records exactly that. The same
endpoint re-checked ~10 hours later returns `wash_flagged: null` — TWZRD's
tri-state for "nothing was evaluated here," which is not "clean." A reader
re-running the card lookup today will not reproduce the flag. The
`receipts.jsonl` lines and their signed decision tokens are the durable
record of what the card said when the fuse decided — which is the reason
receipts are published at all, instead of pointing at a live surface that
moves.

## Verify it yourself

- Settles: `getTransaction` on either signature against any Solana mainnet
  RPC — both transfer USDC from `EDnoaoZS6esWYgZfsweC2jM6ca15NTTBjHWZikKwxc3H`.
- Ledger: `2026-08-24-fuse-dogfood.ledger.jsonl` is append-only JSONL where
  each row commits to the sha256 of the previous line. Loading it through
  `createFileSpendLedger` re-verifies the chain; edit any amount and the load
  throws. The `policy:global` scope sums to exactly `15000` micro-USD.

## What this does not claim

No stranger has paid. Path A 1 (a settle from a wallet we do not own) is
still zero, and this run does not move it. What it shows: a funded agent ran
real jobs through the fuse, paid when the price was inside policy, was
refused when it was not — including by the operator's own wash corpus — and
left a tamper-evident trail. If you want the same behavior:
`npx skills add agent-default/outbid` for the fetch loop; the pre-sign gate
is TWZRD's (free CHECK at https://intel.twzrd.xyz/skill.md).
