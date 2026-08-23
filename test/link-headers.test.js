import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-link-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-link-${process.pid}.jsonl`);
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

test("GET / Link headers advertise catalog, x402, skill, llms", async () => {
  const res = await fetch(base + "/", { headers: { accept: "text/html" } });
  assert.equal(res.status, 200);
  const link = res.headers.get("link") || "";
  assert.match(link, /rel="api-catalog"/);
  assert.match(link, /\/\.well-known\/api-catalog/);
  assert.match(link, /rel="service-desc"/);
  assert.match(link, /\/\.well-known\/x402/);
  assert.match(link, /rel="service-doc"/);
  assert.match(link, /\/skill\.md/);
  assert.match(link, /rel="describedby"/);
  assert.match(link, /\/llms\.txt/);
  const md = await fetch(base + "/", { headers: { accept: "text/markdown" } });
  assert.match(md.headers.get("link") || "", /rel="api-catalog"/);
});
