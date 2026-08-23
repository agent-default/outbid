import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Phase 3 /call spec is named-slot vs /route; inventory gate failed; src has no /call", () => {
  const spec = fs.readFileSync(path.join(root, "graph/nodes/call.md"), "utf8");
  const demand = fs.readFileSync(path.join(root, "graph/nodes/demand.md"), "utf8");
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "src/store.js"), "utf8");
  const inventory = "13 rpc-ish bazaar rows = 12 hergertsynthora + 1 onesource";

  for (const t of ["Phase 3", "/call", "named slot", "inventory gate", "failed", "hergertsynthora", "onesource", "/route", "#1"]) {
    assert.match(spec, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.equal(demand.includes(inventory), true);
  assert.equal(spec.includes(inventory), true);

  const cutPath = path.join(root, "research/x402scan/x402scan-cut-result.json");
  if (fs.existsSync(cutPath)) {
    const cut = JSON.parse(fs.readFileSync(cutPath, "utf8"));
    assert.equal(cut.organic_rows, 13);
  }

  assert.equal(/["'`]\/call["'`]/.test(server), false);
  assert.equal(/named.?slot/i.test(store), false);
});
