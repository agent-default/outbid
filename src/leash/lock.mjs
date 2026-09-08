// Chain read for the TWZRD lock. Source of truth for permission.
// Mirrors programs/token-vault: state v1, PDA ["lock", locker].
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

export const PROGRAM_ID = "4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB";
export const MINT = "PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3";
export const STATE_LEN = 32;
export const STATE_VERSION = 1;
export const ATOMIC = 1_000_000n;
export const UNBOND_SECS = 86_400;

// Whole locked tokens → grant. Same table as programs/token-vault/src/grant.rs.
// tier-parity.test.mjs proves this against on-chain get_lock.
export const TIERS = [
  { min: 100_000n, wallets: 25, capUsd: 10_000n, windowH: 168 },
  { min: 10_000n, wallets: 5, capUsd: 1_000n, windowH: 72 },
  { min: 1_000n, wallets: 1, capUsd: 100n, windowH: 24 },
];

export function grantFromLock(amount, unbondTs) {
  if (unbondTs !== 0) {
    return { amount, wallets: 0, qps: 0, capUsd: 0n, windowH: 0, unbondTs };
  }
  const whole = amount / ATOMIC;
  const tier = TIERS.find((t) => whole >= t.min);
  return {
    amount,
    wallets: tier ? tier.wallets : 0,
    qps: 0,
    capUsd: tier ? tier.capUsd : 0n,
    windowH: tier ? tier.windowH : 0,
    unbondTs,
  };
}

export function decodeLockState(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== STATE_LEN) {
    throw new Error("lock state: wrong length");
  }
  if (bytes[24] !== STATE_VERSION) throw new Error("lock state: wrong version");
  if (!bytes.subarray(25).every((b) => b === 0)) {
    throw new Error("lock state: reserved bytes set");
  }
  const amount = bytes.readBigUInt64LE(0);
  const unbondTs = Number(bytes.readBigInt64LE(8));
  const lockTime = Number(bytes.readBigInt64LE(16));
  if (amount === 0n) {
    if (lockTime !== 0 || unbondTs !== 0) throw new Error("lock state: empty with times");
  } else if (lockTime <= 0 || (unbondTs !== 0 && unbondTs < lockTime)) {
    throw new Error("lock state: bad times");
  }
  return { amount, unbondTs, lockTime };
}

const enc = getAddressEncoder();

export async function deriveLockPda(locker, programId = PROGRAM_ID) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [new TextEncoder().encode("lock"), enc.encode(address(locker))],
  });
  return pda;
}

// Fail closed: any RPC error, missing account, foreign owner, or malformed
// state throws. A caller that cannot read the chain must not sign.
export async function readLock(rpc, locker, programId = PROGRAM_ID) {
  const pda = await deriveLockPda(locker, programId);
  const res = await rpc("getAccountInfo", [pda, { encoding: "base64", commitment: "confirmed" }]);
  const value = res?.value;
  if (!value) throw new Error("no lock account");
  if (value.owner !== programId) throw new Error("lock account: foreign owner");
  const state = decodeLockState(Buffer.from(value.data[0], "base64"));
  return { pda, state, grant: grantFromLock(state.amount, state.unbondTs) };
}

export function windowEnd(lockTime, windowH) {
  return lockTime + windowH * 3600;
}
