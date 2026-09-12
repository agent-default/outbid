// Path A paying-client on local Surfpool. Public devnet faucet is dry;
// this chain uses the same mint and program ids. Not intel.twzrd.xyz.
// Disposable Surfpool signers — does not read token wallet files.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  LeashDenied, MemoryJournal, createLeash, wrapSigner,
} from "../../../src/leash/index.mjs";
import { startSurfpool } from "./surfpool.mjs";
import { ATOMIC, deploy, fixture } from "./fixture.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PATH_A = 50_000n;
let runtime;
let rpc;

before(async () => {
  runtime = await startSurfpool();
  rpc = runtime.rpc;
  await deploy(rpc);
}, { timeout: 30_000 });
after(async () => { await runtime?.stop(); });

function innerSigner(address) {
  const inner = {
    address,
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

async function lockedClient() {
  const f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));
  const agent = f.locker.address;
  const journal = new MemoryJournal();
  const leash = createLeash({
    rpc, journal, roster: async () => [agent], now: () => Date.now() / 1000 | 0,
  });
  const inner = innerSigner(agent);
  const wrapped = wrapSigner(inner, leash, { locker: f.locker.address, agent });
  return { f, journal, inner, wrapped };
}

test("no lock: wrapSigner refuses Path A before the key", async () => {
  const f = await fixture(rpc);
  const agent = f.locker.address;
  const inner = innerSigner(agent);
  const wrapped = wrapSigner(inner, createLeash({
    rpc, journal: new MemoryJournal(), roster: async () => [agent],
    now: () => Date.now() / 1000 | 0,
  }), { locker: f.locker.address, agent });
  await assert.rejects(
    () => wrapped.signPayment({ amount: PATH_A, asset: USDC, transaction: "path-a" }),
    (err) => err instanceof LeashDenied && err.code === "no_lock",
  );
  assert.equal(inner.signs, 0);
});

test("tier-1 lock: wrapSigner signs Path A $0.05 and tallies only after send", async () => {
  const { journal, inner, wrapped, f } = await lockedClient();
  const { id, decision } = await wrapped.sendPayment({
    amount: PATH_A, asset: USDC, transaction: "path-a",
  });
  assert.equal(inner.signs, 1);
  assert.equal(inner.sends, 1);
  assert.equal(decision.ok, true);
  assert.equal(decision.cap, 100_000_000n);
  assert.equal(journal.spent(f.locker.address, decision.windowStart), PATH_A);
  assert.match(id, /^sig-1:signed:path-a$/);
});

test("failed broadcast does not consume the Path A cap", async () => {
  const { journal, inner, wrapped, f } = await lockedClient();
  inner.failSend = true;
  await assert.rejects(
    () => wrapped.sendPayment({ amount: PATH_A, asset: USDC, transaction: "path-a" }),
    /broadcast failed/,
  );
  assert.equal(inner.signs, 1);
  assert.equal(journal.spent(f.locker.address, (await f.read()).time), 0n);
});

test("a $0.05 that would exceed the $100 cap never reaches the key", async () => {
  const { inner, wrapped } = await lockedClient();
  await wrapped.sendPayment({ amount: 100_000_000n, asset: USDC, transaction: "fill" });
  const signs = inner.signs;
  await assert.rejects(
    () => wrapped.signPayment({ amount: PATH_A, asset: USDC, transaction: "path-a" }),
    (err) => err instanceof LeashDenied && err.code === "cap_exceeded",
  );
  assert.equal(inner.signs, signs);
});
