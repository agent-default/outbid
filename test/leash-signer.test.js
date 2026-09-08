import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ATOMIC, FileRoster, LeashDenied, MemoryJournal, PROGRAM_ID, STATE_LEN,
  StaticRoster, createLeash, wrapSigner,
} from "../src/leash/index.mjs";

const LOCKER = "8otvwgJ28HyQNc7mBSxtt4DWeqU1BwmQQLkFmhHE6yZP";
const AGENT = "BmAqWFJDzbaL6cuE5rC8BB4YJkTwFoH1cYTvLovz1f4w";
const OTHER = "4DKAbW3uCRzChtAL1x476PYtaBbZ7RnTCT2biBPApFEp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function state({ amount = 1_000n * ATOMIC, unbondTs = 0, lockTime = 1_000 } = {}) {
  const data = Buffer.alloc(STATE_LEN);
  data.writeBigUInt64LE(amount, 0);
  data.writeBigInt64LE(BigInt(unbondTs), 8);
  data.writeBigInt64LE(BigInt(lockTime), 16);
  data[24] = 1;
  return data;
}

function rpcFor(data) {
  return async () => ({
    value: { owner: PROGRAM_ID, data: [data.toString("base64"), "base64"] },
  });
}

function leashFor(opts = {}) {
  return createLeash({
    rpc: rpcFor(state(opts.state ?? {})),
    journal: opts.journal ?? new MemoryJournal(),
    roster: opts.roster ?? new StaticRoster({ [LOCKER]: [AGENT] }),
    now: opts.now ?? (() => 1_100),
  });
}

function fakeSigner() {
  const inner = {
    address: AGENT,
    signs: 0,
    sends: 0,
    failSend: false,
    async signTransaction(tx) {
      inner.signs += 1;
      return `signed:${tx}`;
    },
    async sendTransaction(signed) {
      inner.sends += 1;
      if (inner.failSend) {
        throw new Error("broadcast failed");
      }
      return `sig-${inner.sends}:${signed}`;
    },
  };
  return inner;
}

test("StaticRoster is per-locker and fail-closed on a bad map", () => {
  const roster = new StaticRoster({ [LOCKER]: [AGENT] });
  assert.deepEqual(roster.members(LOCKER), [AGENT]);
  assert.deepEqual(roster.members(OTHER), []);
  assert.throws(() => new StaticRoster([AGENT]), /map of locker/);
  assert.throws(() => new StaticRoster({ [LOCKER]: AGENT }), /array of pubkeys/);
});

test("FileRoster reads operator JSON and refuses a corrupt file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "roster.json");
  assert.deepEqual(new FileRoster(file).members(LOCKER), []);
  fs.writeFileSync(file, JSON.stringify({ [LOCKER]: [AGENT, OTHER] }));
  assert.deepEqual(new FileRoster(file).members(LOCKER), [AGENT, OTHER]);
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => new FileRoster(file).members(LOCKER), /unreadable/);
});

test("createLeash accepts a roster object", async () => {
  const decision = await leashFor().beforePayment({
    locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC,
  });
  assert.equal(decision.ok, true);
  const stranger = await leashFor().beforePayment({
    locker: LOCKER, agent: OTHER, amount: 1n, asset: USDC,
  });
  assert.equal(stranger.code, "agent_not_in_roster");
});

test("FileRoster over the tier wallet count is refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "roster.json");
  fs.writeFileSync(file, JSON.stringify({ [LOCKER]: [AGENT, OTHER] }));
  const decision = await leashFor({ roster: new FileRoster(file) })
    .beforePayment({ locker: LOCKER, agent: AGENT, amount: 1n, asset: USDC });
  assert.equal(decision.code, "roster_too_large");
});

test("wrapSigner refuses before the key is touched", async () => {
  const inner = fakeSigner();
  const wrapped = wrapSigner(inner, leashFor(), { locker: LOCKER });
  await assert.rejects(
    () => wrapped.signPayment({ amount: 100_000_001n, asset: USDC, transaction: "tx1" }),
    (err) => err instanceof LeashDenied && err.code === "cap_exceeded",
  );
  assert.equal(inner.signs, 0);
  assert.equal(inner.sends, 0);
});

test("wrapSigner signs on allow and tallies only after confirm", async () => {
  const inner = fakeSigner();
  const journal = new MemoryJournal();
  const wrapped = wrapSigner(inner, leashFor({ journal }), { locker: LOCKER, agent: AGENT });
  const { signed, decision } = await wrapped.signPayment({
    amount: 1_000_000n, asset: USDC, transaction: "tx1",
  });
  assert.equal(signed, "signed:tx1");
  assert.equal(inner.signs, 1);
  assert.equal(journal.spent(LOCKER, 1_000), 0n, "sign does not consume cap");
  assert.equal(wrapped.confirm(decision, "settle-1"), true);
  assert.equal(journal.spent(LOCKER, 1_000), 1_000_000n);
});

test("sendPayment records the settle id and does not tally a failed broadcast", async () => {
  const inner = fakeSigner();
  const journal = new MemoryJournal();
  const wrapped = wrapSigner(inner, leashFor({ journal }), { locker: LOCKER });
  const ok = await wrapped.sendPayment({
    amount: 2_000_000n, asset: USDC, transaction: "tx2",
  });
  assert.equal(ok.id.startsWith("sig-1:"), true);
  assert.equal(journal.spent(LOCKER, 1_000), 2_000_000n);

  inner.failSend = true;
  await assert.rejects(
    () => wrapped.sendPayment({ amount: 1n, asset: USDC, transaction: "tx3" }),
    /broadcast failed/,
  );
  assert.equal(inner.signs, 2);
  assert.equal(journal.spent(LOCKER, 1_000), 2_000_000n, "failed send does not consume cap");
});

test("wrapSigner requires locker and a real inner signer", () => {
  const inner = fakeSigner();
  assert.throws(() => wrapSigner(inner, leashFor(), {}), /locker is required/);
  assert.throws(() => wrapSigner({}, leashFor(), { locker: LOCKER }), /signTransaction/);
});
