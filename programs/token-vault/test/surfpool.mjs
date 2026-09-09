import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localRpc } from "./local-rpc.mjs";

async function ports() {
  const servers = [net.createServer(), net.createServer()];
  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

export async function startSurfpool() {
  const [port, wsPort] = await ports();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "outbid-vault-"));
  const proc = spawn("surfpool", [
    "start", "--offline", "--no-deploy", "--ci", "--host", "127.0.0.1",
    "--port", String(port), "--ws-port", String(wsPort), "--airdrop-amount", "0",
    "--block-production-mode", "transaction", "--slot-time", "1",
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let startError;
  proc.on("error", (error) => { startError = error; });
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on("data", (data) => { output = (output + data).slice(-8000); });
  }
  const closed = new Promise((resolve) => proc.once("close", resolve));
  async function stop() {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
  const url = `http://127.0.0.1:${port}`;
  const rpc = localRpc(url);
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (startError || proc.exitCode !== null || proc.signalCode !== null) {
        throw startError || new Error(`Surfpool exited: ${output}`);
      }
      try {
        await rpc("getHealth");
        return { rpc, stop, url };
      } catch {
        await delay(50);
      }
    }
    throw new Error(`Surfpool start timeout: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
