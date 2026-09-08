# leash — refuse before sign

Reference client-side gate for x402 payments made under a TWZRD lock.
Local module. It is not imported by `server.js` and adds no route to `:4024`.
`wrapSigner` calls an inner `signTransaction` only after the leash allows it.

Implements `beforePayment` / `afterSettle` from `graph/nodes/capacity.md`.

```js
import { FileJournal, FileRoster, createLeash, wrapSigner } from "outbid/leash";

const leash = createLeash({
  rpc,
  journal: new FileJournal("var/leash.json"),
  roster: new FileRoster("var/roster.json"),
});

const wrapped = wrapSigner(innerSigner, leash, { locker, agent });
const { signed, decision } = await wrapped.signPayment({ amount, asset, transaction });
// broadcast `signed`; only then:
wrapped.confirm(decision, settleSignature);
```

v0 roster is operator-configured. JSON map `locker pubkey → [agent pubkeys]`.
No locker→agent signature. `roster.length` must be `<= grant.wallets`.
A function `(locker) => string[]` is still accepted.

`amount` is atomic USDC (6 decimals) as a **BigInt**. No floats anywhere in
the money path. `asset` is the 402's asset; TWZRD is refused outright.

## What is checked

| # | Check | Source of truth |
|---|---|---|
| 1 | Lock exists, owned by the program, state v1 | chain, PDA `["lock", locker]` |
| 3 | `lock_time <= now < lock_time + window_h*3600` | chain |
| 4 | `unbond_ts == 0` | chain |
| 2 | agent ∈ roster, `roster.length <= grant.wallets` | operator `FileRoster` / `StaticRoster` |
| 5 | `spent + reserved + amount <= cap_usd` | client journal (holds persist) |

Numbering follows `capacity.md`. **Steps 6 and 7 are not implemented here:**
intel wash preflight (6) lives in another tree, and signer-invocation
counting (7) belongs to whatever holds the key. A caller that needs the full
list must add them; this module does not pretend to cover them.

## Fail closed

RPC error, absent account, foreign owner, malformed state, unreadable roster,
or unreadable tally all return `{ ok: false }`. A corrupt journal is an error,
never zero spend. There is no path that signs on missing evidence.

## Window and tally

The window is anchored to on-chain `lock_time` and sized by tier
(24h / 72h / 168h) — it is not a rolling 24h. Top-ups keep the same
`lock_time`; a higher tier extends the deadline from that original start and
never resets the tally. A new window exists only after withdraw and a fresh
lock, which yields a new `lock_time` and therefore a new journal key.

Journal keys are `(locker, window_start, agent)`. The **cap is the locker's**
and is shared by every agent under it; the per-agent split is kept for audit.
Records are idempotent on the settle signature, so a replay is not counted
twice. `FileJournal` writes `0600` via tmp+rename.

`beforePayment` **reserves** the amount in the journal until `afterSettle`
(`commit`) or `release` / TTL (default 120s). Two in-flight approvals cannot
jointly exceed the cap. Holds live in the journal file, so a restarted
process on the same file still sees them. `FileJournal` takes an exclusive
create lock around each read-modify-write so two OS processes cannot both
clear a joint over-cap. Two *different* journal files on the same locker can
still each spend the full cap. One locker, one journal.

## Reservations

An approval holds its amount against the cap until it settles. Without that,
two payments approved between the same journal read and write both clear a cap
they jointly exceed. `beforePayment` counts `spent + in-flight + this payment`,
and a denial reports `inFlight` alongside `spent`. Holds are journal state,
not an in-process Map.

A reservation ends three ways: `afterSettle` converts it to tally,
`release(decision)` hands it back (a failed signature or broadcast — `wrapSigner`
does this for you), or it expires after `reservationTtl` seconds (default 120)
so an abandoned attempt cannot strand the cap. `pending(locker, windowStart)`
reports what is currently held.

**In-process only.** Reservations live in the `createLeash` closure, not in the
journal. A second process against the same journal file still races, and so
does a second `createLeash` in the same process. One locker, one leash, one
process — the same constraint as the journal itself.

## Tier table drift

`TIERS` here duplicates `programs/token-vault/src/grant.rs`.
`programs/token-vault/test/leash.test.mjs` locks the two together against the
deployed program at every tier boundary. If you change one, that test fails.

## Entry points

`package.json` exports `outbid/leash`, `outbid/leash/lock`,
`outbid/leash/journal`, `outbid/leash/roster`, and `outbid/leash/signer`.
The package root is deliberately **not** exported: `.` would resolve to
`server.js`, and importing that starts a listener.

`wrapSigner` is not a drop-in `@solana/kit` `TransactionSigner`. The paying
client must pass the 402 `amount` and `asset` into `signPayment`. A failed
`sendPayment` broadcast does not consume cap. Sign-without-confirm also
does not consume cap — confirm only after settle succeeds.

## Run the example

```sh
npm run leash:demo        # node scripts/simulate-x402-preflight.mjs
```

Nine steps over one locker: no lock, a tier-1 lock spending inside $100, the
cap refusal, a top-up to tier 2 against the same window start, a seller
quoting TWZRD, an unlisted agent key, unbond killing capacity before the
cooldown, a fresh lock after withdraw, and window expiry. Six signed, eight
refused. The RPC is a stub the script encodes itself — it exercises the
decision path, not the chain read, and opens no socket.

## Tests

- `npm test` → `test/leash.test.js`, offline, stubbed RPC.
- `node programs/token-vault/scripts/e2e-lock.mjs` → the integration half,
  against the compiled program on a child Surfpool.

Passing both proves the gate's logic. `wrapSigner` is the local interceptor;
nothing in `server.js` or the live skill calls it yet.
