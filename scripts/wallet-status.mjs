#!/usr/bin/env node
/** Print pubkeys + balances. Never prints secrets. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { walletDir, loadReceiverAddresses } from "./wallet-files.mjs";

function pubkeySvm(role) {
  const pub = `${walletDir}/${role}.svm.pubkey`;
  if (fs.existsSync(pub)) return fs.readFileSync(pub, "utf8").trim();
  const kp = `${walletDir}/${role}.svm.json`;
  if (!fs.existsSync(kp)) return null;
  return spawnSync("solana-keygen", ["pubkey", kp], { encoding: "utf8" }).stdout.trim();
}

function evmAddress(role) {
  const f = `${walletDir}/${role}.evm.json`;
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8")).address;
}

function solBalance(pk, url) {
  const r = spawnSync("solana", ["balance", pk, "--url", url], { encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
}

const rows = [
  ["evm-receiver", "Base Sepolia payTo", evmAddress("receiver")],
  ["evm-payer", "Base Sepolia bidder", evmAddress("payer")],
  ["svm-receiver", "Solana devnet payTo", pubkeySvm("receiver")],
  ["svm-payer", "Solana devnet bidder", pubkeySvm("payer")],
];

console.log(`dir ${walletDir}`);
console.log(`mode ${fs.statSync(walletDir).mode.toString(8).slice(-3)}`);
for (const [id, role, addr] of rows) {
  if (!addr) {
    console.log(`${id.padEnd(14)} MISSING  (${role})`);
    continue;
  }
  const extra = id.startsWith("svm") ? `  devnet-SOL=${solBalance(addr, "devnet")}` : "";
  console.log(`${id.padEnd(14)} ${addr}  ${role}${extra}`);
}

const rec = loadReceiverAddresses();
console.log("receivers", rec);
