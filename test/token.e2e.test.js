import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { generateKeyPairSigner } from "@solana/kit";
import { ATOMIC, deploy, fixture } from "../programs/token-vault/test/fixture.mjs";
import { startSurfpool } from "../programs/token-vault/test/surfpool.mjs";

const dataFile = path.join(os.tmpdir(), `outbid-token-e2e-${process.pid}.json`);

function surfpoolReady() {
  return spawnSync("which", ["surfpool"]).status === 0;
}

let runtime;
let boardServer;
let base;
let f;

before(async () => {
  if (!surfpoolReady()) return;
  runtime = await startSurfpool();
  const { rpc, url } = runtime;
  await deploy(rpc);
  f = await fixture(rpc);
  await f.send(f.ix(0, 1_000n * ATOMIC));

  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    SOLANA_RPC_URL: url,
    DATA_FILE: dataFile,
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
  });
  boardServer = http.createServer(app);
  await new Promise((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${boardServer.address().port}`;
});

after(() => {
  boardServer?.close();
  runtime?.stop?.();
  fs.rmSync(dataFile, { force: true });
});

test("GET /v0/token returns on-chain supply", async (t) => {
  if (!surfpoolReady()) return t.skip("surfpool not installed");
  const res = await fetch(`${base}/v0/token`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.mint, "PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3");
  assert.equal(body.program, "4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB");
  assert.equal(body.decimals, 6);
  assert.equal(body.supply_whole, 1_000_000_000);
  assert.equal(body.supply_atomic, "1000000000000000");
});

test("GET /v0/lock/:pubkey returns the lock grant", async (t) => {
  if (!surfpoolReady()) return t.skip("surfpool not installed");
  const res = await fetch(`${base}/v0/lock/${f.locker.address}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.locker, f.locker.address);
  assert.equal(body.locked_whole, 1_000);
  assert.equal(body.locked_atomic, "1000000000");
  assert.equal(body.wallets, 1);
  assert.equal(body.cap_usd, 100);
  assert.equal(body.window_h, 24);
  assert.equal(body.qps, 0);
  assert.equal(body.unbond_ts, 0);
  assert.ok(body.pda);
});

test("GET /v0/lock/:pubkey 404s for an unlocked wallet", async (t) => {
  if (!surfpoolReady()) return t.skip("surfpool not installed");
  const stranger = await generateKeyPairSigner();
  const res = await fetch(`${base}/v0/lock/${stranger.address}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "no lock");
});

test("GET /v0/lock/:pubkey 400s for an invalid pubkey", async (t) => {
  if (!surfpoolReady()) return t.skip("surfpool not installed");
  const res = await fetch(`${base}/v0/lock/notakey`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid pubkey");
});
