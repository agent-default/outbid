import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const stage of ["import", "startup"]) {
  test(`cross-rail check fails when server ${stage} fails`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbid-check-"));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.mkdirSync(path.join(dir, "test"));
      fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
      fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
      fs.copyFileSync(path.join(root, "src/store.js"), path.join(dir, "src/store.js"));
      fs.copyFileSync(path.join(root, "test/crossrail.e2e.test.js"), path.join(dir, "test/crossrail.e2e.test.js"));
      const failure = `throw new Error("injected ${stage} failure");`;
      fs.writeFileSync(path.join(dir, "src/server.js"), stage === "import"
        ? failure : `export async function createApp() { ${failure} }`);
      const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/crossrail.e2e.test.js"], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const output = result.stdout + result.stderr;
      assert.match(output, new RegExp(`injected ${stage} failure`));
      assert.notEqual(result.status, 0, `broken integration reported success:\n${output}`);
      assert.match(output, /# skipped 0\b/, output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
