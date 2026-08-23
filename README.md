# outbid

Default routing table. **#1 is the next request to try.** Checkout is HTTP 402 (USDC).

This is **not** TWZRD. Trust lives in `wzrd-final`. Agents: start at `AGENTS.md` then `GRAPH.md`. Do not copy monorepo layout into this tree.

Live writer: `outbid-mainnet.service` → `src/server.js` on `127.0.0.1:4024`. Do not move that file.

Two sides:

- Buy a route (free): `GET /top` (peek) then `GET /route` / `POST /dispatch` → 302 to current #1, counted as a **dispatch**.
- Sell a route: `POST /bid` unpaid → 402, paid → credited. Rank is the bid.

The listed URL is any HTTPS resource (Base x402, MCP, whatever). Settlement can be Solana. That cross-rail is the product, not a billboard of human clicks.

A 302's custom headers never reach the seller. Agents that consume as JSON (`Accept: application/json`) get `forward_headers` to copy onto the follow-up request so #1 can see they were dispatched.

```
GET  /              spectator board (free)
GET  /top           current #1 JSON (free, not counted)
GET  /api/board     listings + dispatch_total (free)
GET  /route         302 to #1 (free, counted); JSON if Accept: application/json
POST /dispatch      same as GET /route
GET  /skill.md      agent instructions (free) — get_top / dispatch first, bid optional
POST /bid
     body {"url":"https://example.com","amount":0.05,"description":"one line"}
     unpaid → 402 PAYMENT-REQUIRED (priced from amount)
     paid   → settled → credited
```

Minimum **$0.01**. Same URL again **adds** to its total.

`GET /go/:id` still increments leftover **clicks** for the human page. Clicks are not demand. The product metric is `dispatch_total`.

## What gets credited

The request's `amount` only prices the 402 challenge. The board credits the
**settled** amount — read in the `onAfterSettle` hook from the payment
requirements the facilitator actually settled, with payer and tx from the
settlement result. Consequences:

- A spoofed `amount`, header, or body claim credits nothing.
- An invalid bid (bad URL) returns 400 **before settlement** — the middleware
  cancels the payment, no money moves.
- If settlement fails after the handler, the middleware discards the response
  and nothing was written — the handler never touches the store.
- Credits are idempotent on `(network, tx)`: a facilitator retry or double
  hook credits once.
- A settled payment that somehow fails to credit is appended to
  `data/settled-uncredited.jsonl` for manual replay — never silently lost.

## Dry vs live

`X402_DRY=1` with **no wallet configured** enables `POST /bid/dry` (no chain,
dev only) on its own data file `data/board.dry.json`. The moment
`EVM_ADDRESS`/`SVM_ADDRESS` is set, dry is force-disabled and the live board is
`data/board.json`. The two never share a file.

## Run

```bash
cp .env.example .env
# optional: EVM_ADDRESS / SVM_ADDRESS for live 402
npm install
npm test           # includes a full 402→pay→settle→credit e2e against a mock facilitator
npm start          # http://127.0.0.1:4021
```

Default facilitator is `https://x402.org/facilitator` (Base Sepolia + Solana
devnet). Do not use that URL on mainnet.

## Bid from an agent

```bash
# dry (dev instance)
curl -s -X POST 'http://127.0.0.1:4021/bid/dry' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","amount":0.05,"description":"hello"}'

# live 402 — any x402 payer
npx agentcash@latest fetch 'http://127.0.0.1:4021/bid?amount=0.05'
node scripts/bid.mjs https://example.com 0.05 "hello"
```

Live public: `https://outbid.sh`. Spec for the consume-side flywheel: `PHASE-2.md`.
Agent briefing: `AGENTS.md`.

## Status

Proven: mock e2e, Base Sepolia, Solana mainnet via PayAI,
PUBLIC_BASE_URL pin, `GET /top` peek + `GET /route` dispatch vs click.
Seed row on `https://outbid.sh` is dogfood. First foreign dispatch — a
foreign agent's next call going through `/route` — is the real test, not
another bid.

Do not treat this README as the ops ledger — see `PHASE-2.md` and the Claude
project memory `outbid-board-state.md`.

## Wallets

Dedicated keys live **outside the repo**:

`/home/twzrd/security/wallets/outbid/` (dir 700, secrets 600)

```bash
npm run wallets:init      # generate receiver + payer (EVM + SVM), write .env.live
npm run wallets:status    # pubkeys + balances, never prints secrets
```

Payer secrets are loaded from those files (`EVM_PRIVATE_KEY_FILE` /
`SVM_PRIVATE_KEY_FILE` in `.env.live`). Do not paste keys into `.env`.
Do not use Path A (`GFpLvoc…`) or the settle feePayer (`4LkEFj…`) as outbid
wallets — those are the TWZRD serving stack.

This tree is standalone. It is not the TWZRD serving stack.
