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
  const DATA_FILE =
    env.DATA_FILE ||
    path.join(__dirname, "..", "data", live ? "board.json" : "board.dry.json");
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
    DATA_FILE,
    DISPATCH_LOG:
      env.DISPATCH_LOG ||
      path.join(path.dirname(DATA_FILE), `${path.parse(DATA_FILE).name}.dispatches.jsonl`),
    DEAD_LETTER_FILE:
      env.DEAD_LETTER_FILE || path.join(__dirname, "..", "data", "settled-uncredited.jsonl"),
    RATE_LIMIT_MAX: Number(env.RATE_LIMIT_MAX || 30),
    RATE_LIMIT_WINDOW_MS: Number(env.RATE_LIMIT_WINDOW_MS || 60_000),
    PUBLIC_BASE_URL: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") || null,
  };
}

function firstHop(value) {
  return String(value || "").split(",")[0].trim();
}

// Vercel Funnel: x-vercel-forwarded-for is the client; XFF/socket is often the edge.
function clientIp(req) {
  return (
    firstHop(req.get("x-vercel-forwarded-for")) ||
    firstHop(req.get("cf-connecting-ip")) ||
    firstHop(req.get("x-forwarded-for")) ||
    req.socket?.remoteAddress ||
    null
  );
}

// Sliding-window per-IP limiter for bid endpoints.
function makeBidLimiter({ max, windowMs }) {
  const hits = new Map(); // ip -> [timestamps]
  return (req, res, next) => {
    if (req.method !== "POST" || !req.path.startsWith("/bid")) return next();
    const ip = clientIp(req) || "?";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(ip, recent);
      const retryAfter = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, error: "rate limited", retry_after: retryAfter });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
    next();
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
      top: "GET /top — current #1 JSON (free, not counted)",
      dispatch: "GET /route | POST /dispatch — counted dispatch to #1",
      bid: 'POST /bid  body {"url","amount","description"} (optional)',
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
      const path = request?.path;
      if (path === "/next" || path === "/dispatch/next") {
        if (context.result?.success === false) return;
        const rec = {
          tx: context.result?.transaction,
          network: context.result?.network ?? context.requirements?.network,
          payer: context.result?.payer,
          atomic: String(context.result?.amount ?? context.requirements?.amount),
        };
        try {
          const noted = store.recordNext(rec);
          if (!noted.ok) deadLetter({ ...rec, path, error: noted.error });
          else if (!noted.replay) console.log("next settled", rec.tx, rec.payer);
        } catch (err) {
          deadLetter({ ...rec, path, error: String(err) });
        }
        return;
      }
      if (path !== "/bid") return;
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
    // Known benign race: nextAccepts is shared and rebuilt per request because
    // the middleware captures it by reference and the core's payTo-function
    // path has no option-skip (a resolver failure fails the whole request), so
    // strict matching-rail semantics need this rebuild. If #1 flips while a
    // request is in flight, the fee settles to the payer named in the 402 the
    // caller actually accepted — quote-time semantics, recorded by recordNext.
    const nextAccepts = [];
    const nextPrice = formatPrice(MIN_USDC);
    app.use((req, res, next) => {
      if (req.path !== "/next" && req.path !== "/dispatch/next") return next();
      nextAccepts.length = 0;
      const p = store.ranked()[0]?.last_payer;
      if (!p) return res.status(404).json({ ok: false, error: "no #1 last_payer" });
      if (/^0x[a-fA-F0-9]{40}$/.test(p) && cfg.EVM_ADDRESS) {
        nextAccepts.push({ scheme: "exact", price: nextPrice, network: cfg.EVM_NETWORK, payTo: p });
      } else if (!p.startsWith("0x") && cfg.SVM_ADDRESS) {
        nextAccepts.push({ scheme: "exact", price: nextPrice, network: cfg.SVM_NETWORK, payTo: p });
      }
      if (!nextAccepts.length) return res.status(404).json({ ok: false, error: "no #1 last_payer" });
      next();
    });

    app.use(
      paymentMiddleware(
        {
          "GET /next": {
            accepts: nextAccepts,
            description: "Pay $0.01 USDC to current #1 last_payer for a counted dispatch. GET /route stays free.",
            mimeType: "application/json",
          },
          "POST /dispatch/next": {
            accepts: nextAccepts,
            description: "Same as GET /next. Pay $0.01 to #1 last_payer. POST /dispatch stays free.",
            mimeType: "application/json",
          },
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
  // Only our own reverse proxy (Tailscale funnel / Vercel) can reach the
  // loopback port, so trust its forwarding headers: this makes req.protocol
  // honor x-forwarded-proto (https, not the http loopback origin).
  app.set("trust proxy", true);
  // The x402 middleware builds the 402's resource.url from req.protocol +
  // req.headers.host — NOT our baseUrl() helper. Behind a proxy chain that can
  // leak the origin host (ts.net) and the http scheme. When a public base is
  // configured, force both so every 402 advertises the public name only.
  if (cfg.PUBLIC_BASE_URL) {
    const pub = new URL(cfg.PUBLIC_BASE_URL);
    app.use((req, _res, next) => {
      req.headers.host = pub.host;
      req.headers["x-forwarded-proto"] = pub.protocol.replace(":", "");
      req.headers["x-forwarded-host"] = pub.host;
      next();
    });
  }
  // Eyes: append-only wire log for the caller-facing paths, existing headers
  // only — no new protocol. Mounted before the limiter and the 402 middleware
  // so challenges and 429s leave a trace too. Never blocks or fails a reply.
  const LOGGED_PATHS = new Set(["/route", "/dispatch", "/bid", "/skill.md", "/next", "/dispatch/next", "/.well-known/x402"]);
  fs.mkdirSync(path.dirname(cfg.DISPATCH_LOG), { recursive: true });
  app.use((req, res, next) => {
    if (LOGGED_PATHS.has(req.path)) {
      res.on("finish", () => {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ip: clientIp(req),
          ua: req.headers["user-agent"] || null,
          accept: req.headers["accept"] || null,
          listing_id: res.locals.listing_id ?? null,
        });
        fs.appendFile(cfg.DISPATCH_LOG, line + "\n", (err) => {
          if (err) console.error("access log:", err.message);
        });
      });
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(publicDir));
  // Before the payment middleware: unpaid 402 challenges are the cheap thing
  // to spam, so they get limited too.
  app.use(makeBidLimiter({ max: cfg.RATE_LIMIT_MAX, windowMs: cfg.RATE_LIMIT_WINDOW_MS }));

  const x402 = await mountX402(app);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, ...meta(), live_402: x402.live, listings: store.ranked().length, dispatch_total: store.dispatchCount() });
  });

  app.get("/api/meta", (_req, res) => res.json({ ...meta(), dispatch_total: store.dispatchCount() }));
  app.get("/api/board", (_req, res) =>
    res.json({ listings: store.ranked(), claim_1_for: store.claimPrice(), dispatch_total: store.dispatchCount() }),
  );

  function destinationOf(listing) {
    return listing.url.startsWith("@") ? `https://x.com/${listing.url.slice(1)}` : listing.url;
  }

  function proofHeaders(listing) {
    return {
      "X-Outbid-Rank": "1",
      "X-Outbid-Listing": listing.id,
      "X-Outbid-Bid": String(listing.bid_usdc),
      "X-Outbid-Dispatches": String(listing.dispatches),
      "X-Outbid-Note": "you were sent here because you were #1",
    };
  }

  function wantsJson(req) {
    const accept = String(req.get("accept") || "");
    return accept.includes("application/json") || String(req.query.format || "") === "json";
  }

  // Consume side. 302 Location is for dumb clients. Custom headers on a 302
  // never reach the seller — the agent has to copy them onto the follow-up
  // request. Accept: application/json returns the URL + headers to forward.
  function sendRoute(req, res, forceJson = false) {
    const hit = store.dispatchTop();
    if (!hit.ok) return res.status(404).json({ ok: false, error: hit.error });
    res.locals.listing_id = hit.listing.id;
    const dest = destinationOf(hit.listing);
    const headers = proofHeaders(hit.listing);
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    if (forceJson || wantsJson(req)) {
      return res.json({
        ok: true,
        rank: 1,
        url: dest,
        listing_id: hit.listing.id,
        bid_usdc: hit.listing.bid_usdc,
        dispatches: hit.listing.dispatches,
        forward_headers: headers,
        note: "request this URL and copy forward_headers so the seller can see they were #1",
      });
    }
    return res.redirect(302, dest);
  }

  app.get("/top", (_req, res) => {
    const top = store.ranked()[0];
    if (!top) return res.status(404).json({ ok: false, error: "no #1" });
    return res.json({
      ok: true,
      rank: 1,
      url: destinationOf(top),
      listing: {
        id: top.id,
        url: top.url,
        bid_usdc: top.bid_usdc,
        dispatches: top.dispatches || 0,
        description: top.description || "",
      },
      dispatch: "GET /route or POST /dispatch",
    });
  });

  app.get("/route", (req, res) => sendRoute(req, res));
  app.post("/dispatch", (req, res) => sendRoute(req, res));
  // Paid dispatch is always JSON: a 302 after settlement would strip the
  // proof headers the caller just bought (our own verify client hit this).
  app.get("/next", (req, res) => {
    if (!x402.live) return res.status(403).json({ ok: false, error: "live 402 disabled" });
    return sendRoute(req, res, true);
  });
  app.post("/dispatch/next", (req, res) => {
    if (!x402.live) return res.status(403).json({ ok: false, error: "live 402 disabled" });
    return sendRoute(req, res, true);
  });

  app.get("/go/:id", (req, res) => {
    const hit = store.click(req.params.id);
    if (!hit.ok) return res.status(404).send("not found");
    const target = hit.listing.url.startsWith("@")
      ? `https://x.com/${hit.listing.url.slice(1)}`
      : hit.listing.url;
    res.redirect(302, target);
  });

  // PayAI's catalog monitor HEADs /bid; the POST-only route 404'd, which its
  // uptime check reads as "down". HEAD asserts existence: 200, no body.
  app.head("/bid", (_req, res) => {
    res.set("Allow", "POST");
    res.set("X-Outbid-Note", "POST with x402 payment - see /.well-known/x402");
    res.status(200).end();
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

  // Absolute base URL as seen by the caller. Behind the funnel/tunnel the Host
  // header carries the public name, so served docs are runnable from anywhere
  // with zero substitution — no relative paths, no placeholders (paste-traps).
  function baseUrl(req) {
    // A configured public base wins over the request host — behind a proxy the
    // Host header may be the origin (ts.net), which we do not want in docs.
    if (cfg.PUBLIC_BASE_URL) return cfg.PUBLIC_BASE_URL;
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host") || `${cfg.HOST}:${cfg.PORT}`;
    return `${proto}://${host}`;
  }

  // Served verbatim from skill/SKILL.md — the same bytes as the GitHub skill
  // (agent-default/outbid). One source; the old inline copy was drift.
  let skillText;
  try {
    skillText = fs.readFileSync(path.join(__dirname, "..", "skill", "SKILL.md"), "utf8");
  } catch (err) {
    console.error("skill/SKILL.md unreadable:", err.message);
    skillText = "# outbid\n\nSee https://github.com/agent-default/outbid (skills/outbid/SKILL.md).\n";
  }
  app.get("/skill.md", (_req, res) => {
    res.type("text/markdown").send(skillText);
  });

  function nextWellKnownAccepts() {
    const p = store.ranked()[0]?.last_payer;
    if (!p) return [];
    if (/^0x[a-fA-F0-9]{40}$/.test(p) && cfg.EVM_ADDRESS) {
      return [{ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.EVM_NETWORK, payTo: p }];
    }
    if (!p.startsWith("0x") && cfg.SVM_ADDRESS) {
      return [{ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.SVM_NETWORK, payTo: p }];
    }
    return [];
  }

  app.get("/.well-known/x402", (req, res) => {
    const base = baseUrl(req);
    const accepts = [];
    if (cfg.EVM_ADDRESS) accepts.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS });
    if (cfg.SVM_ADDRESS) accepts.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS });
    res.json({
      x402Version: 2,
      service: {
        name: "outbid",
        description:
          "Default routing table for agents. GET /top then GET /route (or POST /dispatch). Pay USDC to sit at #1. Settlement chain ≠ listed URL.",
      },
      resources: [
        {
          url: `${base}/bid`,
          method: "POST",
          description:
            'Optional. Add USDC to a listing. Body {"url","amount","description"} — amount in dollars sets the 402 price, min 0.01. The settled amount is what gets credited.',
          accepts,
        },
        {
          url: `${base}/next`,
          method: "GET",
          description: "Paid dispatch: $0.01 USDC to current #1 last_payer. GET /route stays free.",
          accepts: nextWellKnownAccepts(),
        },
      ],
      free_resources: [
        { url: `${base}/top`, method: "GET", description: "Current #1 JSON. Not counted. get_top." },
        { url: `${base}/route`, method: "GET", description: "Dispatch: 302 to #1, or JSON if Accept: application/json. Counted." },
        { url: `${base}/dispatch`, method: "POST", description: "Same as GET /route. Counted." },
        { url: `${base}/api/board`, method: "GET", description: "Full ranking + dispatch_total." },
        { url: `${base}/skill.md`, method: "GET" },
      ],
    });
  });

  app._outbid = { store, cfg, live: x402.live };
  return app;
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
