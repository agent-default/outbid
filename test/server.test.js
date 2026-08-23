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
  assert.match(text, /default route/);
  assert.match(text, /POST \/bid/);
  assert.match(text, /get_top/);
  assert.match(text, /Base or Solana USDC/);
  assert.doesNotMatch(text, /Settlement chain \(Solana USDC\)/);
  const top = text.indexOf("/top");
  const bid = text.indexOf("/bid");
  assert.ok(top !== -1 && bid !== -1 && top < bid, "skill.md must teach get_top before bid");
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

test("GET /route 404s on an empty board", async () => {
  const data = path.join(os.tmpdir(), `outbid-route-empty-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/route`, { redirect: "manual" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /no #1/);
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
});

test("GET /route 302s to #1 and counts a dispatch, not a click", async () => {
  const data = path.join(os.tmpdir(), `outbid-route-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fetch(`${b}/bid/dry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://route.example/x402", amount: 0.05, description: "seller" }),
    });
    const res = await fetch(`${b}/route`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://route.example/x402");
    assert.equal(res.headers.get("x-outbid-rank"), "1");
    assert.ok(res.headers.get("x-outbid-listing"));
    assert.match(res.headers.get("x-outbid-note") || "", /you were sent here because you were #1/i);
    const board = await (await fetch(`${b}/api/board`)).json();
    assert.equal(board.listings[0].dispatches, 1);
    assert.equal(board.listings[0].clicks, 0);
    assert.equal(board.dispatch_total, 1);
    const skill = await (await fetch(`${b}/skill.md`)).text();
    assert.match(skill, /GET .*\/route/);
    assert.match(skill, /default routing table|#1 is the default route/i);
    assert.match(skill, /forward_headers/);
    const idx = skill.indexOf("/route");
    const bid = skill.lastIndexOf("/bid");
    assert.ok(idx !== -1 && bid !== -1 && idx < bid, "skill.md must teach route before bid");
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
});

test("GET /top peeks at #1 without counting a dispatch", async () => {
  const data = path.join(os.tmpdir(), `outbid-top-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const empty = await fetch(`${b}/top`);
    assert.equal(empty.status, 404);
    await fetch(`${b}/bid/dry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://top.example/mcp", amount: 0.05 }),
    });
    const peek = await (await fetch(`${b}/top`)).json();
    assert.equal(peek.ok, true);
    assert.equal(peek.url, "https://top.example/mcp");
    assert.equal(peek.rank, 1);
    const board = await (await fetch(`${b}/api/board`)).json();
    assert.equal(board.listings[0].dispatches, 0);
    assert.equal(board.dispatch_total, 0);
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
});

test("POST /dispatch 302s; Accept json returns URL + headers to forward", async () => {
  const data = path.join(os.tmpdir(), `outbid-dispatch-http-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fetch(`${b}/bid/dry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://seller.example/x402", amount: 0.05 }),
    });
    const redir = await fetch(`${b}/dispatch`, { method: "POST", redirect: "manual" });
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get("location"), "https://seller.example/x402");
    const json = await fetch(`${b}/route`, {
      headers: { accept: "application/json" },
    });
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.equal(body.url, "https://seller.example/x402");
    assert.equal(body.forward_headers["X-Outbid-Rank"], "1");
    assert.match(body.forward_headers["X-Outbid-Note"], /you were sent here because you were #1/i);
    const board = await (await fetch(`${b}/api/board`)).json();
    assert.equal(board.dispatch_total, 2);
    assert.equal(board.listings[0].clicks, 0);
    const well = await (await fetch(`${b}/.well-known/x402`)).json();
    const free = (well.free_resources || []).map((r) => `${r.method} ${new URL(r.url).pathname}`);
    assert.ok(free.includes("GET /top"));
    assert.ok(free.includes("POST /dispatch"));
    const topIdx = free.findIndex((x) => x === "GET /top");
    const bidPaid = (well.resources || []).some((r) => r.url.endsWith("/bid"));
    assert.ok(bidPaid);
    assert.ok(topIdx === 0, "get_top must be the first free resource");
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
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
