# Evaluate the control without funds

No wallet. No signature. No settlement. No third-party request.

```bash
npx skills add agent-default/outbid   # or: git clone && cd outbid
node fixtures/run.mjs                 # exit 0 = every case matched
```

`cases.json` states the expected outcome of each case in machine-readable form.
`run.mjs` executes the same assessment code a live payer uses, against stubbed
evidence, and compares. It prints one JSON object and exits non-zero on any
mismatch, so an agent can gate on it without parsing prose.

## What a passing run proves

That the control enforces: a payment whose accepted terms differ from the
assessed challenge — price, payTo, network, asset (including an asset simply
omitted), or scheme — is refused before the request leaves the process, and a
re-issued challenge does not inherit the previous assessment. It also proves the
record keeps observed / decided / delivered distinct, and that attaching delivery
evidence later cannot rewrite what was observed or decided.

## What it does not prove

- **Nothing about any seller.** Fixture evidence is stubbed.
- **Nothing about delivery.** `delivery_proof` is `unverified` here and stays
  `unverified` in production until a paid check establishes it. This project has
  never verified delivery for a third-party endpoint.
- **Nothing about demand.** A passing run is integration success. It is not an
  external payment, and every run is tagged `fixture: true` so it can never be
  counted as adoption.

## Recovery: what the agent may do next

A verdict says whether to proceed. A structured failure says how to continue.
`recovery(outcomeOrError, { assessment, mandate })` maps what already happened
into one action from a closed set — `do_not_pay`, `reassess`, `refresh_evidence`,
`reconcile_settlement`, `wait_and_retry`, `stop_attempt`, `abort`,
`verify_delivery` — plus `paid`, `settlement`, `retry_same_terms`,
`needs_authority`, and an `unknown` array naming what could not be determined.

It adds no behaviour. Every input it reads is already produced by smart-fetch;
it stops the agent guessing which of them means "safe to try again".

The distinctions that cost money:

| Situation | paid | next |
|---|---|---|
| Terms changed before signing | `no` | `reassess` |
| Payment sent, answer lost | `maybe` | `reconcile_settlement` |
| Login wall | `no` | `stop_attempt`, needs authority |
| Bot gate | `no` | `stop_attempt`, no authority will help |
| Paid 200 returned | `yes` | `verify_delivery` — never "delivered" |
| Mandate allowance exhausted | — | `do_not_pay` |
| Failure we cannot classify | — | `abort`, with `unknown: ["failure_class"]` |

A refusal that never sent a request reports `settlement: "none"`, so an agent is
never sent to reconcile a payment that could not have happened; and a possible
settlement never yields `wait_and_retry`, so it is never told to pay twice.

## Then enable it under your own authority

The hook is off by default. Turn it on per call, with your wallet and your cap:

```js
const r = await smartFetch(url, { preflight: "twzrd" }, wallet);
r.twzrd            // the assessment(s) that authorized or capped each hop
```

`block` refuses unpaid. `warn` proceeds under the cap the evidence recommends.
An unreachable evidence source is recorded `unavailable` and never promoted to a
block. TWZRD never holds keys or funds and never signs.
