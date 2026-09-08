# TWZRD lock vault

Local implementation. No mainnet mint or deployment is authorized by this
increment. APIs still settle in USDC; this program records token capacity.

Program: `4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB`.
Bound mint: `PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3`, classic SPL,
6 decimals. Changing that candidate requires rebuilding and retesting.

## Validate locally

From the repository root, install the pinned JavaScript dependencies with
`npm ci`. Rust, Solana's `cargo-build-sbf`, and Surfpool must be installed.
Then run:

```sh
node programs/token-vault/scripts/e2e-lock.mjs
```

The command checks formatting, runs Rust tests, builds the SBF artifact,
and runs the Node tests against a fresh offline Surfpool process. It uses
disposable in-memory signers, loopback ports, and a temporary working
directory. It never reads the board or token wallet stores. `RPC_URL` is
rejected. No existing validator is reused or reset. Only the child process
created by the test is stopped.

The SVM tests execute the compiled `.so` with token CPIs and transaction
signature checks. Cheatcodes provision test accounts, load that artifact,
and advance time; they do not implement the lock, unbond, or withdrawal.
The fixed mint address is an offline account fixture, not a live mint.
Surfpool RPC reference: [cheatcodes](https://solana.com/docs/tools/surfpool/rpc/cheatcodes).

## Instructions

Integer fields are little-endian. Trailing instruction bytes are rejected.

| Tag | Data | Accounts, in order |
|---|---|---|
| 0: lock | tag u8, amount u64 in atomic tokens | locker, locker ATA, lock PDA, vault ATA, mint, Tokenkeg, System, ATA program |
| 1: get_lock | tag u8 | locker, lock PDA |
| 2: start_unbond | tag u8 | locker, lock PDA |
| 3: withdraw | tag u8 | Same eight accounts as lock |

For lock/withdraw, locker is writable and must sign; locker ATA, lock PDA,
and vault ATA are writable. The remaining accounts are read-only.
Start-unbond requires locker signature and a writable lock PDA. Reads
require no signature. No delegation in v0.

PDA seeds are `[b"lock", locker_pubkey]`. Both token accounts must be the
canonical Tokenkeg ATAs for their owner and the bound mint. Lock creates
the PDA and vault ATA as needed, including when prefunded with SOL.
Withdrawal recreates a closed locker ATA at the locker's expense.

## State and read contract

This version rejects the old 16-byte local stub state. There is no deployed
state migration in this increment; reset old local fixtures before use.

| Account offset | Type | Value |
|---|---|---|
| 0 | u64 | Recorded amount, atomic tokens |
| 8 | i64 | Unbond timestamp, Unix seconds; 0 when active |
| 16 | i64 | Lock/window start, Unix seconds; 0 when empty |
| 24 | u8 | Version = 1 |
| 25 | 7 bytes | Reserved, all zero |

`get_lock` returns exactly 40 bytes:

| Offset | Type | Value |
|---|---|---|
| 0 | u64 | Amount, atomic tokens |
| 8 | u64 | Cap, whole USDC dollars |
| 16 | i64 | Unbond timestamp |
| 24 | u16 | Wallet count |
| 26 | u16 | QPS, 0 = unbound |
| 28 | u16 | Window length, hours |
| 30 | u8 | Version = 1 |
| 31 | u8 | Reserved, 0 |
| 32 | i64 | Lock/window start, Unix seconds |

Clients must verify the program/PDA, account ownership, data length,
version, and return-data program ID. Missing or malformed state is an
error, not an active grant. `locked_whole = amount / 1_000_000`, rounded
down. Do not decode a u64 through a JavaScript Number.

## Lifecycle

The first positive deposit starts the window, including a deposit below
the minimum tier. Top-ups retain that timestamp. The highest recorded
tier determines cap, wallet count, and window length. A higher tier can
extend the deadline measured from the same start, but never resets spend
tallies. A top-up after expiry is not a new window; the client evaluates
the new tier's deadline against the original start.

`get_lock` reports the recorded tier and its window even after expiry.
The paying client must require
`lock_time <= now < lock_time + window_h * 3600`, check wallet membership,
and enforce its USDC tally. Those client checks are not implemented here.

Start-unbond immediately returns the zero grant while retaining the amount
and original window timestamp. Repeated unbond and all top-ups during
unbond are rejected, including after the cooldown. Withdraw returns the
entire recorded amount at or after `unbond_ts + 86_400`. It zeroes the
record without closing the PDA or refunding rent. Repeated withdrawal is
rejected. A subsequent positive lock starts a fresh window.

Direct token transfers into the vault do not buy capacity. Only amounts
credited through lock are returned by withdraw; unsolicited excess tokens
remain uncredited. There is no sweep instruction in v0.

## Errors

| Custom code | Meaning |
|---|---|
| 0 | Wrong mint or decimals |
| 1 | Invalid token account ownership, state, or vault authority |
| 2 | Unbond already started |
| 3 | Withdrawal requested before starting unbond |
| 4 | Cooldown not elapsed |
| 5 | Empty lock |
| 6 | Invalid or regressed clock |

Other failures use standard program errors or propagate CPI errors.
Error origin matters: SPL Token can return the same numeric custom code.

Tests cover the mint restriction, tiers, time retention, immediate grant
removal, cooldown boundary, return/relock, signatures, substituted PDAs,
state ownership/version, instruction shape, token authorities, prefunded
accounts, overflow, CPI rollback, and destination ATA recreation. Runner
tests cover remote-URL rejection, redirects, and confirmation failures.

Passing this local gate does not prove mainnet readiness, mint authority
revocation, metadata availability, or client-side payment enforcement.
