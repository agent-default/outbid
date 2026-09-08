import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { localUrl, localRpc, confirmTx } from "./local-rpc.mjs";

test("local runner refuses remote hosts containing loopback text", () => {
  for (const url of [
    "https://example.com/?localhost", "https://127.0.0.1.example.com",
    "http://127.0.0.1@evil.test", "http://evil.test/#localhost",
    "http://127.0.0.1/?redirect=evil", "http://127.0.0.1/path", "https://127.0.0.1/",
  ]) {
    assert.throws(() => localUrl(url), /non-loopback/);
  }
  assert.equal(localUrl("http://localhost:8899").hostname, "127.0.0.1");
  assert.equal(localUrl("http://[::1]:8899").hostname, "[::1]");
});

test("RPC never follows redirects", async (t) => {
  let targetHits = 0;
  const target = http.createServer((req, res) => { targetHits++; res.end("{}"); });
  const redirect = http.createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}` });
    res.end();
  });
  for (const server of [target, redirect]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  const rpc = localRpc(`http://127.0.0.1:${redirect.address().port}`);
  await assert.rejects(rpc("sendTransaction", ["disposable-test"]), /redirects refused/);
  assert.equal(targetHits, 0);
});

test("confirmation timeout and failed execution fail the run", async () => {
  for (const status of [null, { err: null, confirmationStatus: "processed" }]) {
    await assert.rejects(confirmTx(async () => ({ value: [status] }), "missing", 1), /timeout/);
  }
  const failed = { err: { InstructionError: [0, "InvalidArgument"] }, confirmationStatus: "confirmed" };
  await assert.rejects(confirmTx(async () => ({ value: [failed] }), "failed"), /transaction failed/);
  await confirmTx(async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }), "ok");
});
