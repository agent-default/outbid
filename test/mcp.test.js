import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-mcp-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-mcp-${process.pid}.jsonl`);
const { createApp } = await import("../src/server.js");

let server;
let base;

before(async () => {
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: dataFile,
    DISPATCH_LOG: accessLog,
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(accessLog, { force: true });
});

test("MCP server-card has serverInfo, transport, capabilities", async () => {
  const res = await fetch(base + "/.well-known/mcp/server-card.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /json/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const card = await res.json();
  assert.ok(card.serverInfo?.name && card.serverInfo?.version);
  assert.equal(card.transport?.type, "streamable-http");
  assert.ok(String(card.transport?.endpoint || "").endsWith("/mcp"));
  assert.equal(card.capabilities?.tools, true);
  assert.equal(card.capabilities?.resources, false);
  assert.equal(card.capabilities?.prompts, false);
});

test("POST /mcp tools/list and get_skill; does not count dispatch", async () => {
  const before = (await (await fetch(base + "/api/meta")).json()).dispatch_total;
  const listed = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await listed.json();
  assert.equal(listed.status, 200);
  const names = (body.result?.tools || []).map((t) => t.name).sort();
  assert.deepEqual(names, ["get_board", "get_skill", "peek_top"]);
  const skill = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_skill" } }),
  });
  const got = await skill.json();
  assert.match(got.result?.content?.[0]?.text || "", /on_init/);
  const after = (await (await fetch(base + "/api/meta")).json()).dispatch_total;
  assert.equal(after, before);
});
