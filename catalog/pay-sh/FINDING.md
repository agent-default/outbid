# pay.sh is not a catalog registration — it is a gateway you run

**Do not draft a `PAY.md`. There isn't one.** The task assumed pay.sh listing =
submit metadata + an OpenAPI snapshot to a registry. Their own docs index
(`https://pay.sh/docs/llms.txt`) points instead to
**"Publish a provider" → `/docs/building-with-pay/yaml-specification/`**, and
that page describes something structurally different.

## What the spec actually is

> "A paywall spec is a single YAML file. The gateway loads it at startup,
> validates every block, and uses it to drive 402 challenges, payment
> verification, and (optionally) upstream forwarding."

Required top-level: `name`, `subdomain`, `title`, `description`, `category`,
`version`, `routing`, and ≥1 `endpoints[]`. `routing.type: proxy` with a `url`
forwards verified-paid requests upstream. `operator:` sets `currencies`,
`network` (`mainnet|devnet|localnet`), `fee_payer` co-signing, and an optional
`recipient:` wallet override.

## Why that is a different decision

Listing intel this way means **running pay.sh's `pay` gateway in front of
`intel.twzrd.xyz`**, not publishing a pointer to our existing endpoints:

1. **Their gateway issues the 402**, not ours. Our x402 implementation, dual-rail
   accepts, and 45s Solana timeout are bypassed on that path.
2. **Settlement moves.** Payments land on the operator signer's pubkey (or a
   `recipient:` override) configured in *their* account file — not `GFpLvoc…`.
3. **Our V6 receipt and trust-gate semantics do not ride along automatically.**
   The signed-receipt block in `.well-known/x402` is ours; the gateway knows
   nothing about it.
4. It adds a second facilitator and a runtime dependency in front of live prod.

That is the same shape as the rule already recorded for Coinbase:
**"Do not CDP-rewire to get listed."** The principle transfers — getting listed
should not re-plumb settlement.

## What is unchanged and still true

Intel remains the right listing *candidate*: dual-rail, Solana USDC with a
**sponsored feePayer**, `/v1/intel/quick` at **$0.001** (below the $0.002 catalog
floor), no reader rails to build. What changed is the cost of listing on this
particular catalog.

## Recommendation

**Do not submit to pay.sh on these terms without an explicit decision** that
re-plumbing settlement through their gateway is acceptable. Two cheaper paths
that do not touch settlement:

- **Coinbase Bazaar** indexes routes after a CDP settlement — also a re-plumb,
  also already ruled out. Same objection, noted for symmetry.
- **Direct discovery**, which costs nothing and is already live: intel publishes
  `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/skill.md`, and an MCP
  server. Those are the surfaces an agent reads without any registry.

The honest position: the catalog gap is real, and the two largest catalogs both
require adopting their payment path. That is a strategic choice about
independence, not a packaging task — and it should be made deliberately rather
than discovered mid-submission.

## Assets produced anyway, so the decision is concrete

- `CONTRACT.md` — verified live payment terms for both endpoints, both rails.
- `openapi.intel-paid.json` — mechanical two-path extract of the live
  `openapi.json` (v0.5.9). Reusable for **any** listing route, not just pay.sh.
- `provider.draft.yml` — what a pay.sh provider spec would look like, marked
  DRAFT and unsubmitted, so the re-plumb is visible rather than abstract.
