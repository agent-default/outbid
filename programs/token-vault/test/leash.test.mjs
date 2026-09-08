// The client leash read against the deployed program. Proves the JS tier
// table and decoder agree with on-chain get_lock, so src/leash cannot drift
// from programs/token-vault/src/grant.rs unnoticed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  MemoryJournal, PROGRAM_ID, createLeash, deriveLockPda, grantFromLock, readLock,
} from "../../../src/leash/index.mjs";
import { startSurfpool } from "./surfpool.mjs";
import { ATOMIC, COOLDOWN, PROGRAM, clock, deploy, fixture, travel } from "./fixture.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
let runtime;
let rpc;

before(async () => {
  runtime = await startSurfpool();
  rpc = runtime.rpc;
  await deploy(rpc);
});
after(async () => { await runtime?.stop(); });

test("the client derives the same PDA as the program", async () => {
  const f = await fixture(rpc);
  assert.equal(PROGRAM_ID, PROGRAM);
  assert.equal(await deriveLockPda(f.locker.address), f.pda);
});

test("client grant matches on-chain get_lock at every tier boundary", async () => {
  for (const whole of [999n, 1_000n, 9_999n, 10_000n, 99_999n, 100_000n]) {
    const f = await fixture(rpc);
    await f.send(f.ix(0, whole * ATOMIC));
    const onChain = await f.read();
    const { state, grant } = await readLock(rpc, f.locker.address);
    assert.equal(state.amount, onChain.amount, `amount at ${whole}`);
    assert.equal(state.lockTime, onChain.time, `lock_time at ${whole}`);
    assert.equal(state.unbondTs, onChain.unbond, `unbond at ${whole}`);
    assert.deepEqual(
      [grant.wallets, Number(grant.capUsd), grant.windowH, grant.qps],
      [onChain.wallets, Number(onChain.cap), onChain.hours, onChain.qps],
      `grant at ${whole}`,
    );
    assert.deepEqual(grantFromLock(onChain.amount, onChain.unbond).capUsd, grant.capUsd);
  }
});

test("client read fails closed when no lock account exists", async () => {
  const f = await fixture(rpc);
  await assert.rejects(readLock(rpc, f.locker.address), /no lock account/);
});

test("a real lock authorizes spend up to the on-chain cap", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const journal = new MemoryJournal();
  const agent = f.locker.address;
  const leash = createLeash({
    rpc, journal, roster: async () => [agent], now: () => Date.now() / 1000 | 0,
  });
  const pay = (amount) => leash.beforePayment({ locker: f.locker.address, agent, amount, asset: USDC });

  const first = await pay(99_000_000n);
  assert.equal(first.ok, true);
  assert.equal(first.cap, 100_000_000n, "tier 1 cap is $100 of atomic USDC");
  assert.equal(first.windowStart, await clock(rpc));
  leash.afterSettle(first, "sig1");
  assert.equal((await pay(2_000_000n)).code, "cap_exceeded");
  assert.equal((await pay(1_000_000n)).ok, true);
});

test("a top-up raises the on-chain cap the client enforces", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const agent = f.locker.address;
  const leash = createLeash({
    rpc, journal: new MemoryJournal(), roster: async () => [agent], now: () => Date.now() / 1000 | 0,
  });
  const pay = (amount) => leash.beforePayment({ locker: f.locker.address, agent, amount, asset: USDC });
  assert.equal((await pay(500_000_000n)).code, "cap_exceeded");
  await f.send(f.ix(0, 9_000n * ATOMIC));
  const raised = await pay(500_000_000n);
  assert.equal(raised.ok, true);
  assert.equal(raised.cap, 1_000_000_000n, "tier 2 cap is $1,000");
});

test("start_unbond refuses the next signature immediately", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const agent = f.locker.address;
  const leash = createLeash({
    rpc, journal: new MemoryJournal(), roster: async () => [agent], now: () => Date.now() / 1000 | 0,
  });
  const pay = () => leash.beforePayment({ locker: f.locker.address, agent, amount: 1_000_000n, asset: USDC });
  assert.equal((await pay()).ok, true);
  await f.send(f.ix(2));
  assert.equal((await pay()).code, "unbonded", "the grant is gone before the cooldown, not after");
  await travel(rpc, (await clock(rpc)) + COOLDOWN);
  assert.equal((await pay()).code, "unbonded");
  await f.send(f.ix(3));
  assert.equal((await pay()).code, "no_grant", "a withdrawn lock authorizes nothing");
});

test("an expired window refuses even though the lock still holds tokens", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const agent = f.locker.address;
  const start = await clock(rpc);
  let now = start;
  const leash = createLeash({
    rpc, journal: new MemoryJournal(), roster: async () => [agent], now: () => now,
  });
  const pay = () => leash.beforePayment({ locker: f.locker.address, agent, amount: 1_000_000n, asset: USDC });
  assert.equal((await pay()).ok, true);
  now = start + 24 * 3600 - 1;
  assert.equal((await pay()).ok, true);
  now = start + 24 * 3600;
  assert.equal((await pay()).code, "window_closed");

  // A same-tier top-up does not reopen an expired window.
  await f.send(f.ix(0, 1_000n * ATOMIC));
  assert.equal((await pay()).code, "window_closed");
  assert.equal((await readLock(rpc, f.locker.address)).state.lockTime, start);

  // A higher tier extends the deadline from the original start; it does not
  // reset it. The client measures the new window from the same lock_time.
  await f.send(f.ix(0, 98_000n * ATOMIC));
  const raised = await pay();
  assert.equal(raised.ok, true);
  assert.equal(raised.windowStart, start, "the window start is never reset by a top-up");
  assert.equal(raised.windowEnd, start + 168 * 3600);
  now = start + 168 * 3600;
  assert.equal((await pay()).code, "window_closed");
});
