# v0 lock / capacity

Canonical: `graph/nodes/capacity.md`.

**SoT:** leash = authorized USDC-at-risk under refuse-before-sign. Token
enforces it (lock now; bond/slash later). Agents never buy. x402/MPP settle
USDC. Solana holds the lock. No pool yet. QPS unbound.

Lock → grant:

- 1,000 → 1 wallet, $100 cap, 24h
- 10,000 → 5 wallets, $1,000 cap, 72h
- 100,000 → 25 wallets, $10,000 cap, 168h

Mint: TWZRD, 6dp, 1B fixed, PDA `["lock", locker]`.
