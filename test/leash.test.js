import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ATOMIC, wrapSigner, FileJournal, MINT, MemoryJournal, PROGRAM_ID, STATE_LEN,
  createLeash, decodeLockState, deriveLockPda, grantFromLock,
} from "../src/leash/index.mjs";

const LOCKER = "8otvwgJ28HyQNc7mBSxtt4DWeqU1BwmQQLkFmhHE6yZP";
const AGENT = "BmAqWFJDzbaL6cuE5rC8BB4YJkTwFoH1cYTvLovz1f4w";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function state({ amount = 1_000n * ATOMIC, unbondTs = 0, lockTime = 1_000 }) {
  const data = Buffer.alloc(STATE_LEN);
  data.writeBigUInt64LE(amount, 0);
  data.writeBigInt64LE(BigInt(unbondTs), 8);
  data.writeBigInt64LE(BigInt(lockTime), 16);
  data[24] = 1;
  return data;
}

function rpcFor(data, { owner = PROGRAM_ID, missing = false, throws = false } = {}) {
  return async () => {
    if (throws) throw new Error("connection refused");
    if (missing) return { value: null };
    return { value: { owner, data: [data.toString("base64"), "base64"] } };
  };
}

const leashFor = (data, opts = {}) => createLeash({
  rpc: rpcFor(data, opts),
  journal: opts.journal ?? new MemoryJournal(),
  roster: opts.roster ?? (async () => [AGENT]),
  now: opts.now ?? (() => 1_100),
});

test("tier table matches the lock table", () => {
  const cases = [
    [0n, 0, 0n, 0], [999n, 0, 0n, 0], [1_000n, 1, 100n, 24],
    [9_999n, 1, 100n, 24], [10_000n, 5, 1_000n, 72],
    [99_999n, 5, 1_000n, 72], [100_000n, 25, 10_000n, 168],
  ];
  for (const [whole, wallets, capUsd, windowH] of cases) {
    const g = grantFromLock(whole * ATOMIC, 0);
    assert.deepEqual([g.wallets, g.capUsd, g.windowH, g.qps], [wallets, capUsd, windowH, 0]);
  }
  const unbonded = grantFromLock(100_000n * ATOMIC, 5);
  assert.deepEqual([unbonded.wallets, unbonded.capUsd, unbonded.windowH], [0, 0n, 0]);
});

test("state decoding rejects malformed accounts", () => {
  assert.deepEqual(decodeLockState(state({})), {
    amount: 1_000n * ATOMIC, unbondTs: 0, lockTime: 1_000,
  });
  const short = state({}).subarray(0, 31);
  assert.throws(() => decodeLockState(short), /wrong length/);
  const badVersion = state({});
  badVersion[24] = 2;
  assert.throws(() => decodeLockState(badVersion), /wrong version/);
  const reserved = state({});
  reserved[31] = 1;
  assert.throws(() => decodeLockState(reserved), /reserved bytes/);
  assert.throws(() => decodeLockState(state({ amount: 0n, lockTime: 5 })), /empty with times/);
  assert.throws(() => decodeLockState(state({ lockTime: 0 })), /bad times/);
  assert.throws(() => decodeLockState(state({ lockTime: 10, unbondTs: 5 })), /bad times/);
});

test("PDA derivation is stable and locker-specific", async () => {
  const a = await deriveLockPda(LOCKER);
  assert.equal(a, await deriveLockPda(LOCKER));
  assert.notEqual(a, await deriveLockPda(AGENT));
});

test("a funded, in-window, in-roster payment is allowed", async () => {
  const leash = leashFor(state({}));
  const decision = await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 10_000_000n, asset: USDC,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.windowStart, 1_000);
  assert.equal(decision.windowEnd, 1_000 + 24 * 3600);
  assert.equal(decision.cap, 100_000_000n);
  assert.equal(decision.remaining, 90_000_000n);
});

