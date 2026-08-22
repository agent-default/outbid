import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createStore, formatPrice, normalizeTarget, parseAmount, MIN_USDC } from "./store.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const EVM_ADDRESS = env.EVM_ADDRESS || "";
  const SVM_ADDRESS = env.SVM_ADDRESS || "";
  const live = Boolean(EVM_ADDRESS || SVM_ADDRESS);
  // Dry bids and live 402s never share a board: a wallet being configured
  // turns dry off, and each mode defaults to its own data file.
  const dry = env.X402_DRY === "1" && !live;
  return {
    PORT: Number(env.PORT || 4021),
    HOST: env.HOST || "127.0.0.1",
    live,
    dry,
    dryRequested: env.X402_DRY === "1",
    FACILITATOR_URL: env.FACILITATOR_URL || "https://x402.org/facilitator",
    EVM_ADDRESS,
    SVM_ADDRESS,
    EVM_NETWORK: env.EVM_NETWORK || "eip155:84532",
    SVM_NETWORK: env.SVM_NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    DATA_FILE:
      env.DATA_FILE ||
      path.join(__dirname, "..", "data", live ? "board.json" : "board.dry.json"),
    DEAD_LETTER_FILE:
      env.DEAD_LETTER_FILE || path.join(__dirname, "..", "data", "settled-uncredited.jsonl"),
  };
}

const publicDir = path.join(__dirname, "public");

export async function createApp(overrides = {}) {
  const cfg = resolveConfig(overrides);
  const store = createStore(cfg.DATA_FILE);

  function meta() {
    return {
      name: "outbid",
      rule: "rank is the bid",
      min_usdc: MIN_USDC,
      claim_1_for: store.claimPrice(),
      dry: cfg.dry,
      networks: [
        cfg.EVM_ADDRESS ? { network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS } : null,
        cfg.SVM_ADDRESS ? { network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS } : null,
      ].filter(Boolean),
      facilitator: cfg.FACILITATOR_URL,
      bid: 'POST /bid  body {"url","amount","description"}',
    };
  }

  // The bid amount steers the 402 challenge ONLY. What gets credited is the
  // amount the facilitator actually settled, read in the onAfterSettle hook.
  function priceFromContext(ctx) {
    const raw = ctx.adapter.getQueryParam?.("amount") ?? ctx.adapter.getBody?.()?.amount;
    const parsed = parseAmount(raw);
    return formatPrice(parsed.ok ? parsed.dollars : MIN_USDC);
  }

  function deadLetter(record) {
    try {
      fs.mkdirSync(path.dirname(cfg.DEAD_LETTER_FILE), { recursive: true });
      fs.appendFileSync(cfg.DEAD_LETTER_FILE, JSON.stringify(record) + "\n");
    } catch (err) {
      console.error("dead-letter write failed", err, record);
    }
  }

  async function mountX402(app) {
    if (!cfg.live) {
      if (cfg.dryRequested) {
        console.warn("No EVM_ADDRESS or SVM_ADDRESS — live 402 disabled. Dry bids only.");
      }
      return { live: false };
    }
    if (cfg.dryRequested) {
      console.warn("X402_DRY=1 ignored: a receiving wallet is configured, dry bids are disabled.");
    }

    const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const { declareDiscoveryExtension } = await import("@x402/extensions/bazaar");

    const facilitatorClient = new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL });
    const resourceServer = new x402ResourceServer(facilitatorClient);

    if (cfg.EVM_ADDRESS) {
      const { ExactEvmScheme } = await import("@x402/evm/exact/server");
      resourceServer.register(cfg.EVM_NETWORK, new ExactEvmScheme());
    }
    if (cfg.SVM_ADDRESS) {
      const { ExactSvmScheme } = await import("@x402/svm/exact/server");
      resourceServer.register(cfg.SVM_NETWORK, new ExactSvmScheme());
    }

    // Commit point. Fires only after the facilitator reports a successful
    // settlement; the handler itself never writes the board. Amount comes from
    // the settled requirements (atomic USDC), payer/tx from the settle result,
    // url/description from the request body via the transport context.
    resourceServer.onAfterSettle(async (context) => {
      const request = context.transportContext?.request;
      if (request?.path !== "/bid") return;
      // Exact-scheme SettleResponse has no `amount` (that's upto). The atomic
      // that was settled is requirements.amount. result.amount wins if present.
      const record = {
        tx: context.result?.transaction,
        network: context.result?.network ?? context.requirements?.network,
        payer: context.result?.payer,
        atomic: context.result?.amount ?? context.requirements?.amount,
        body: request?.adapter?.getBody?.(),
        phase: context.phase,
        at: new Date().toISOString(),
      };
      try {
        if (context.result?.success === false) return;
        const credited = store.credit({
          url: record.body?.url,
          description: record.body?.description,
          atomic: String(record.atomic),
          payer: record.payer ?? null,
          tx: record.tx,
          network: record.network ?? null,
        });
        if (!credited.ok) {
          deadLetter({ ...record, error: credited.error });
          console.error("settled but NOT credited", credited.error, record);
          return;
        }
        console.log(
          credited.replay ? "settle replay ignored" : "credited",
          record.tx,
          credited.listing ? `#${credited.listing.rank} ${credited.listing.url} $${credited.listing.bid_usdc}` : "",
        );
      } catch (err) {
        // Never throw out of this hook: the money moved; losing the credit to a
        // 500 would be worse. Record it for manual replay instead.
        deadLetter({ ...record, error: String(err) });
        console.error("settled but NOT credited", err, record);
      }
    });

    const paidAccepts = [];
    if (cfg.EVM_ADDRESS) {
      paidAccepts.push({ scheme: "exact", price: priceFromContext, network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS });
    }
    if (cfg.SVM_ADDRESS) {
      paidAccepts.push({ scheme: "exact", price: priceFromContext, network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS });
    }

    app.use(
      paymentMiddleware(
        {
          "POST /bid": {
            accepts: paidAccepts,
            description:
              "Pay USDC to add that amount to a URL's rank on the public board. Rank is the bid. The amount you pay is the amount credited.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                method: "POST",
                bodyType: "json",
                input: { url: "https://example.com", amount: 0.05, description: "one line" },
                inputSchema: {
                  properties: {
                    url: { type: "string", description: "https URL or @handle to rank" },
                    amount: {
                      type: "number",
                      description: "USDC to bid, min 0.01, whole cents. Sets the 402 price.",
                    },
                    description: { type: "string", description: "one line, max 280 chars" },
                  },
                  required: ["url", "amount"],
                },
                output: {
                  example: {
                    ok: true,
                    accepted: { url: "https://example.com", amount_usdc: 0.05 },
                    settlement: "pending",
                    board: "GET /api/board",
                  },
                },
              }),
            },
          },
        },
        resourceServer,
      ),
    );
    return { live: true };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(publicDir));

  const x402 = await mountX402(app);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, ...meta(), live_402: x402.live, listings: store.ranked().length });
  });

  app.get("/api/meta", (_req, res) => res.json(meta()));
  app.get("/api/board", (_req, res) => res.json({ listings: store.ranked(), claim_1_for: store.claimPrice() }));

  app.get("/go/:id", (req, res) => {
    const hit = store.click(req.params.id);
    if (!hit.ok) return res.status(404).send("not found");
    const target = hit.listing.url.startsWith("@")
      ? `https://x.com/${hit.listing.url.slice(1)}`
      : hit.listing.url;
    res.redirect(302, target);
  });

  // Live path: by the time this handler runs the payment is VERIFIED but not
  // yet settled. Validate only — a 4xx here makes the middleware cancel the
  // settlement, so an invalid bid never takes money. The board write happens
  // in onAfterSettle above, from settled facts.
  app.post("/bid", (req, res) => {
    if (!x402.live) {
      return res.status(403).json({
        ok: false,
        error: "live 402 disabled — set EVM_ADDRESS and/or SVM_ADDRESS, or POST /bid/dry while X402_DRY=1",
      });
    }
    const target = normalizeTarget(req.body?.url);
    if (!target.ok) return res.status(400).json(target);
    const parsed = parseAmount(req.query.amount ?? req.body?.amount);
    if (!parsed.ok) return res.status(400).json(parsed);
    return res.json({
      ok: true,
      accepted: { url: target.display, amount_usdc: parsed.dollars },
      settlement: "pending",
      note: "credited on settlement with the settled amount; tx in the PAYMENT-RESPONSE header",
      board: "GET /api/board",
    });
  });

  app.post("/bid/dry", (req, res) => {
    if (!cfg.dry) return res.status(403).json({ ok: false, error: "dry bids disabled" });
    const parsed = parseAmount(req.query.amount ?? req.body?.amount);
    if (!parsed.ok) return res.status(400).json(parsed);
    const result = store.addBid({
      url: req.body?.url,
      description: req.body?.description || "",
      add_usdc: parsed.dollars,
      dry: true,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  });

  app.get("/skill.md", (_req, res) => {
    res.type("text/markdown").send(skillMd(cfg));
  });

  app.get("/.well-known/x402", (_req, res) => {
    const accepts = [];
    if (cfg.EVM_ADDRESS) accepts.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS });
    if (cfg.SVM_ADDRESS) accepts.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS });
    res.json({
      x402Version: 2,
      service: { name: "outbid", description: "Pay-to-rank board. Rank is the bid." },
      resources: [
        {
          url: "/bid",
          method: "POST",
          description:
            'Add USDC to a listing. Body {"url","amount","description"} — amount in dollars sets the 402 price, min 0.01. The settled amount is what gets credited.',
          accepts,
        },
      ],
      free_resources: [{ url: "/api/board", method: "GET" }, { url: "/skill.md", method: "GET" }],
    });
  });

  app._outbid = { store, cfg, live: x402.live };
  return app;
}

