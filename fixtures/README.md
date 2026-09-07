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

## Then enable it under your own authority

The hook is off by default. Turn it on per call, with your wallet and your cap:

```js
const r = await smartFetch(url, { preflight: "twzrd" }, wallet);
r.twzrd            // the assessment(s) that authorized or capped each hop
```

`block` refuses unpaid. `warn` proceeds under the cap the evidence recommends.
An unreachable evidence source is recorded `unavailable` and never promoted to a
block. TWZRD never holds keys or funds and never signs.