test("missing evidence refuses to sign", async () => {
  const cases = [
    [{ missing: true }, "no_lock"],
    [{ throws: true }, "no_lock"],
    [{ owner: "11111111111111111111111111111111" }, "no_lock"],
    [{ roster: async () => { throw new Error("no file"); } }, "roster_unreadable"],
    [{ roster: async () => "not-an-array" }, "roster_unreadable"],
    [{ journal: { spent() { throw new Error("corrupt"); } } }, "tally_unreadable"],
  ];
  for (const [opts, code] of cases) {
    const decision = await leashFor(state({}), opts)
      .beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, code);
  }
});

test("unbond, window, tier, and roster denials", async () => {
  const cases = [
    [state({ unbondTs: 1_050 }), {}, "unbonded"],
    [state({ amount: 999n * ATOMIC }), {}, "no_grant"],
    [state({ amount: 0n, lockTime: 0 }), {}, "no_grant"],
    [state({}), { now: () => 999 }, "window_not_open"],
    [state({}), { now: () => 1_000 + 24 * 3600 }, "window_closed"],
    [state({}), { roster: async () => [] }, "agent_not_in_roster"],
    [state({}), { roster: async () => [LOCKER] }, "agent_not_in_roster"],
    [state({}), { roster: async () => [AGENT, LOCKER] }, "roster_too_large"],
  ];
  for (const [data, opts, code] of cases) {
    const decision = await leashFor(data, opts)
      .beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC });
    assert.equal(decision.ok, false, code);
    assert.equal(decision.code, code);
  }
});

test("the window boundary is open at the start and closed at the end", async () => {
  const at = async (now) => (await leashFor(state({}), { now: () => now })
    .beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC })).ok;
  assert.equal(await at(1_000), true);
  assert.equal(await at(1_000 + 24 * 3600 - 1), true);
  assert.equal(await at(1_000 + 24 * 3600), false);
});

test("TWZRD is never accepted as the 402 asset", async () => {
  const decision = await leashFor(state({}))
    .beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: MINT });
  assert.equal(decision.code, "twzrd_as_asset");
});

test("amounts must be positive atomic BigInts", async () => {
  for (const amount of [0n, -1n, 1, "1", 1.5, undefined]) {
    const decision = await leashFor(state({}))
      .beforePayment({ locker: LOCKER, agent: AGENT, amount, asset: USDC });
    assert.equal(decision.code, "bad_amount");
  }
});

test("the cap is enforced across the window and settles are recorded", async () => {
  const journal = new MemoryJournal();
  const leash = leashFor(state({}), { journal });
  const spend = async (amount, id) => {
    const decision = await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount, asset: USDC });
    if (decision.ok) leash.afterSettle(decision, id);
    return decision;
  };
  assert.equal((await spend(60_000_000n, "sig1")).ok, true);
  assert.equal(journal.spent(LOCKER, 1_000), 60_000_000n);
  const over = await spend(40_000_001n, "sig2");
  assert.equal(over.code, "cap_exceeded");
  assert.equal(over.remaining, 40_000_000n);
  assert.equal(journal.spent(LOCKER, 1_000), 60_000_000n, "a refusal records nothing");
  assert.equal((await spend(40_000_000n, "sig3")).ok, true, "the cap boundary is spendable");
  assert.equal((await spend(1n, "sig4")).code, "cap_exceeded");
});

test("the cap is shared by every agent under one locker", async () => {
  const journal = new MemoryJournal();
  const leash = leashFor(state({ amount: 10_000n * ATOMIC }), {
    journal, roster: async () => [AGENT, LOCKER],
  });
  const first = await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 900_000_000n, asset: USDC });
  leash.afterSettle(first, "sig1");
  const second = await leash.beforePayment({ locker: LOCKER, agent: LOCKER, amount: 200_000_000n, asset: USDC });
  assert.equal(second.code, "cap_exceeded");
  assert.equal(journal.spentByAgent(LOCKER, 1_000, AGENT), 900_000_000n);
  assert.equal(journal.spentByAgent(LOCKER, 1_000, LOCKER), 0n);
});

test("a fresh window starts a fresh tally", async () => {
  const journal = new MemoryJournal();
  const spent = async (lockTime) => {
    const leash = leashFor(state({ lockTime }), { journal, now: () => lockTime + 10 });
    const decision = await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC });
    if (decision.ok) leash.afterSettle(decision, `sig-${lockTime}`);
    return decision;
  };
  assert.equal((await spent(1_000)).ok, true);
  assert.equal((await spent(500_000)).ok, true);
  assert.equal(journal.spent(LOCKER, 1_000), 100_000_000n);
  assert.equal(journal.spent(LOCKER, 500_000), 100_000_000n);
});