function skillMd(cfg) {
  return `---
name: outbid
description: Pay USDC over x402 to rank a URL. Rank is the bid. Nothing else.
---

# outbid

Public board. Highest cumulative USDC on a URL is #1.

Free:
- GET /api/board
- GET /api/meta
- GET /skill.md

Pay (HTTP 402):
- POST /bid
- JSON body: {"url":"https://example.com","amount":0.05,"description":"one line"}
- amount is USDC dollars, min ${MIN_USDC}, whole cents. It sets the 402 price. (?amount= query also accepted.)
- Unpaid request returns 402 with PAYMENT-REQUIRED.
- Retry with PAYMENT-SIGNATURE. Any x402 client works (wrapFetchWithPayment, agentcash, @x402/fetch).
- What you PAY is what gets credited — the board records the settled amount, not the request's claim.
- The settlement tx is echoed in the PAYMENT-RESPONSE header; the row appears on GET /api/board.

Paying again on the same URL adds to its bid.

${cfg.dry ? "This instance has X402_DRY=1 and no wallet: POST /bid/dry records a bid without chain settlement (dev only)." : ""}
`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createApp();
  const { cfg } = app._outbid;
  app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(
      `outbid http://${cfg.HOST}:${cfg.PORT}  dry=${cfg.dry}  evm=${Boolean(cfg.EVM_ADDRESS)}  svm=${Boolean(cfg.SVM_ADDRESS)}  data=${cfg.DATA_FILE}`,
    );
  });
}
