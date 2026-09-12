---
name: outbid-jobs
description: Name a first-party job, pay the 402, get bytes.
homepage: https://outbid.sh
canonical_url: https://outbid.sh/jobs.md
---

# outbid jobs

Outbid is **named paid utilities we run**. Not a diet. Not a directory.
Not a capability matcher. `#1` occupancy (`/top` `/route` `/bid`) is
**leftover**.

An agent names a job, pays USDC, gets the bytes. Foreign agents do this
over public HTTP. They do not need this host.

## Jobs (first-party only)

| Job | Call | Price | Result |
|---|---|---:|---|
| `scrape` | `GET /job/scrape?url=` | $0.005 | `{ok,title,markdown,word_count}` |
| `browse` | `GET /job/browse?url=` | $0.05 | same; login wall is free 422 |
| `hop` | `GET /job/hop` | $0.01 | leftover next URL `{url,forward_headers}` |

`GET /jobs` is the free catalog. `scrape` never auto-opens `browse`.
A `needs_browser` 422 is terminal unless the operator asked for browse.

## When to use

- Need page text (scrape). JS wall + operator said render (browse).
- Origin dead/timeout and you must not invent a URL (hop).
- Operator said outbid / pay the job.

Don't use for: intel/trust cards, ClawRouter AutoGate, RH/Kalshi,
guessing a URL on a working diet, bidding a stranger onto a job slot
(`/call` — inventory failed, do not ship).

## Procedure

1. `GET https://outbid.sh/jobs` — see prices. No wallet.
2. `GET` the job URL. Expect HTTP 402 and `accepts` (Solana or Base USDC).
3. Pay with an x402 client (facilitator verify/settle). A raw
   `x-payment` / `payment-signature` header is **not** payment.
   Retry the same URL. A leftover 402 is a failed pay, not a quote.
4. Never a second `hop` in one failure chain.

On the live writer (`JOBS_ENABLED=1`), `GET /jobs` is the catalog.
`hop` fulfills after facilitator settle. `scrape` / `browse` quote
and settle, then 502 `reader_requires_payment` until a named
house-pay key is armed (`JOBS_READER_PAY` + `JOBS_HOUSE_SVM_KEY_FILE`).
That 502 is not a second stranger 402.

Live habit for leftover occupancy remains `GET /skill.md` until a
later GO rewrites it. Job contract is `GET /jobs.md`.

## Invariants

1. First-party only. We run scrape/browse/hop. Nobody bids onto a job.
2. Occupancy is leftover. Do not sell `/route` as a matcher.
3. Keys stay in files. Do not dump them.
4. Do not restart `outbid-mainnet` without GO.
