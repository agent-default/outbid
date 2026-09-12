// CROSS-RAIL e2e: the differentiator for outbid is that the bid currency is
// independent of the ranked URL — a Solana agent can pay to rank a Base
// endpoint and vice-versa. This test pins the two halves of that claim:
//
//  1. 402 surface (needs ../src/server.js): with BOTH EVM_ADDRESS and
//     SVM_ADDRESS set, an unpaid POST /bid returns ONE 402 whose challenge
//     offers BOTH accepts — exact eip155:8453 (Base mainnet, USDC
//     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and exact
//     solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp (Solana mainnet). The mock
//     facilitator's /supported mirrors PayAI's real shape: the Solana kind
//     carries extra.feePayer, the Base mainnet kind carries NO extra (EVM
//     exact is EIP-3009; the facilitator submits the tx itself).
//
//  2. Board surface (only needs ../src/store.js): a settle on EITHER rail
//     credits the SAME listing — two credit() calls with different networks
//     and txs on one URL sum into one bid_usdc, and replays on either rail
//     are ignored per (network, tx).
//
// Import and startup failures must fail this check, not skip HTTP coverage.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { createStore } from "../src/store.js";

const EVM_NETWORK = "eip155:8453"; // Base mainnet
const SVM_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet

// Public addresses only — the dedicated outbid receivers (chain-agnostic EVM
// key; same payTo on Base Sepolia and Base mainnet) and PayAI's mainnet
// Solana feePayer as advertised by its live /supported.
const EVM_RECEIVER = "0xB36e83aB5E6128bC0E1b76b3F59Fe2fD443F0788";
const SVM_RECEIVER = "J2h49Qf8P4kttEUbhkUPdv2zHAXE6pA7QQ2gN65dhEYv";
const SVM_FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const dataFile = path.join(os.tmpdir(), `outbid-crossrail-e2e-${process.pid}.json`);
const storeFile = path.join(os.tmpdir(), `outbid-crossrail-store-${process.pid}.json`);
const deadLetterFile = path.join(os.tmpdir(), `outbid-crossrail-dead-${process.pid}.jsonl`);

let facilitator;
let boardServer;
let base;

