#!/usr/bin/env node
import dotenv from "dotenv";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { loadEvmPrivateKey, loadSvmSecretBytes } from "./wallet-files.mjs";

dotenv.config();
if (process.env.DOTENV_FILE) dotenv.config({ path: process.env.DOTENV_FILE, override: true });

const [url, amount, ...rest] = process.argv.slice(2);
const description = rest.join(" ");
if (!url || !amount) {
  console.error("usage: node scripts/bid.mjs <url-or-@handle> <usdc> [description]");
  process.exit(2);
}

const base = process.env.OUTBID_URL || `http://127.0.0.1:${process.env.PORT || 4021}`;
const client = new x402Client();

const evmKey = loadEvmPrivateKey();
if (evmKey) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(evmKey)));
}
if (process.env.SVM_PRIVATE_KEY) {
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { base58 } = await import("@scure/base");
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(process.env.SVM_PRIVATE_KEY));
  client.register("solana:*", new ExactSvmScheme(svmSigner));
} else {
  const svmBytes = loadSvmSecretBytes();
  if (svmBytes) {
    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const svmSigner = await createKeyPairSignerFromBytes(svmBytes);
    client.register("solana:*", new ExactSvmScheme(svmSigner));
  }
}

if (!evmKey && !process.env.SVM_PRIVATE_KEY && !loadSvmSecretBytes()) {
  console.error("no payer key: set EVM_PRIVATE_KEY_FILE / SVM_PRIVATE_KEY_FILE (see scripts/init-wallets.mjs)");
  process.exit(2);
}

const fetchPaid = wrapFetchWithPayment(fetch, client);
const res = await fetchPaid(`${base}/bid`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url, amount: Number(amount), description }),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);

// The settlement receipt rides the PAYMENT-RESPONSE header.
const receipt = res.headers.get("payment-response");
if (receipt) {
  try {
    const settled = JSON.parse(Buffer.from(receipt, "base64").toString());
    console.log("settled:", { tx: settled.transaction, payer: settled.payer, network: settled.network });
  } catch {
    console.log("payment-response (raw):", receipt.slice(0, 120));
  }
}

// The credit is written on settlement — show where the bid landed.
// Match by the same normalization the board stores, not the raw argv string.
const { normalizeTarget } = await import("../src/store.js");
const target = normalizeTarget(url);
const board = await (await fetch(`${base}/api/board`)).json();
const mine = target.ok ? board.listings.find((l) => l.url === target.display) : undefined;
if (mine) console.log(`listed #${mine.rank} at $${mine.bid_usdc.toFixed(2)}`);
