import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataFile = path.join(os.tmpdir(), `outbid-sitemap-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-sitemap-${process.pid}.jsonl`);
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

test("sitemap.xml lists free URLs and robots.txt points at it", async () => {
  const res = await fetch(base + "/sitemap.xml");
  const xml = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /xml/);
  assert.match(xml, /<urlset /);
  for (const loc of ["https://outbid.sh/", "https://outbid.sh/skill.md", "https://outbid.sh/top"]) {
    assert.match(xml, new RegExp(`<loc>${loc.replaceAll(".", "\\.")}</loc>`));
  }
  assert.doesNotMatch(xml, /\/route/);
  assert.doesNotMatch(xml, /\/next/);
  assert.doesNotMatch(xml, /\/bid/);
  const robots = await (await fetch(base + "/robots.txt")).text();
  assert.match(robots, /^Sitemap: https:\/\/outbid\.sh\/sitemap\.xml$/m);
});
