import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dumps = path.join(root, "research", "x402scan");

function load(name) {
  const p = path.join(dumps, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("organic cut is 13 rows / ~$1010 after Clash+AnySpend; live #1 is not in hunt diets", () => {
  const cut = load("x402scan-cut-result.json");
  const buyer = load("x402scan-buyer-cut.json");
  const hunt = load("x402scan-hunt-verify.json");
  const bazaar = load("x402scan-bazaar-30d.json");
  if (!cut || !buyer || !hunt || !bazaar) {
    return; // dumps gitignored; skip off-box
  }

  assert.equal(cut.organic_rows, 13);
  assert.equal(buyer.survivors.length, 13);
  assert.equal(cut.organic_origins, 12);
  assert.equal(cut.organic_volume_usdc_30d, 1009.71);
  const vol = buyer.survivors.reduce((s, r) => s + r.volume_usdc, 0);
  assert.equal(Number(vol.toFixed(2)), 1009.71);
  assert.deepEqual(cut.wash_dropped, [
    "https://x402.clashofcoins.com",
    "https://x402.anyspend.com",
  ]);

  const origins = buyer.survivors.flatMap((s) => s.origins);
  assert.equal(origins.some((o) => o.includes("onesource.io")), true);
  assert.equal(origins.some((o) => o.includes("hergertsynthora")), false);
  assert.equal(origins.some((o) => o.includes("mainnet-beta.solana.com")), false);

  const huntWallets = [
    "0x27abcddd44c4959ac729d080703e677f13a3248c",
    "0x5e95cd8d85d0dc7069a9eaa9e92017bc4903a55e",
    "0x14bd18e99aced6950722468f262acf8c4f085f76",
    "0x1cb8d1456efc633da6eeaa038033edcbcdc0bdff",
  ];
  for (const w of huntWallets) {
    const row = hunt.rows.find((r) => r.wallet === w);
    assert.ok(row, w);
    const blob = JSON.stringify(row.organic_gt1 || []);
    assert.equal(blob.includes("mainnet-beta.solana.com"), false);
    assert.equal(blob.includes("publicnode.com"), false);
  }

  let hergertRows = 0;
  let onesourceRows = 0;
  const rpcHosts = new Set();
  for (const row of bazaar.bazaar) {
    const blob = JSON.stringify(row);
    if (blob.includes("hergertsynthora.com")) hergertRows += 1;
    if (blob.includes("onesource.io")) onesourceRows += 1;
    for (const o of row.origins || []) {
      const origin = typeof o === "string" ? o : o.origin || "";
      const host = origin.replace(/^https?:\/\//, "").split("/")[0];
      if (host.startsWith("rpc-") && host.endsWith("hergertsynthora.com")) rpcHosts.add(host);
    }
  }
  assert.equal(hergertRows, 1, "hergert is one bazaar seller, not 12 operators");
  assert.equal(onesourceRows, 1);
  assert.equal(rpcHosts.size, 10);
  assert.equal(hergertRows === 1 && onesourceRows === 1, true, "/call gate still one-vendor");

  const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.equal(/["'`]\/call["'`]/.test(server), false);
});
