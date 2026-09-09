import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpc } from "./chain.mjs";
import { ATOMIC, MINT, PROGRAM_ID, readLock } from "./leash/lock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_JSON = path.join(__dirname, "public", "token.json");

const DEFAULT_TOKEN = {
  name: "TWZRD",
  symbol: "TWZRD",
  description: "Fixed-supply SPL used to lock spend capacity. x402 and MPP settle in USDC.",
  image: "https://outbid.sh/favicon.ico",
};

function readTokenJson() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_JSON, "utf8"));
  } catch {
    return DEFAULT_TOKEN;
  }
}

export function tokenMeta() {
  const json = readTokenJson();
  return {
    mint: MINT,
    program: PROGRAM_ID,
    name: json.name || DEFAULT_TOKEN.name,
    symbol: json.symbol || DEFAULT_TOKEN.symbol,
    description: json.description || DEFAULT_TOKEN.description,
    image: json.image || DEFAULT_TOKEN.image,
    decimals: json.properties?.decimals ?? 6,
  };
}

function formatUiAmount(atomic, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const whole = atomic / divisor;
  const frac = (atomic % divisor).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

async function readMintFromAccount(rpc) {
  const result = await rpc("getAccountInfo", [MINT, { encoding: "base64", commitment: "confirmed" }]);
  const value = result?.value;
  if (!value) throw new Error("mint account not found");
  const data = Buffer.from(value.data[0], "base64");
  if (data.length < 82) throw new Error("mint account: wrong length");
  const atomic = data.readBigUInt64LE(36);
  const decimals = data[44];
  return {
    decimals,
    supply_atomic: atomic.toString(),
    supply_whole: Number(atomic / ATOMIC),
    supply_ui: formatUiAmount(atomic, decimals),
  };
}

export async function readTokenSupply(rpc) {
  let value;
  try {
    const result = await rpc("getTokenSupply", [MINT, { commitment: "confirmed" }]);
    value = result?.value;
  } catch (err) {
    if (!/method not found|unsupported/i.test(String(err.message))) throw err;
  }
  if (value) {
    const atomic = BigInt(value.amount);
    return {
      decimals: value.decimals,
      supply_atomic: value.amount,
      supply_whole: Number(atomic / ATOMIC),
      supply_ui: value.uiAmountString ?? formatUiAmount(atomic, value.decimals),
    };
  }
  return readMintFromAccount(rpc);
}

export async function readLockFor(rpc, locker) {
  const { pda, state, grant } = await readLock(rpc, locker);
  return {
    ok: true,
    locker,
    pda,
    locked_whole: Number(state.amount / ATOMIC),
    locked_atomic: state.amount.toString(),
    wallets: grant.wallets,
    cap_usd: Number(grant.capUsd),
    window_h: grant.windowH,
    lock_time: state.lockTime,
    unbond_ts: state.unbondTs,
    qps: grant.qps,
  };
}

export function createSolana(endpoint) {
  const rpc = createJsonRpc(endpoint);
  return { rpc, tokenSupply: () => readTokenSupply(rpc), lock: (locker) => readLockFor(rpc, locker) };
}
