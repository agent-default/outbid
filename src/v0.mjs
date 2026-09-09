import { Router } from "express";
import { address } from "@solana/kit";
import { createSolana, tokenMeta } from "./solana.mjs";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

function isNoLock(err) {
  return /no lock account/i.test(err.message);
}

function isUnavailable(err) {
  return /(?:rpc.*HTTP|JSON-RPC|timeout|connection|NetworkError|fetch|abort|unavailable|mint account not found)/i.test(err.message);
}

export function v0Router({ rpcUrl = DEFAULT_RPC } = {}) {
  const solana = createSolana(rpcUrl);
  const r = Router();

  r.get("/token", async (_req, res) => {
    const meta = tokenMeta();
    try {
      const supply = await solana.tokenSupply();
      res.json({ ok: true, ...meta, ...supply });
    } catch (err) {
      res.status(503).json({ ok: false, ...meta, error: "chain unavailable", reason: err.message });
    }
  });

  r.get("/lock/:pubkey", async (req, res) => {
    const { pubkey } = req.params;
    try {
      address(pubkey);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid pubkey" });
    }
    try {
      const lock = await solana.lock(pubkey);
      res.json(lock);
    } catch (err) {
      if (isNoLock(err)) {
        return res.status(404).json({ ok: false, error: "no lock" });
      }
      if (isUnavailable(err)) {
        return res.status(503).json({ ok: false, error: "chain unavailable", reason: err.message });
      }
      return res.status(500).json({ ok: false, error: "lock unreadable", reason: err.message });
    }
  });

  return r;
}
