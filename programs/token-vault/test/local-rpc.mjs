import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export function localUrl(value) {
  const url = new URL(value);
  const hosts = ["127.0.0.1", "[::1]", "::1", "localhost"];
  if (url.protocol !== "http:" || !hosts.includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("refusing non-loopback RPC or decorated URL");
  }
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url;
}

export function localRpc(endpoint) {
  const url = localUrl(endpoint);
  let id = 0;
  return async function rpc(method, params = []) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const reply = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 30_000,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`RPC HTTP ${res.statusCode}; redirects refused`));
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve(text));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("RPC timeout")));
      req.on("error", reject);
      req.end(body);
    });
    const parsed = JSON.parse(reply);
    if (parsed.error) {
      throw new Error(`${method}: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.result;
  };
}

export async function confirmTx(rpc, signature, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await rpc("getSignatureStatuses", [[signature]]);
    const status = result.value[0];
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (["confirmed", "finalized"].includes(status?.confirmationStatus)) {
      return;
    }
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`confirmation timeout: ${signature}`);
}
