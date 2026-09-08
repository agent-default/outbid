# outbid

TWZRD token infrastructure. Public: `https://outbid.sh`.

APIs settle in **USDC** (HTTP 402). The native token buys **capacity** — never the call. Slashing and PoEC-claim come after the lock.

Agents: `AGENTS.md` → `GRAPH.md` → `graph/nodes/arch.md` + `graph/nodes/capacity.md`. Style: `agent.md`. Do not copy `wzrd-final` layout here.

Live writer: `outbid-mainnet.service` → `src/server.js` on `127.0.0.1:4024`. Do not move that file. Do not restart it for docs.

## v0 lock table

| locked | wallets | spend cap | window |
|---|---|---|---|
| 1,000 | 1 | $100 | 24h |
| 10,000 | 5 | $1,000 | 72h |
| 100,000 | 25 | $10,000 | 168h |

QPS unbound. Leash = authorized USDC spend cap. Agents never buy. No pool yet.

v0 is a refundable license, not a bond. Unbond zeroes the grant immediately;
tokens return after 24h. Burning the cap and exiting costs a day of
liquidity, nothing more. Slash is the loss function and is not built.
Do not call the lock collateral, stake, a bond, or "at risk". Honest
words: license, seat, leash, allowance. Revisit when slash ships.

Vault stores the lock. Intel applies the grant. Spec: `graph/nodes/capacity.md`.
Client gate (refuse before sign): `src/leash/` — local reference module, not
wired to `server.js`, no route. Cap is enforced off-chain by the paying client.
Import as `outbid/leash`. Demo: `npm run leash:demo`.

Mint: TWZRD, 6 decimals, 1B fixed to treasury, then revoke mint+freeze.
PDA `["lock", locker]`. Token keys exist; mint waits operator confirmation
of `memory/token-key-report.md`. No `/v0` routes and no `:4024` restart
until a mainnet vault ships.

## Keys

Board 402 payTos stay in `~/security/wallets/outbid/`. Dedicated token keys exist in `~/security/wallets/outbid-token/` (directory 700, key files 600). The public-key report is in `memory/token-key-report.md`; operator confirmation is required before minting. Do not reuse board SVM.

## Legacy board

The x402 occupancy table still runs in this process:

```
GET  /top           current #1 JSON (free)
GET  /route         402 then #1 ($0.01 USDC → last_payer)
POST /bid           unpaid → 402; paid → credited
GET  /skill.md      board agent instructions
```

That module is **legacy**, not a 402 mint. Rank is still USDC bid. Token-weight on `#1` is later.

```bash
npm test
npm start          # http://127.0.0.1:4021 locally
```

Live facilitator is PayAI. Dry `X402_DRY=1` is local-only.

## Status

Control plane: live (board). Token keys validated on 2026-09-07; proposed
mint absent on mainnet. Local vault gate passed
(`node programs/token-vault/scripts/e2e-lock.mjs`). Mint, mainnet deploy,
`/v0`, and `:4024` remain held. Vault contract:
[programs/token-vault/README.md](programs/token-vault/README.md).
