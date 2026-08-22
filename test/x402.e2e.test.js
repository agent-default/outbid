// End-to-end over a REAL x402 payment flow with a mock facilitator:
// 402 challenge -> client signs an EIP-3009 payment -> verify -> handler ->
// settle -> onAfterSettle credits the board from settled facts.
// The only fake part is the facilitator's answer; every wire format is real.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";

// Hardhat test accounts: #1 pays, #2 receives. Never used with real funds.
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const payerAccount = privateKeyToAccount(PAYER_KEY);

function decodeChallenge(res) {
  const header = res.headers.get("payment-required");
  assert.ok(header, "PAYMENT-REQUIRED header missing on 402");
  return JSON.parse(Buffer.from(header, "base64").toString());
}

const dataFile = path.join(os.tmpdir(), `outbid-e2e-${process.pid}.json`);
const deadLetterFile = path.join(os.tmpdir(), `outbid-e2e-dead-${process.pid}.jsonl`);

let facilitator;
let facilitatorCalls;
let boardServer;
let base;
let app;

function startMockFacilitator() {
  facilitatorCalls = { supported: 0, verify: 0, settle: 0, settleBodies: [] };
  const f = express();
  f.use(express.json({ limit: "1mb" }));
  f.get("/supported", (_req, res) => {
    facilitatorCalls.supported += 1;
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    });
  });
  f.post("/verify", (req, res) => {
    facilitatorCalls.verify += 1;
    res.json({ isValid: true, payer: payerAccount.address });
  });
  f.post("/settle", (req, res) => {
    facilitatorCalls.settle += 1;
    facilitatorCalls.settleBodies.push(req.body);
    const requirements = req.body.paymentRequirements;
    res.json({
      success: true,
      payer: payerAccount.address,
      transaction: `0xsettled${String(facilitatorCalls.settle).padStart(4, "0")}`,
      network: requirements.network,
      amount: requirements.amount,
    });
  });
  return new Promise((resolve) => {
    const server = http.createServer(f);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

before(async () => {
  facilitator = await startMockFacilitator();
  const facilitatorUrl = `http://127.0.0.1:${facilitator.address().port}`;

  const { createApp } = await import("../src/server.js");
  app = await createApp({
    EVM_ADDRESS: RECEIVER,
    SVM_ADDRESS: "",
    FACILITATOR_URL: facilitatorUrl,
    X402_DRY: "1", // must be ignored because a wallet is configured
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
  client.register("eip155:*", new ExactEvmScheme(payerAccount));
  return wrapFetchWithPayment(fetch, client);
}

test("dry endpoint is OFF when a wallet is configured", async () => {
  const res = await fetch(`${base}/bid/dry?amount=0.05`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://should-not-list.example" }),
  });
  assert.equal(res.status, 403);
});

test("unpaid POST /bid returns a 402 priced from the body amount", async () => {
  const res = await fetch(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", amount: 0.07 }),
  });
  assert.equal(res.status, 402);
  const challenge = decodeChallenge(res);
  const accept = challenge.accepts?.[0];
  assert.ok(accept, JSON.stringify(challenge));
  assert.equal(accept.amount, "70000"); // $0.07 in atomic USDC
  assert.equal(accept.payTo.toLowerCase(), RECEIVER.toLowerCase());
  // an agent reading only the bazaar extension sees amount in the body schema
  const bazaarKey = Object.keys(challenge.extensions || {}).find((k) => k.includes("bazaar"));
  const bazaar = challenge.extensions?.[bazaarKey];
  assert.ok(JSON.stringify(bazaar).includes('"amount"'), "bazaar declaration must describe amount");
});

test("paid bid settles and the board row comes from settled facts", async () => {
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://paid.example", amount: 0.05, description: "first paid row" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.settlement, "pending");
  assert.ok(res.headers.get("payment-response"), "PAYMENT-RESPONSE header missing");

  assert.equal(facilitatorCalls.verify, 1);
  assert.equal(facilitatorCalls.settle, 1);
  // settle was for the challenge's atomic amount
  assert.equal(facilitatorCalls.settleBodies[0].paymentRequirements.amount, "50000");

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings.length, 1);
  const row = board.listings[0];
  assert.equal(row.url, "https://paid.example");
  assert.equal(row.bid_usdc, 0.05);
  assert.equal(row.last_payer, payerAccount.address);
  assert.match(row.last_tx, /^0xsettled/);
});

test("paying the same URL again adds the settled amount", async () => {
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://paid.example", amount: 0.1 }),
  });
  assert.equal(res.status, 200);
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings[0].bid_usdc, 0.15);
  assert.equal(board.listings[0].last_tx, "0xsettled0002");
});

test("invalid body with a valid payment: 400, settlement canceled, nothing credited, money not taken", async () => {
  const settleBefore = facilitatorCalls.settle;
  const res = await paidFetch()(`${base}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "ftp://not-allowed.example", amount: 0.05 }),
  });
  assert.equal(res.status, 400);
  assert.equal(facilitatorCalls.settle, settleBefore, "settle must NOT be called for a 4xx handler response");
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.listings.length, 1, "no new row from the failed bid");
});

test("settle replay credits once", async () => {
  const { store } = app._outbid;
  const first = store.credit({
    url: "https://replay.example",
    atomic: "20000",
    payer: payerAccount.address,
    tx: "0xreplaydemo",
    network: "eip155:84532",
  });
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  const again = store.credit({
    url: "https://replay.example",
    atomic: "20000",
    payer: payerAccount.address,
    tx: "0xreplaydemo",
    network: "eip155:84532",
  });
  assert.equal(again.ok, true);
  assert.equal(again.replay, true);
  const row = store.ranked().find((r) => r.url === "https://replay.example");
  assert.equal(row.bid_usdc, 0.02, "second settle of the same tx must not double-credit");
});

test("query amount still works for curl users", async () => {
  const res = await fetch(`${base}/bid?amount=0.03`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://query.example" }),
  });
  assert.equal(res.status, 402);
  const challenge = decodeChallenge(res);
  assert.equal(challenge.accepts?.[0]?.amount, "30000");
});