test("settles are idempotent on the signature", async () => {
  const journal = new MemoryJournal();
  const leash = leashFor(state({}), { journal });
  const decision = await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 1_000_000n, asset: USDC });
  assert.equal(leash.afterSettle(decision, "sig1"), true);
  assert.equal(leash.afterSettle(decision, "sig1"), false, "a replayed signature is not double-counted");
  assert.equal(journal.spent(LOCKER, 1_000), 1_000_000n);
  assert.throws(() => leash.afterSettle({ ok: false }, "sig2"), /not an approval/);
  assert.throws(() => leash.afterSettle(decision, ""), /id is required/);
});

test("the file journal survives a restart and refuses a corrupt tally", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "journal.json");
  new FileJournal(file).record({ locker: LOCKER, windowStart: 1_000, agent: AGENT, amount: 7n, id: "sig1" });
  assert.equal(new FileJournal(file).spent(LOCKER, 1_000), 7n, "spend survives a new process");
  assert.equal(new FileJournal(file).record({ locker: LOCKER, windowStart: 1_000, agent: AGENT, amount: 7n, id: "sig1" }), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new FileJournal(path.join(dir, "absent.json")).spent(LOCKER, 1_000), 0n);
  fs.writeFileSync(file, "{ not json");
  const leash = leashFor(state({}), { journal: new FileJournal(file) });
  const decision = await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC });
  assert.equal(decision.code, "tally_unreadable", "a corrupt tally must not read as zero spend");
});

test("the preflight example runs and refuses more than it signs", () => {
  const demo = spawnSync(process.execPath, ["scripts/simulate-x402-preflight.mjs"], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(demo.status, 0, demo.stderr);
  for (const code of [
    "no_lock", "cap_exceeded", "twzrd_as_asset",
    "agent_not_in_roster", "unbonded", "window_closed",
  ]) {
    assert.match(demo.stdout, new RegExp(code), `example must demonstrate ${code}`);
  }
  assert.match(demo.stdout, /signed 6 payments, refused 8\./);
});

// --- reservations: the gap between beforePayment and afterSettle ------------

test("concurrent approvals cannot jointly exceed the cap", async () => {
  const leash = leashFor(state({}));
  const pay = () => leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 60_000_000n, asset: USDC,
  });
  // Both are decided before either settles. Without reservations both clear.
  const [first, second] = await Promise.all([pay(), pay()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, "the second in-flight approval must not clear the cap");
  assert.equal(second.code, "cap_exceeded");
  assert.equal(second.inFlight, 60_000_000n);
  assert.match(second.reason, /in flight/);
  assert.equal(leash.pending(LOCKER, 1_000), 60_000_000n);
});

test("a settled payment converts its reservation into tally, not double-count", async () => {
  const journal = new MemoryJournal();
  const leash = leashFor(state({}), { journal });
  const decision = await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 40_000_000n, asset: USDC,
  });
  assert.equal(leash.pending(LOCKER, 1_000), 40_000_000n);
  leash.afterSettle(decision, "sig1");
  assert.equal(leash.pending(LOCKER, 1_000), 0n, "settling frees the reservation");
  assert.equal(journal.spent(LOCKER, 1_000), 40_000_000n);
  const next = await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 60_000_000n, asset: USDC,
  });
  assert.equal(next.ok, true, "the settled amount is counted once, not twice");
  assert.equal(next.spent, 40_000_000n);
  assert.equal(next.inFlight, 0n);
});

test("release frees cap for an approval that will never settle", async () => {
  const leash = leashFor(state({}));
  const decision = await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC,
  });
  assert.equal((await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC,
  })).code, "cap_exceeded");
  assert.equal(leash.release(decision), true);
  assert.equal(leash.pending(LOCKER, 1_000), 0n);
  assert.equal((await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC,
  })).ok, true);
  assert.equal(leash.release(decision), false, "releasing twice is not an error but frees nothing");
  assert.throws(() => leash.release({ ok: false }), /not an approval/);
});

