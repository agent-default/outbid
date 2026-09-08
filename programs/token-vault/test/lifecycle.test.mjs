import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AccountRole as Role, generateKeyPairSigner } from "@solana/kit";
import { startSurfpool } from "./surfpool.mjs";
import {
  ATOMIC, COOLDOWN, MINT, PROGRAM, SYSTEM, TOKEN, account, balance, clock,
  deploy, fixture, putAccount, putMint, putTokens, travel,
} from "./fixture.mjs";

describe("vault lifecycle", { concurrency: 1, timeout: 60_000 }, () => {
let runtime;
let rpc;
before(async () => {
  runtime = await startSurfpool();
  rpc = runtime.rpc;
  await deploy(rpc);
}, { timeout: 30_000 });
after(async () => { await runtime?.stop(); });

test("wrong-mint deposits cannot buy capacity", async () => {
  const other = await generateKeyPairSigner();
  await putMint(rpc, other.address);
  const f = await fixture(rpc, other.address);
  await f.rejects(f.ix(0, 1_000n * ATOMIC), /Custom":0/);
});

test("withdrawal returns the deposit at the cooldown deadline", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  await f.send(f.ix(2));
  await travel(rpc, (await f.read()).unbond + COOLDOWN);
  await f.send(f.ix(3));
  assert.equal(await balance(rpc, f.source), f.supply);
  assert.equal(await balance(rpc, f.vault), 0n);
});

test("lock and top-up retain one authoritative window start", async () => {
  const f = await fixture(rpc);
  const start = await clock(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const first = await f.read();
  assert.deepEqual(first, {
    amount: 1_000n * ATOMIC, cap: 100n, unbond: 0,
    wallets: 1, qps: 0, hours: 24, version: 1, time: start,
  });
  assert.equal(await balance(rpc, f.source), f.supply - 1_000n * ATOMIC);
  assert.equal(await balance(rpc, f.vault), 1_000n * ATOMIC);
  await travel(rpc, start + 60);
  await f.send(f.ix(0, 9_000n * ATOMIC));
  const second = await f.read();
  assert.equal(second.time, first.time);
  assert.equal(second.amount, 10_000n * ATOMIC);
  assert.equal(second.cap, 1_000n);
  assert.equal(second.hours, 72);
  assert.equal(second.wallets, 5);
});

test("unbond, exact cooldown, withdrawal, and fresh lock", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const locked = await f.read();
  await f.send(f.ix(2));
  const unbonded = await f.read();
  assert.equal(unbonded.amount, 1_000n * ATOMIC);
  assert.equal(unbonded.wallets, 0);
  assert.equal(unbonded.cap, 0n);
  assert.equal(unbonded.hours, 0);
  assert.equal(unbonded.time, locked.time);
  assert.ok(unbonded.unbond >= locked.time);
  await f.rejects(f.ix(2), /Custom":2/);
  await f.rejects(f.ix(0, ATOMIC), /Custom":2/);
  await f.rejects(f.ix(3), /Custom":4/);
  await travel(rpc, unbonded.unbond + COOLDOWN - 1);
  await f.rejects(f.ix(3), /Custom":4/);
  await travel(rpc, unbonded.unbond + COOLDOWN);
  await f.rejects(f.ix(0, ATOMIC), /Custom":2/);
  const rent = (await account(rpc, f.pda)).lamports;
  await f.send(f.ix(3));
  assert.equal(await balance(rpc, f.source), f.supply);
  assert.equal(await balance(rpc, f.vault), 0n);
  assert.equal((await account(rpc, f.pda)).lamports, rent);
  const empty = await f.read();
  assert.equal(empty.amount, 0n);
  assert.equal(empty.time, 0);
  assert.equal(empty.wallets, 0);
  await f.rejects(f.ix(3), /Custom":5/);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const fresh = await f.read();
  assert.ok(fresh.time > unbonded.unbond);
  assert.equal(fresh.unbond, 0);
  assert.equal(fresh.wallets, 1);
});

test("missing signer and another locker's PDA are rejected", async () => {
  const f = await fixture(rpc);
  const stranger = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  for (const tag of [0, 2, 3]) {
    const ix = f.ix(tag, ATOMIC);
    ix.accounts[0].role = Role.WRITABLE;
    await f.rejects(ix, /MissingRequiredSignature/, stranger.locker);
  }
  for (const tag of [0, 1, 2, 3]) {
    const ix = f.ix(tag, ATOMIC);
    ix.accounts[tag === 1 || tag === 2 ? 1 : 2].address = stranger.pda;
    await f.rejects(ix, /InvalidSeeds/);
  }
});

test("missing, foreign-owned, old, and malformed lock accounts fail closed", async () => {
  const f = await fixture(rpc);
  await f.rejects(f.ix(1), /IncorrectProgramId/);
  const forged = Buffer.alloc(32);
  forged.writeBigUInt64LE(1_000n * ATOMIC);
  forged.writeBigInt64LE(BigInt(await clock(rpc)), 16);
  forged[24] = 1;
  await putAccount(rpc, f.pda, SYSTEM, forged);
  for (const tag of [0, 1, 2, 3]) {
    await f.rejects(f.ix(tag, ATOMIC), /IncorrectProgramId/);
  }
  for (const data of [Buffer.alloc(16), Buffer.alloc(32), Buffer.concat([forged, Buffer.alloc(1)])]) {
    await putAccount(rpc, f.pda, PROGRAM, data);
    for (const tag of [0, 1, 2, 3]) {
      await f.rejects(f.ix(tag, ATOMIC), /InvalidAccountData/);
    }
  }
});

test("mint, token program, accounts, and instruction shapes are checked", async () => {
  const f = await fixture(rpc);
  const other = await fixture(rpc);
  for (const index of [5, 6, 7]) {
    const ix = f.ix(0, ATOMIC);
    ix.accounts[index].address = other.locker.address;
    await f.rejects(ix, /IncorrectProgramId/);
  }
  for (const index of [1, 3]) {
    const ix = f.ix(0, ATOMIC);
    ix.accounts[index].address = index === 1 ? other.source : other.vault;
    await f.rejects(ix, /InvalidSeeds/);
  }
  for (const index of [1, 2, 3]) {
    const ix = f.ix(0, ATOMIC);
    ix.accounts[index].role = Role.READONLY;
    await f.rejects(ix, /InvalidAccountData/);
  }
  await f.rejects(f.ix(0, 0n), /InvalidInstructionData/);
  for (const data of [Buffer.alloc(0), Buffer.from([9]), Buffer.from([0, 1]), Buffer.from([1, 0])]) {
    await f.rejects({ ...f.ix(0, ATOMIC), data }, /InvalidInstructionData/);
  }
  const original = await account(rpc, MINT);
  try {
    const data = Buffer.from(original.data[0], "base64");
    data[44] = 9;
    await putAccount(rpc, MINT, TOKEN, data);
    await f.rejects(f.ix(0, ATOMIC), /Custom":0/);
    await putAccount(rpc, MINT, SYSTEM, data);
    await f.rejects(f.ix(0, ATOMIC), /IncorrectProgramId/);
  } finally {
    await putMint(rpc);
  }
});

test("failed token transfer rolls back newly created lock and vault", async () => {
  const f = await fixture(rpc);
  await f.rejects(f.ix(0, f.supply + 1n), /Custom":1/);
  assert.equal(await account(rpc, f.pda), null);
  assert.equal(await account(rpc, f.vault), null);
});

test("prefunded PDA and ATA cannot block locking", async () => {
  const f = await fixture(rpc);
  await putAccount(rpc, f.pda, SYSTEM, Buffer.alloc(0), 1_000_000);
  await putAccount(rpc, f.vault, SYSTEM, Buffer.alloc(0), 1_000_000);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  assert.equal((await f.read()).amount, 1_000n * ATOMIC);
});

test("overflow and future lock times do not transfer tokens", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const data = Buffer.from((await account(rpc, f.pda)).data[0], "base64");
  data.writeBigUInt64LE((1n << 64n) - 1n);
  await putAccount(rpc, f.pda, PROGRAM, data);
  await f.rejects(f.ix(0, 1n), /ArithmeticOverflow/);
  data.writeBigUInt64LE(1_000n * ATOMIC);
  data.writeBigInt64LE(BigInt(await clock(rpc)) + 100n, 16);
  await putAccount(rpc, f.pda, PROGRAM, data);
  await f.rejects(f.ix(0, ATOMIC), /Custom":6/);
  await f.rejects(f.ix(2), /Custom":6/);
});

test("invalid token ownership and vault delegates fail closed", async () => {
  const f = await fixture(rpc);
  const stranger = await fixture(rpc);
  await putTokens(rpc, f.source, stranger.locker.address, f.supply);
  await f.rejects(f.ix(0, ATOMIC), /Custom":1/);
  await putTokens(rpc, f.source, f.locker.address, f.supply);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const data = Buffer.from((await account(rpc, f.vault)).data[0], "base64");
  data.writeUInt32LE(1, 72);
  await putAccount(rpc, f.vault, TOKEN, data);
  await f.rejects(f.ix(0, ATOMIC), /Custom":1/);
  await f.send(f.ix(2));
  await travel(rpc, (await f.read()).unbond + COOLDOWN);
  await f.rejects(f.ix(3), /Custom":1/);
});

test("withdrawal failure preserves the claim and recreates a closed destination ATA", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, f.supply));
  await f.rejects(f.ix(3), /Custom":3/);
  await f.send(f.ix(2));
  await travel(rpc, (await f.read()).unbond + COOLDOWN);
  await putTokens(rpc, f.vault, f.pda, 0n);
  await f.rejects(f.ix(3), /Custom":1/);
  assert.equal((await f.read()).amount, f.supply);
  await putTokens(rpc, f.vault, f.pda, f.supply);
  await putAccount(rpc, f.source, SYSTEM, Buffer.alloc(0), 0);
  await f.send(f.ix(3));
  assert.equal(await balance(rpc, f.source), f.supply);
  assert.equal((await f.read()).amount, 0n);
});

test("dust and tier boundaries, donations, and expiry retain the same lock record", async () => {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 999n * ATOMIC + ATOMIC - 1n));
  const dust = await f.read();
  assert.equal(dust.wallets, 0);
  await f.send(f.ix(0, 1n));
  const first = await f.read();
  assert.equal(first.wallets, 1);
  assert.equal(first.time, dust.time);
  await travel(rpc, first.time + 24 * 3600);
  const expired = await f.read();
  assert.equal(expired.time, first.time);
  assert.equal(await clock(rpc), expired.time + expired.hours * 3600);
  // The client must zero an expired grant; the vault returns its original window.
  await putTokens(rpc, f.vault, f.pda, 2_000n * ATOMIC);
  assert.equal((await f.read()).amount, 1_000n * ATOMIC);
  await f.send(f.ix(0, 99_000n * ATOMIC));
  const third = await f.read();
  assert.equal(third.time, first.time);
  assert.equal(third.wallets, 25);
  assert.equal(third.cap, 10_000n);
  assert.equal(third.hours, 168);
  await f.send(f.ix(2));
  const unbond = await f.read();
  await travel(rpc, unbond.unbond + COOLDOWN);
  const sourceBefore = await balance(rpc, f.source);
  const vaultBefore = await balance(rpc, f.vault);
  await f.send(f.ix(3));
  assert.equal(await balance(rpc, f.source), sourceBefore + unbond.amount);
  assert.equal(await balance(rpc, f.vault), vaultBefore - unbond.amount);
  assert.ok((await balance(rpc, f.vault)) > 0n);
});
});
