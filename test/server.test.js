import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-board-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-access-${process.pid}.jsonl`);
process.env.X402_DRY = "1";
process.env.DATA_FILE = dataFile;
process.env.DISPATCH_LOG = accessLog;
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
  fs.rmSync(accessLog, { force: true });
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

test("skill.md is the canonical skill file, byte for byte", async () => {
  const res = await fetch(base + "/skill.md");
  const text = await res.text();
  assert.equal(res.status, 200);
  const canon = fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  assert.equal(text, canon, "served /skill.md must be byte-identical to skill/SKILL.md");
  assert.match(text, /on_init/);
  assert.match(text, /on_fail/);
  assert.match(text, /Do not follow a 302/);
  assert.doesNotMatch(text, /when you need a next URL/i);
});

test("route hits land in the access log with wire attribution", async () => {
  await fetch(base + "/route", {
    headers: { accept: "application/json", "user-agent": "outbid-test-eyes" },
  });
  const deadline = Date.now() + 1000;
  let hit;
  while (!hit && Date.now() < deadline) {
    try {
      hit = fs
        .readFileSync(accessLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .find((l) => l.ua === "outbid-test-eyes");
    } catch {}
    if (!hit) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(hit, "no access-log line for the probe");
  assert.equal(hit.method, "GET");
  assert.equal(hit.path, "/route");
  assert.equal(hit.status, 200);
  assert.ok(hit.ip, "ip missing");
  assert.ok(hit.listing_id, "listing_id missing");
  assert.ok(hit.ts && hit.accept.includes("application/json"));
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
    assert.match(skill, /Exception handler for the next URL/);
    assert.match(skill, /forward_headers/);
    assert.match(skill, /Have a wallet\? GET https:\/\/outbid\.sh\/next/);
    assert.match(skill, /highest settled bid/);
    assert.match(skill, /Those are different jobs/);
    const idx = skill.indexOf("/route");
    const next = skill.indexOf("/next");
    const bid = skill.lastIndexOf("/bid");
    assert.ok(idx !== -1 && bid !== -1 && idx < bid, "skill.md must teach route before bid");
    assert.ok(next !== -1 && idx < next && next < bid, "skill.md must teach free /route before paid /next");
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

test("HEAD /bid is 200 with Allow: POST for catalog health checks", async () => {
  const res = await fetch(base + "/bid", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("allow"), "POST");
});

test("GET /bid is 405 with Allow: POST, not 404", async () => {
  const res = await fetch(base + "/bid");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("HEAD never counts a dispatch or leaks proof headers", async () => {
  const before = (await json("/api/meta")).body.dispatch_total;
  const r = await fetch(base + "/route", { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-outbid-rank"), null, "proof headers must not ride HEAD");
  const n = await fetch(base + "/next", { method: "HEAD" });
  assert.equal(n.status, 402);
  assert.equal(n.headers.get("x-outbid-rank"), null);
  const after = (await json("/api/meta")).body.dispatch_total;
  assert.equal(after, before, "HEAD must not count");
});

test("GET /next is 403 when live 402 is off; GET /route stays unpaid", async () => {
  const n = await json("/next");
  assert.equal(n.status, 403);
  const route = await fetch(base + "/route", { redirect: "manual" });
  assert.equal(route.status, 302);
  const well = await (await fetch(base + "/.well-known/x402")).json();
  const wellJson = await (await fetch(base + "/.well-known/x402.json")).json();
  assert.deepEqual(wellJson, well, "/.well-known/x402.json must be the same handler, not a snapshot");
  assert.ok((well.resources || []).some((r) => r.url.endsWith("/next")));
  assert.ok((well.free_resources || []).some((r) => r.url.endsWith("/route")));
});

async function waitLog(file, pred, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
      const hit = rows.find(pred);
      if (hit) return hit;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("jsonl prefers x-vercel-forwarded-for over edge XFF", async () => {
  const data = path.join(os.tmpdir(), `outbid-vercel-ip-${process.pid}.json`);
  const logFile = path.join(os.tmpdir(), `outbid-vercel-ip-${process.pid}.jsonl`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
    DISPATCH_LOG: logFile,
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fetch(`${b}/skill.md`, {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.50, 18.222.77.226",
        "x-forwarded-for": "18.222.77.226",
      },
    });
    const vercel = await waitLog(logFile, (l) => l.ip === "203.0.113.50");
    assert.ok(vercel, "expected Vercel client hop in jsonl");
    await fetch(`${b}/skill.md`, {
      headers: { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": "192.0.2.9" },
    });
    const cf = await waitLog(logFile, (l) => l.ip === "192.0.2.9");
    assert.ok(cf, "expected cf-connecting-ip when Vercel header absent");
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
    fs.rmSync(logFile, { force: true });
  }
});

test("bid limiter keys on vercel client hop not edge XFF", async () => {
  const data = path.join(os.tmpdir(), `outbid-vercel-rl-${process.pid}.json`);
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: data,
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "60000",
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const post = (vercel) =>
    fetch(`${b}/bid/dry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-forwarded-for": vercel,
        "x-forwarded-for": "18.222.77.226",
      },
      body: JSON.stringify({ url: "https://rl.example", amount: 0.01 }),
    });
  try {
    assert.equal((await post("203.0.113.1")).status, 200);
    assert.equal((await post("203.0.113.2")).status, 200);
    assert.equal((await post("203.0.113.1")).status, 429);
  } finally {
    srv.close();
    fs.rmSync(data, { force: true });
  }
});
