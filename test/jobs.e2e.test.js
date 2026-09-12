// Jobs paywall over a REAL x402 flow with a mock facilitator.
// Proves header spoof ≠ settle, and verify→handler→settle on 2xx.
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

const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const payerAccount = privateKeyToAccount(PAYER_KEY);

function decodeChallenge(res) {
  const header = res.headers.get("payment-required");
  assert.ok(header, "PAYMENT-REQUIRED header missing on 402");
  return JSON.parse(Buffer.from(header, "base64").toString());
}

const dataFile = path.join(os.tmpdir(), `outbid-jobs-e2e-${process.pid}.json`);
const deadLetterFile = path.join(os.tmpdir(), `outbid-jobs-e2e-dead-${process.pid}.jsonl`);

let facilitator;
let facilitatorCalls;
let boardServer;
let base;
let readerCalls;

function startMockFacilitator() {
  facilitatorCalls = { supported: 0, verify: 0, settle: 0 };
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
  f.post("/verify", (_req, res) => {
    facilitatorCalls.verify += 1;
    res.json({ isValid: true, payer: payerAccount.address });
  });
  f.post("/settle", (req, res) => {
    facilitatorCalls.settle += 1;
    const requirements = req.body.paymentRequirements;
    res.json({
      success: true,
      payer: payerAccount.address,
      transaction: `0xjob${String(facilitatorCalls.settle).padStart(4, "0")}`,
      network: requirements.network,
      amount: requirements.amount,
    });
  });
  return new Promise((resolve) => {
    const server = http.createServer(f);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function paidFetch() {
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(payerAccount));
  return wrapFetchWithPayment(fetch, client);
}

before(async () => {
  facilitator = await startMockFacilitator();
  readerCalls = [];
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    JOBS_ENABLED: "1",
    EVM_ADDRESS: RECEIVER,
    SVM_ADDRESS: "",
    FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`,
    DATA_FILE: dataFile,
    DEAD_LETTER_FILE: deadLetterFile,
    jobsFetch: async (input) => {
      readerCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true, title: "Example", markdown: "# hi", word_count: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
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

test("jobs live: unpaid and spoofed scrape stay 402; no reader call", async () => {
  const unpaid = await fetch(`${base}/job/scrape?url=https://example.com/`);
  assert.equal(unpaid.status, 402);
  const challenge = decodeChallenge(unpaid);
  assert.equal(challenge.accepts?.[0]?.amount, "5000");
  const spoof = await fetch(`${base}/job/scrape?url=https://example.com/`, {
    headers: { "x-payment": "test", "payment-signature": "test" },
  });
  assert.equal(spoof.status, 402);
  const slash = await fetch(`${base}/job/scrape/?url=https://example.com/`);
  assert.equal(slash.status, 402);
  assert.equal(readerCalls.length, 0);
  assert.equal(facilitatorCalls.settle, 0);
});

test("jobs live: valid payment fulfills scrape and settles once", async () => {
  const settleBefore = facilitatorCalls.settle;
  const res = await paidFetch()(`${base}/job/scrape?url=https://example.com/`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.job, "scrape");
  assert.equal(readerCalls.length, 1);
  assert.match(readerCalls[0], /\/scrape\?/);
  assert.doesNotMatch(readerCalls[0], /\/browse\?/);
  assert.equal(facilitatorCalls.settle, settleBefore + 1);
});

test("jobs live: well-known lists hop only while house-pay is off", async () => {
  const well = await (await fetch(`${base}/.well-known/x402`)).json();
  const paths = well.resources.map((r) => new URL(r.url).pathname);
  assert.ok(paths.includes("/job/hop"));
  assert.equal(paths.includes("/job/scrape"), false);
  assert.equal(paths.includes("/job/browse"), false);
});

test("jobs live: reader 402 becomes 502 and cancels settle", async () => {
  const data = path.join(os.tmpdir(), `outbid-jobs-e2e-502-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    JOBS_ENABLED: "1",
    EVM_ADDRESS: RECEIVER,
    SVM_ADDRESS: "",
    FACILITATOR_URL: `http://127.0.0.1:${facilitator.address().port}`,
    DATA_FILE: data,
    jobsFetch: async () => new Response("{}", { status: 402 }),
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const settleBefore = facilitatorCalls.settle;
    const res = await paidFetch()(`http://127.0.0.1:${srv.address().port}/job/scrape?url=https://example.com/`);
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error, "reader_requires_payment");
    assert.equal(facilitatorCalls.settle, settleBefore, "502 must cancel authorization-flow settle");
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
});
