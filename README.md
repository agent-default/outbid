# outbid

Pay-to-rank board. **Rank is the bid.** Checkout is HTTP 402 (USDC).

Nothing else. No Stripe, no accounts, no algorithm.

```
GET  /              board (free)
GET  /api/board     listings (free)
GET  /skill.md      agent instructions (free)
POST /bid
     body {"url":"https://example.com","amount":0.05,"description":"one line"}
     unpaid → 402 PAYMENT-REQUIRED (priced from amount)
     paid   → settled → credited
```

Minimum **$0.01**. Same URL again **adds** to its total.

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

Unpaid `POST /bid` is the product: agents discover the 402 (skill.md,
`.well-known/x402`, the bazaar extension inside the challenge itself), pay,
retry. The settlement tx comes back in the `PAYMENT-RESPONSE` header.

## Status — what is proven and what is not

Proven by tests (mock facilitator, real signed EIP-3009 payments):
402 challenge, price-from-body, verify → settle → credit from settled facts,
cancel-on-invalid, replay idempotency, dry/live exclusivity.

**Not yet proven:** a settle against a real facilitator with real (testnet)
USDC. Wallets exist; they have no testnet USDC yet (see below).

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
