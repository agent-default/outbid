#!/usr/bin/env node
// Path A paying client: live intel 402 → wrapSigner → sign only if the leash allows.
// Verified on mainnet 2026-09-08: vault program 4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB
// EXISTS and is executable; mint PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3 EXISTS. The
// earlier note here ("mint and vault are not on mainnet") was stale and misleading.
// What is NOT on mainnet is a live lock: the PDA for locker 8otvwg... derives to
// CZ6eRc2VeRAtUmmEpW2Qd88Fmz7qyY4rnMYbazSjJa8u and getAccountInfo returns null. So a
// refuse from this script is fail-closed on an ABSENT lock, not a grant being enforced.
// Do not cite this script as evidence that the leash refused a real spend.
import { LeashDenied, StaticRoster, createLeash, wrapSigner } from "../src/leash/index.mjs";
import { FileJournal } from "../src/leash/journal.mjs";

const TARGET =
  "https://intel.twzrd.xyz/v1/intel/trust/GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const RPC_URL = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const LOCKER = "8otvwgJ28HyQNc7mBSxtt4DWeqU1BwmQQLkFmhHE6yZP";
const AGENT = "BmAqWFJDzbaL6cuE5rC8BB4YJkTwFoH1cYTvLovz1f4w";
const SVM = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message ?? "rpc error");
  }
  return body.result;
}

function innerSigner() {
  const inner = {
    address: AGENT,
    signs: 0,
    async signTransaction() {
      inner.signs += 1;
      throw new Error("inner signer reached; leash should have refused");
    },
  };
  return inner;
}

const unpaid = await fetch(TARGET, { headers: { accept: "application/json" } });
if (unpaid.status !== 402) {
  throw new Error(`expected 402, got ${unpaid.status}`);
}
const challenge = await unpaid.json();
const sol = (challenge.accepts ?? []).find((a) => String(a.network).startsWith(SVM));
if (!sol) {
  throw new Error("no Solana accept on the 402");
}
const amount = BigInt(sol.amount);
const asset = sol.asset;

const inner = innerSigner();
const journal = new FileJournal(new URL("../data/leash-path-a.json", import.meta.url).pathname);
const leash = createLeash({
  rpc,
  journal,
  roster: new StaticRoster({ [LOCKER]: [AGENT] }),
});
const wrapped = wrapSigner(inner, leash, { locker: LOCKER, agent: AGENT });

let out;
try {
  await wrapped.signPayment({ amount, asset, transaction: "unsigned-path-a" });
  out = { ok: true, signed: true, inner_signs: inner.signs };
} catch (error) {
  if (!(error instanceof LeashDenied)) {
    throw error;
  }
  out = {
    ok: false,
    signed: false,
    inner_signs: inner.signs,
    code: error.code,
    reason: error.decision?.reason ?? error.message,
    amount: amount.toString(),
    asset,
    payTo: sol.payTo,
    target: TARGET,
    locker: LOCKER,
  };
}

console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 2);
