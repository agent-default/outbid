import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-authmd-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-authmd-${process.pid}.jsonl`);
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

test("/auth.md H1 names auth.md", async () => {
  const res = await fetch(base + "/auth.md");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /^# auth\.md\b/m);
  assert.match(text, /x402/);
  assert.match(text, /Do not POST/);
});

test("PRM and AS metadata are honest (no token_endpoint)", async () => {
  const prmRes = await fetch(base + "/.well-known/oauth-protected-resource");
  assert.equal(prmRes.status, 200);
  assert.equal(prmRes.headers.get("access-control-allow-origin"), "*");
  const prm = await prmRes.json();
  assert.ok(prm.resource && Array.isArray(prm.authorization_servers) && prm.authorization_servers.length === 1);
  assert.ok(Array.isArray(prm.scopes_supported));
  assert.ok(prm.bearer_methods_supported.includes("header"));
  const asRes = await fetch(base + "/.well-known/oauth-authorization-server");
  const as = await asRes.json();
  assert.equal(asRes.status, 200);
  assert.equal(as.issuer, prm.authorization_servers[0]);
  assert.equal(as.token_endpoint, undefined);
  assert.equal(as.agent_auth?.skill, `${base}/auth.md`);
  assert.equal(as.agent_auth?.register_uri, `${base}/auth.md`);
  assert.deepEqual(as.agent_auth?.identity_types_supported, ["anonymous"]);
  assert.ok(as.agent_auth?.anonymous?.credential_types_supported?.includes("x402"));
  assert.equal(as.agent_auth?.claim_uri, undefined);
  assert.equal(as.agent_auth?.revocation_uri, undefined);
});