test("an abandoned reservation expires instead of holding cap forever", async () => {
  let clock = 1_100;
  const leash = leashFor(state({}), { now: () => clock });
  await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC });
  clock += 119;
  assert.equal((await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC,
  })).code, "cap_exceeded", "still held before the TTL");
  clock += 1;
  assert.equal(leash.pending(LOCKER, 1_000), 0n);
  assert.equal((await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC,
  })).ok, true, "an abandoned attempt does not strand the cap");
});

test("reservations are per window, not global", async () => {
  const leash = leashFor(state({}));
  await leash.beforePayment({ locker: LOCKER, agent: AGENT, amount: 100_000_000n, asset: USDC });
  assert.equal(leash.pending(LOCKER, 1_000), 100_000_000n);
  assert.equal(leash.pending(LOCKER, 500_000), 0n);
  assert.equal(leash.pending(AGENT, 1_000), 0n);
});

test("a failed sign or broadcast hands the cap back immediately", async () => {
  const leash = leashFor(state({}));
  const inner = {
    address: AGENT,
    signTransaction: async (tx) => { if (tx === "bad-sign") throw new Error("key locked"); return `signed:${tx}`; },
    sendTransaction: async () => { throw new Error("broadcast refused"); },
  };
  const wrapped = wrapSigner(inner, leash, { locker: LOCKER });
  const pay = { amount: 100_000_000n, asset: USDC, transaction: "tx1" };

  await assert.rejects(() => wrapped.sendPayment(pay), /broadcast refused/);
  assert.equal(leash.pending(LOCKER, 1_000), 0n, "a failed broadcast must not hold the cap");
  await assert.rejects(
    () => wrapped.signPayment({ ...pay, transaction: "bad-sign" }), /key locked/,
  );
  assert.equal(leash.pending(LOCKER, 1_000), 0n, "a failed signature must not hold the cap");

  // The cap is fully available again after both failures.
  const { decision } = await wrapped.signPayment(pay);
  assert.equal(decision.ok, true);
  assert.equal(leash.pending(LOCKER, 1_000), 100_000_000n);
  wrapped.release(decision);
  assert.equal(leash.pending(LOCKER, 1_000), 0n);
});

test("FileJournal holds survive a new process on the same file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-hold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "journal.json");
  const first = leashFor(state({}), { journal: new FileJournal(file) });
  const decision = await first.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 60_000_000n, asset: USDC,
  });
  assert.equal(decision.ok, true);
  const second = leashFor(state({}), { journal: new FileJournal(file) });
  const over = await second.beforePayment({
    locker: LOCKER, agent: AGENT, amount: 60_000_000n, asset: USDC,
  });
  assert.equal(over.code, "cap_exceeded", "a restarted process must see the hold");
  assert.equal(second.pending(LOCKER, 1_000), 60_000_000n);
  second.release(decision);
  assert.equal(second.pending(LOCKER, 1_000), 0n);
});

test("two OS processes cannot both reserve past the cap", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leash-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "journal.json");
  const script = path.join(dir, "race.mjs");
  const journalUrl = new URL("../src/leash/journal.mjs", import.meta.url).href;
  fs.writeFileSync(script, `
    import { FileJournal } from ${JSON.stringify(journalUrl)};
    const j = new FileJournal(${JSON.stringify(file)});
    try {
      j.reserve({
        locker: ${JSON.stringify(LOCKER)},
        windowStart: 1000,
        agent: ${JSON.stringify(AGENT)},
        amount: 60_000_000n,
        cap: 100_000_000n,
        ttlMs: 60_000,
      });
      process.stdout.write("ok");
    } catch (e) {
      process.stdout.write(e.code === "cap_exceeded" ? "cap" : ("err:" + e.message));
    }
  `);
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [script]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(out.trim()));
  });
  const [a, b] = await Promise.all([run(), run()]);
  const results = [a, b].sort();
  assert.deepEqual(results, ["cap", "ok"], `race results: ${JSON.stringify([a, b])}`);
});
