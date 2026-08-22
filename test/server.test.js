import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-board-${process.pid}.json`);
process.env.X402_DRY = "1";
process.env.DATA_FILE = dataFile;
process.env.EVM_ADDRESS = "";
process.env.SVM_ADDRESS = "";
process.env.PORT = "0";

const { createApp } = await import("../src/server.js");

let server;
let base;

before(async () => {
  const app = await createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataFile, { force: true });
});

async function json(path, opts) {
  const res = await fetch(base + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, body };
}

test("health and empty board", async () => {
  const h = await json("/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.dry, true);
  const b = await json("/api/board");
  assert.deepEqual(b.body.listings, []);
});

test("dry bid ranks the url", async () => {
  const r = await json("/bid/dry?amount=0.05", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://zero.base", description: "from test" }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.listing.rank, 1);
  assert.equal(r.body.listing.bid_usdc, 0.05);
});

test("skill.md is served", async () => {
  const res = await fetch(base + "/skill.md");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /Rank is the bid/);
  assert.match(text, /POST \/bid/);
});

test("a configured wallet disables dry even if X402_DRY=1", async () => {
  const liveFile = path.join(os.tmpdir(), `outbid-live-${process.pid}.json`);
  const { createApp: createLive } = await import("../src/server.js");
  const app = await createLive({
    X402_DRY: "1",
    EVM_ADDRESS: "0x1111111111111111111111111111111111111111",
    DATA_FILE: liveFile,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}/bid/dry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://no.dry", amount: 0.05 }),
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  srv.close();
  fs.rmSync(liveFile, { force: true });
  assert.equal(res.status, 403);
  assert.equal(health.dry, false);
  assert.equal(health.live_402, true);
});

test("POST /bid refuses when live 402 is not configured", async () => {
  const r = await json("/bid?amount=0.01", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://needs-wallet.example" }),
  });
  // No payTo configured: middleware is off, so this would write a free bid.
  // That is a footgun — refuse unless dry endpoint is used when live 402 is off.
  assert.equal(r.status, 403);
});

test("bid endpoints rate limit per IP with Retry-After", async () => {
  const limitedFile = path.join(os.tmpdir(), `outbid-ratelimit-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: limitedFile,
    RATE_LIMIT_MAX: "3",
    RATE_LIMIT_WINDOW_MS: "60000",
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = (ip) =>
      fetch(`${b}/bid/dry`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ url: "https://rl.example", amount: 0.01 }),
      });
    for (let i = 0; i < 3; i++) {
      assert.equal((await post("1.2.3.4")).status, 200, `request ${i + 1} under the limit`);
    }
    const limited = await post("1.2.3.4");
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.ok(body.retry_after >= 1);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // a different client IP is not limited
    assert.equal((await post("5.6.7.8")).status, 200);
    // GET endpoints are never limited
    assert.equal((await fetch(`${b}/api/board`)).status, 200);
  } finally {
    srv.close();
    fs.rmSync(limitedFile, { force: true });
  }
});
