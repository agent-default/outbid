import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("watch-path-a-1 rejects the 2026-09-11 33W8 false signal", () => {
  const r = spawnSync(
    "python3",
    ["scripts/test_watch_path_a_1.py", "-v"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("revenue conversion brief pins live funnel numbers", () => {
  const r = spawnSync(
    "python3",
    ["scripts/test_conversion_brief.py", "-v"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("path-a-conversion-pulse strips house specs and exits 0", () => {
  const r = spawnSync(
    "python3",
    ["scripts/test_path_a_conversion_pulse.py", "-v"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
