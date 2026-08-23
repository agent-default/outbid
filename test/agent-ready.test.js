import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-agent-ready-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-agent-ready-${process.pid}.jsonl`);
const { createApp } = await import("../src/server.js");
let server, base;

before(async () => {
  const app = await createApp({
    X402_DRY: "1", EVM_ADDRESS: "", SVM_ADDRESS: "", DATA_FILE: dataFile, DISPATCH_LOG: accessLog,
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(accessLog, { force: true });
});

test("homepage, 404, openapi, markdown Vary", async () => {
  const htmlRes = await fetch(base + "/", { headers: { accept: "text/html" } });
  const html = await htmlRes.text();
  assert.equal(htmlRes.status, 200);
  assert.match(html, /<h1[^>]*>\s*outbid\s*<\/h1>/i);
  const visible = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.ok(visible.length >= 500, `visible ${visible.length}`);
  const md = await fetch(base + "/", { headers: { accept: "text/markdown" } });
  assert.match(md.headers.get("content-type") || "", /text\/markdown/);
  assert.match(md.headers.get("vary") || "", /Accept/i);
  const miss = await fetch(base + "/no-such-path-xyz");
  assert.equal(miss.status, 404);
  assert.match(miss.headers.get("content-type") || "", /text\/markdown/);
  assert.match(await miss.text(), /\/sitemap\.xml/);
  const js = await fetch(base + "/no-such-path-xyz", { headers: { accept: "application/json" } });
  const body = await js.json();
  assert.equal(js.status, 404);
  assert.equal(body.code, "not_found");
  assert.ok(body.hint);
  const spec = await (await fetch(base + "/openapi.json")).json();
  assert.match(String(spec.openapi), /^3\./);
  for (const p of ["/top", "/route", "/bid", "/health", "/api/board", "/skill.md"]) assert.ok(spec.paths?.[p], p);
  assert.equal(spec.paths["/call"], undefined);
});
