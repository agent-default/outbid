#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.RPC_URL) {
  throw new Error("unset RPC_URL: this runner owns its offline Surfpool instance");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = fs.readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "test", name));
const commands = [
  ["cargo", ["fmt", "--check"]],
  ["cargo", ["test", "--lib", "--features", "no-entrypoint", "--locked"]],
  ["cargo-build-sbf", ["--", "--locked"]],
  [process.execPath, ["--test", "--test-concurrency=1", ...tests]],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
