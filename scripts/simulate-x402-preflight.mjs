#!/usr/bin/env node
// Refuse-before-sign, end to end, with no chain and no network.
//
// The RPC below is a stub: it serves lock accounts this script encodes itself.
// It proves the DECISION path, not the chain read. The chain read is proven
// against the deployed program in programs/token-vault/test/leash.test.mjs.
// Nothing here signs, settles, or opens a socket.
import { MemoryJournal, STATE_LEN, createLeash, deriveLockPda } from "outbid/leash";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB";
const LOCKER = "8otvwgJ28HyQNc7mBSxtt4DWeqU1BwmQQLkFmhHE6yZP";
const AGENT = "BmAqWFJDzbaL6cuE5rC8BB4YJkTwFoH1cYTvLovz1f4w";
const T0 = 1_760_000_000;
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(BigInt(micro) % 10_000n === 0n ? 2 : 3)}`;

// --- stub chain -------------------------------------------------------------
const chain = { amount: 0n, unbondTs: 0, lockTime: 0 };
const pda = await deriveLockPda(LOCKER);

function rpc(method, [key]) {
  if (method !== "getAccountInfo") throw new Error(`unexpected ${method}`);
  if (key !== pda || chain.lockTime === 0) return { value: null };
  const data = Buffer.alloc(STATE_LEN);
  data.writeBigUInt64LE(chain.amount, 0);
  data.writeBigInt64LE(BigInt(chain.unbondTs), 8);
  data.writeBigInt64LE(BigInt(chain.lockTime), 16);
  data[24] = 1;
  return { value: { owner: PROGRAM, data: [data.toString("base64"), "base64"] } };
}

const lock = (whole, at) => {
  chain.amount += BigInt(whole) * 1_000_000n;
  chain.lockTime ||= at;
};

// --- the client -------------------------------------------------------------
let now = T0;
const journal = new MemoryJournal();
const leash = createLeash({
  rpc, journal, roster: async () => [AGENT], now: () => now,
});

let signed = 0;
let refused = 0;

// One x402 request: 402 arrives, the leash decides, only then would we sign.
async function request(label, priceMicro) {
  const decision = await leash.beforePayment({
    locker: LOCKER, agent: AGENT, amount: priceMicro, asset: USDC,
  });
  if (!decision.ok) {
    refused++;
    console.log(`  REFUSE  ${label.padEnd(26)} ${usd(priceMicro).padStart(9)}  ${decision.code}`);
    console.log(`          ${decision.reason}`);
    return;
  }
  // A real client signs the USDC 402 here and settles. We fake a signature.
  leash.afterSettle(decision, `sig${++signed}`);
  console.log(`  SIGN    ${label.padEnd(26)} ${usd(priceMicro).padStart(9)}  left ${usd(decision.remaining)}`);
}

const step = (title) => console.log(`\n${title}\n${"-".repeat(title.length)}`);

step("1. No lock: the agent cannot pay at all");
await request("venice.ai/completion", 50_000n);

step("2. Locker locks 1,000 TWZRD -> $100 / 24h, 1 wallet");
lock(1_000, now);
await request("venice.ai/completion", 50_000n);
await request("reader.outbid.sh/scrape", 5_000n);
await request("outbid.sh/route", 10_000n);

step("3. Tier cap: the leash refuses the payment that would exceed $100");
await request("bulk crawl (fits)", 99_000_000n);
await request("bulk crawl (too big)", 90_000_000n);
await request("one more call", 10_000_000n);

step("4. Top-up to 10,000 TWZRD -> $1,000 / 72h, same window start");
lock(9_000, now);
await request("bulk crawl (retry)", 10_000_000n);

step("5. Wrong asset: TWZRD is never the 402 asset");
const twzrd = await leash.beforePayment({
  locker: LOCKER, agent: AGENT, amount: 1_000_000n,
  asset: "PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3",
});
console.log(`  REFUSE  ${"seller quotes TWZRD".padEnd(26)}            ${twzrd.code}`);
refused++;

step("6. A stranger's key is not on the roster");
const stranger = await leash.beforePayment({
  locker: LOCKER, agent: LOCKER, amount: 1_000n, asset: USDC,
});
console.log(`  REFUSE  ${"unlisted agent key".padEnd(26)}            ${stranger.code}`);
refused++;

step("7. Unbond: capacity is gone immediately, not after the cooldown");
chain.unbondTs = now;
await request("venice.ai/completion", 50_000n);
now += 86_400;
console.log("  (24h cooldown elapsed; tokens are withdrawable, capacity is not back)");
await request("venice.ai/completion", 50_000n);

step("8. Fresh lock after withdraw starts a new window and a new tally");
chain.amount = 0n; chain.unbondTs = 0; chain.lockTime = 0;
lock(1_000, now);
await request("venice.ai/completion", 50_000n);

step("9. Window expiry: the lock still holds tokens, the grant does not");
now += 24 * 3600;
await request("venice.ai/completion", 50_000n);

console.log(`\nsigned ${signed} payments, refused ${refused}.`);
console.log("The vault never saw a USDC 402. The leash never signed one.");
