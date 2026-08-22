// Solana-path e2e over a REAL x402 payment flow with a mock facilitator:
// 402 challenge (with extra.feePayer) -> ExactSvmScheme signs -> verify ->
// handler -> settle -> onAfterSettle credits from settled facts.
// Also pins the #2169 wire shape: a settle refusal WITHOUT `transaction`
// fails SDK validation and must surface as a 502 with nothing credited.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { generateKeyPairSigner } from "@solana/kit";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const dataFile = path.join(os.tmpdir(), `outbid-svm-e2e-${process.pid}.json`);
const deadLetterFile = path.join(os.tmpdir(), `outbid-svm-dead-${process.pid}.jsonl`);

let payerSigner;
let feePayerSigner;
let receiverSigner;
let facilitator;
let calls;
let boardServer;
let base;

// When true, /settle answers with the trust-gate refusal shape observed
// live on 2026-08-22 (issue #2169): success:false, NO transaction field.
let gateBlockMode = false;

function startMockFacilitator() {
  calls = { verify: 0, settle: 0 };
  const f = express();
  f.use(express.json({ limit: "1mb" }));
  f.get("/supported", (_req, res) => {
    res.json({
      kinds: [
        { x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: feePayerSigner.address } },
      ],
      extensions: [],
      signers: { "solana:*": [feePayerSigner.address] },
    });
  });
  f.post("/verify", (_req, res) => {
    calls.verify += 1;
    res.json({ isValid: true, payer: payerSigner.address });
  });
  f.post("/settle", (req, res) => {
    calls.settle += 1;
    if (gateBlockMode) {
      // #2169: refusal omits `transaction`, which settleResponseSchema requires.
      return res.json({ success: false, errorReason: "trust_gate_blocked:23", trust_score: 23 });
    }
    res.json({
      success: true,
      payer: payerSigner.address,
      transaction: `SvmSettle${String(calls.settle).padStart(4, "0")}`,
      network: req.body.paymentRequirements.network,
      amount: req.body.paymentRequirements.amount,
    });
  });
  return new Promise((resolve) => {
    const server = http.createServer(f);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

before(async () => {
  payerSigner = await generateKeyPairSigner();
  feePayerSigner = await generateKeyPairSigner();
  receiverSigner = await generateKeyPairSigner();
  facilitator = await startMockFacilitator();

  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    EVM_ADDRESS: "",
    SVM_ADDRESS: receiverSigner.address,
    SVM_NETWORK: NETWORK,
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
  fs.rmSync(deadLetterFile, { force: true });
});

function paidFetch() {
  const client = new x402Client();
  client.register("solana:*", new ExactSvmScheme(payerSigner));
  return wrapFetchWithPayment(fetch, client);
}

test("unpaid POST /bid returns a Solana 402 with feePayer in extra", async () => {
  const res = await fetch(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://svm.example", amount: 0.05 }),
  });
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString());
  const accept = challenge.accepts?.[0];
  assert.ok(accept, JSON.stringify(challenge).slice(0, 200));
  assert.equal(accept.network, NETWORK);
  assert.equal(accept.amount, "50000");
  assert.equal(accept.payTo, receiverSigner.address);
  assert.equal(accept.extra?.feePayer, feePayerSigner.address);
});

test("paid Solana bid settles and credits from settled facts", async () => {
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://svm.example", amount: 0.05, description: "svm paid row" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(calls.verify, 1);
  assert.equal(calls.settle, 1);

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings.length, 1);
  const row = board.listings[0];
  assert.equal(row.url, "https://svm.example");
  assert.equal(row.bid_usdc, 0.05);
  assert.equal(row.last_payer, payerSigner.address);
  assert.match(row.last_tx, /^SvmSettle/);
});

test("trust-gate refusal without `transaction` surfaces as 502 and credits nothing (#2169)", async () => {
  gateBlockMode = true;
  const before502 = calls.settle;
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://blocked.example", amount: 0.05 }),
  });
  gateBlockMode = false;
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error || "", /invalid data|settle/i);
  assert.equal(calls.settle, before502 + 1, "settle was attempted once");

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings.length, 1, "no row for the blocked bid");
  assert.ok(!board.listings.some((l) => l.url === "https://blocked.example"));
});

test("after a refusal, a clean settle still works (no stuck state)", async () => {
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://svm.example", amount: 0.1 }),
  });
  assert.equal(res.status, 200, await res.text());
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings[0].bid_usdc, 0.15);
});