function startMockFacilitator() {
  const f = express();
  f.use(express.json({ limit: "1mb" }));
  // Mirrors https://facilitator.payai.network/supported (2026-08-23): the
  // Base mainnet exact kind has NO extra; the Solana mainnet kind has
  // extra.feePayer.
  f.get("/supported", (_req, res) => {
    res.json({
      kinds: [
        { x402Version: 2, scheme: "exact", network: EVM_NETWORK },
        { x402Version: 2, scheme: "exact", network: SVM_NETWORK, extra: { feePayer: SVM_FEE_PAYER } },
      ],
      extensions: [],
      signers: { "solana:*": [SVM_FEE_PAYER] },
    });
  });
  f.post("/verify", (_req, res) => res.json({ isValid: true, payer: "mock" }));
  f.post("/settle", (req, res) =>
    res.json({
      success: true,
      payer: "mock",
      transaction: "MockCrossRailSettle0001",
      network: req.body?.paymentRequirements?.network,
      amount: req.body?.paymentRequirements?.amount,
    }),
  );
  return new Promise((resolve) => {
    const server = http.createServer(f);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

before(async () => {
  facilitator = await startMockFacilitator();
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    EVM_ADDRESS: EVM_RECEIVER,
    EVM_NETWORK,
    SVM_ADDRESS: SVM_RECEIVER,
    SVM_NETWORK,
    FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`,
    X402_DRY: "0",
    DATA_FILE: dataFile,
    DEAD_LETTER_FILE: deadLetterFile,
  });
  boardServer = http.createServer(app);
  await new Promise((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${boardServer.address().port}`;
});

after(() => {
  boardServer?.close();
  facilitator?.close();
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(storeFile, { force: true });
  fs.rmSync(deadLetterFile, { force: true });
});

// ---------------------------------------------------------------------------
// 402 surface — both rails offered in one challenge
// ---------------------------------------------------------------------------

test("unpaid POST /bid returns one 402 offering BOTH Base mainnet and Solana mainnet accepts", async () => {
  const res = await fetch(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://cross-rail.example/api", amount: 0.05 }),
  });
  assert.equal(res.status, 402);
  const header = res.headers.get("payment-required");
  assert.ok(header, "PAYMENT-REQUIRED header missing");
  const challenge = JSON.parse(Buffer.from(header, "base64").toString());
  const accepts = challenge.accepts || [];
  assert.equal(accepts.length, 2, JSON.stringify(challenge).slice(0, 400));

  const evm = accepts.find((a) => a.network === EVM_NETWORK);
  const svm = accepts.find((a) => a.network === SVM_NETWORK);
  assert.ok(evm, "no eip155:8453 accept in 402");
  assert.ok(svm, "no solana mainnet accept in 402");

  assert.equal(evm.scheme, "exact");
  assert.equal(evm.payTo, EVM_RECEIVER);
  assert.equal(evm.amount, "50000"); // $0.05 in 6-decimal USDC
  assert.equal(evm.asset, BASE_USDC); // Base mainnet USDC

  assert.equal(svm.scheme, "exact");
  assert.equal(svm.payTo, SVM_RECEIVER);
  assert.equal(svm.amount, "50000");
  assert.equal(svm.asset, SOL_USDC); // Solana mainnet USDC mint
  assert.equal(svm.extra?.feePayer, SVM_FEE_PAYER);
});

test("GET /api/meta advertises both rails", async () => {
  const res = await fetch(`${base}/api/meta`);
  assert.equal(res.status, 200);
  const meta = await res.json();
  const nets = (meta.networks || []).map((n) => n.network).sort();
  assert.deepEqual(nets, [EVM_NETWORK, SVM_NETWORK].sort());
  const byNet = Object.fromEntries(meta.networks.map((n) => [n.network, n.payTo]));
  assert.equal(byNet[EVM_NETWORK], EVM_RECEIVER);
  assert.equal(byNet[SVM_NETWORK], SVM_RECEIVER);
});

// ---------------------------------------------------------------------------
// Board surface — settles on either rail credit the SAME listing
// Store-only coverage also runs independently in test/store.test.js.
// ---------------------------------------------------------------------------

test("credit() on both rails sums into ONE listing's bid_usdc", () => {
  const store = createStore(storeFile);
  const url = "https://cross-rail.example/api";

  // Base-rail settle: an EVM agent paid $0.05 to rank this URL.
  const evmCredit = store.credit({
    url,
    description: "cross-rail listing",
    atomic: "50000",
    payer: "0x1fFbffFa34e9De3BFA5dd93967c8C8E02Cf111a2",
    tx: "0xevm_settle_tx_1",
    network: EVM_NETWORK,
  });
  assert.equal(evmCredit.ok, true, JSON.stringify(evmCredit));
  assert.equal(evmCredit.replay, false);
  assert.equal(evmCredit.listing.bid_usdc, 0.05);

  // Solana-rail settle on the SAME URL: a Solana agent adds $0.07.
  const svmCredit = store.credit({
    url,
    atomic: "70000",
    payer: "5LPpHE9cS1gB241soZvTT3NcHQuEd1r6uJoiF22Hi5h4",
    tx: "SvmSettleSig1",
    network: SVM_NETWORK,
  });
  assert.equal(svmCredit.ok, true, JSON.stringify(svmCredit));
  assert.equal(svmCredit.replay, false);

  // Same listing, cumulative bid: 0.05 + 0.07 = 0.12.
  assert.equal(svmCredit.listing.id, evmCredit.listing.id);
  assert.equal(svmCredit.listing.bid_usdc, 0.12);
  assert.equal(svmCredit.board.length, 1);
  assert.equal(svmCredit.board[0].rank, 1);

  // Two distinct payment records, keyed by (network, tx).
  const payments = store.payments();
  assert.equal(Object.keys(payments).length, 2);
  assert.ok(payments[`${EVM_NETWORK}:0xevm_settle_tx_1`]);
  assert.ok(payments[`${SVM_NETWORK}:SvmSettleSig1`]);
});

test("replay on either rail is ignored; a new tx on either rail still credits", () => {
  const store = createStore(storeFile);
  const url = "https://cross-rail.example/api";

  // Replays of both earlier settles: idempotent per (network, tx).
  const evmReplay = store.credit({ url, atomic: "50000", tx: "0xevm_settle_tx_1", network: EVM_NETWORK });
  assert.equal(evmReplay.ok, true);
  assert.equal(evmReplay.replay, true);
  const svmReplay = store.credit({ url, atomic: "70000", tx: "SvmSettleSig1", network: SVM_NETWORK });
  assert.equal(svmReplay.ok, true);
  assert.equal(svmReplay.replay, true);
  assert.equal(store.ranked()[0].bid_usdc, 0.12);

  // Same tx string on the OTHER network is a different payment key — the
  // idempotency scope is per-rail, which is exactly what cross-rail needs.
  const crossKey = store.credit({ url, atomic: "10000", tx: "SvmSettleSig1", network: EVM_NETWORK });
  assert.equal(crossKey.ok, true);
  assert.equal(crossKey.replay, false);
  assert.equal(crossKey.listing.bid_usdc, 0.13);
  assert.equal(store.ranked().length, 1);
});
