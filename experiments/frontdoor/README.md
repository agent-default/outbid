# Learnings carried to twzrd.xyz

Tonight's findings came from outbid surfaces. Applied across to the
twzrd.xyz zone, checked rather than assumed, 2026-09-08.

## 1. Front doors — verified clean, and now guarded

`twzrd.xyz`, `intel.twzrd.xyz` and `api.twzrd.xyz` never had the Browser
Integrity Check block: `/llms.txt`, `/skill.md`, `/.well-known/x402` and the
free intel endpoints all answer `Python-urllib` correctly. So this transfers
as *verified clean*, not as a fix.

`check-frontdoors.py` guards all three zones — 10 surfaces × 9 client
identities, asserting 200 on discovery and 402 on paid routes. **90/90.**
It complements the reader-specific smoke test (`9105a39`) rather than
replacing it: that one checks payment terms, this one checks reachability
across every zone.

Three front doors have turned away real buyers so far (robots.txt UAs,
`reader.outbid.sh`, `outbid.sh`). A 403 on discovery is invisible in our logs
as a lost sale — it looks like nobody came. That is why this runs on a
schedule and not by memory.

## 2. Catalog eligibility — the plan was backwards

pay.sh requires paid endpoints to accept Solana-mainnet USDC or USDT. The
reader is Base-only, so the plan was to add Solana rails to the reader first.

**intel.twzrd.xyz already qualifies, today, with no infrastructure change.**
Verified live:

| Endpoint | Price | Rails |
|---|---|---|
| `/v1/intel/quick/{wallet}` | **$0.001** | Solana mainnet USDC (**sponsored feePayer**) + Base |
| `/v1/intel/trust/{wallet}` | $0.05 | Solana mainnet USDC (sponsored feePayer) + Base |

x402Version 2, `scheme: exact`, dual-rail, gas sponsored on the Solana leg.

So the listing experiment should run on **intel**, not the reader. It is the
surface that is already eligible, and it needs no Solana work to get there.

## 3. Pricing — intel leads where the reader trails

The catalog's cheapest observed offering is **$0.002**. Intel's `quick` rung
is **$0.001** — below the floor. The reader is the opposite: $0.005 scrape
against a $0.002-0.003 market, and $0.05 browse against $0.01 for
browser-rendered extraction.

Listing intel therefore does not require a pricing decision first, which the
reader listing does. Two fewer coupled variables in the experiment.

## 4. The conversion killer is ours, and it is on this zone

`merchant_card` returns **26,299 bytes ≈ 6,574 tokens** — 82% of it the
`services` array — where the routing decision needs **197 bytes** (133×).
That is the *free* first-call tool on intel.twzrd.xyz. A listing that
delivers an agent to a 6.5k-token free call converts once and never again.
Fix is additive: decision core by default, catalogue behind a flag.
See `experiments/tool-usability/`.

## 5. Card and gate still contradict each other

The card returns `insufficient_evidence` on an unscored seller ("absence of
evidence is not evidence of fraud"); `twzrd-x402-gate@0.9.4`'s wash default
aborts on unknown coverage. Both are twzrd.xyz products. Whichever is right,
shipping both is shipping a contradiction — and the abort behaviour is the
exact finding that got AutoGate deleted from ClawRouter.

## 6. Measurement hygiene, before any intel listing

If foreign demand gets measured on intel, exclude house traffic by **address
list**, not by a logged boolean. `settle.js` derives `house` from an env var
configured on 2026-09-04, so 340 rows of our own payments are recorded
`house:false`. Filtering on that column is what made 354 self-payments look
like revenue.
