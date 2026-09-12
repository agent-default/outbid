import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createStore, formatPrice, normalizeTarget, parseAmount, MIN_USDC } from "./store.js";
import { mountMcp } from "./mcp.js";
import { FIRST_PARTY_JOBS, JOB_PATHS, assertPublicHttpUrl, formatJobPrice, jobsEnabled, mountJobs, normalizePaidPath, stripJobTrailingSlash } from "./jobs.mjs";

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
    SOLANA_RPC_URL: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    jobsEnabled: jobsEnabled(env),
    readerBase: env.READER_BASE_URL || "https://reader.outbid.sh",
    jobsReaderPay: env.JOBS_READER_PAY === "1",
    jobsPayModule: env.JOBS_PAY_MODULE || "",
    jobsHouseSvmKey: env.JOBS_HOUSE_SVM_KEY_FILE || "",
    jobsHouseEvmKey: env.JOBS_HOUSE_EVM_KEY_FILE || "",
  };
}

function housePayEnv(cfg, overrides = {}) {
  const svm = cfg.jobsHouseSvmKey || overrides.JOBS_HOUSE_SVM_KEY_FILE || "";
  const evm = cfg.jobsHouseEvmKey || overrides.JOBS_HOUSE_EVM_KEY_FILE || "";
  if (/payer\.svm\.json$/i.test(svm)) {
    throw new Error("refusing outbid merchant payer.svm.json for house-pay");
  }
  const out = {};
  if (svm) out.SVM_PRIVATE_KEY_FILE = svm;
  if (evm) out.EVM_PRIVATE_KEY_FILE = evm;
  if (overrides.JOBS_HOUSE_SVM_RPC_URL || cfg.SOLANA_RPC_URL) {
    out.SVM_RPC_URL = overrides.JOBS_HOUSE_SVM_RPC_URL || cfg.SOLANA_RPC_URL;
  }
  if (overrides.X402_READER_MAX_USDC_PER_CALL) out.X402_READER_MAX_USDC_PER_CALL = overrides.X402_READER_MAX_USDC_PER_CALL;
  if (overrides.X402_READER_MAX_USDC_TOTAL) out.X402_READER_MAX_USDC_TOTAL = overrides.X402_READER_MAX_USDC_TOTAL;
  if (overrides.X402_READER_SPENT_FILE) out.X402_READER_SPENT_FILE = overrides.X402_READER_SPENT_FILE;
  return out;
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
      jobs: cfg.jobsEnabled
        ? (cfg.jobsReaderPay
          ? "GET /jobs — first-party paid utilities (scrape/browse/hop, house-pay on)"
          : "GET /jobs — hop fulfills; scrape/browse 502 until house-pay")
        : "GET /jobs — dark until JOBS_ENABLED=1",
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
      const path = normalizePaidPath(request?.path);
      if (["/next", "/dispatch/next", "/route", "/dispatch", "/job/hop"].includes(path)) {
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
          else if (!noted.replay) console.log("tick settled", path, rec.tx, rec.payer);
        } catch (err) {
          deadLetter({ ...rec, path, error: String(err) });
        }
        return;
      }
      if (path === "/job/scrape" || path === "/job/browse") {
        if (context.result?.success === false) return;
        console.log("job settled", path, context.result?.transaction, context.result?.payer);
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
      if (!["/next", "/dispatch/next", "/route", "/dispatch", "/job/hop"].includes(req.path)) return next();
      nextAccepts.length = 0;
      const top = store.ranked()[0];
      if (!top) return res.status(404).json({ ok: false, error: "no #1 last_payer" });
      // Offer every rail this seat has been claimed on, each paying that rail's
      // own payer. A seat bid on both Base and Solana is payable on both, so a
      // caller pays whichever rail its wallet holds. Fall back to last_payer
      // for seats seeded before per-rail tracking.
      const evm = top.last_payer_evm || (/^0x[a-fA-F0-9]{40}$/.test(top.last_payer || "") ? top.last_payer : null);
      const svm = top.last_payer_svm || (top.last_payer && !top.last_payer.startsWith("0x") ? top.last_payer : null);
      if (evm && cfg.EVM_ADDRESS) {
        nextAccepts.push({ scheme: "exact", price: nextPrice, network: cfg.EVM_NETWORK, payTo: evm });
      }
      if (svm && cfg.SVM_ADDRESS) {
        nextAccepts.push({ scheme: "exact", price: nextPrice, network: cfg.SVM_NETWORK, payTo: svm });
      }
      if (!nextAccepts.length) return res.status(404).json({ ok: false, error: "no #1 last_payer" });
      next();
    });

    // v1-dialect mirror. The middleware's challenge path hardcodes an empty
    // 402 body ({}) and carries requirements only in the PAYMENT-REQUIRED
    // header (x402 v2). Body-reading clients — the original x402 npm, most
    // tutorial code — see a paywall with no invoice and loop forever (the
    // funnel showed 17 IPs with paid intent stuck exactly there). Mirror the
    // decoded header into any empty 402 body, plus a hint for humans/LLMs.
    const PAID_402_PATHS = new Set([
      "/bid", "/next", "/dispatch/next", "/route", "/dispatch",
      ...(cfg.jobsEnabled ? JOB_PATHS : []),
    ]);
    // Dialect split, measured 10:32Z: x402-fetch@1.1.0 (the v1 tutorial client)
    // parses the 402 BODY and dies on CAIP-2 network names (zod enum wants
    // "base"/"solana"). Modern clients read the v2 PAYMENT-REQUIRED header and
    // parse either dialect. So: header stays v2, body is a genuine v1 invoice.
    const LEGACY_NET = {
      "eip155:8453": "base",
      "eip155:84532": "base-sepolia",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
    };
    const CAIP_NET = Object.fromEntries(Object.entries(LEGACY_NET).map(([k, v]) => [v, k]));
    // Quote cache for the upgrade shim below: the wire accepts each caller was
    // actually challenged with, keyed by path+IP (quote-time semantics, same
    // trade recordNext already documents). Cold cache self-heals: the shim
    // passes the v1 payload through, the middleware re-402s, the client
    // re-reads the quote and retries against a warm cache.
    const wireQuotes = new Map();
    const quoteKey = (req) => `${req.path}|${clientIp(req) || "?"}`;
    app.use((req, res, next) => {
      if (!PAID_402_PATHS.has(normalizePaidPath(req.path))) return next();
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode === 402 && (!body || !body.accepts)) {
          const hdr = res.get("PAYMENT-REQUIRED");
          if (hdr) {
            try {
              const dec = JSON.parse(Buffer.from(String(hdr), "base64").toString());
              if (wireQuotes.size > 1000) wireQuotes.clear();
              wireQuotes.set(quoteKey(req), dec.accepts || []);
              body = {
                x402Version: 1,
                error: dec.error || "Payment required",
                accepts: (dec.accepts || []).map((a) => ({
                  scheme: a.scheme,
                  network: LEGACY_NET[a.network] || a.network,
                  maxAmountRequired: a.amount,
                  resource: dec.resource?.url || `${cfg.PUBLIC_BASE_URL}${req.path}`,
                  description: dec.resource?.description || "",
                  mimeType: dec.resource?.mimeType || "application/json",
                  payTo: a.payTo,
                  maxTimeoutSeconds: a.maxTimeoutSeconds,
                  asset: a.asset,
                  extra: a.extra,
                })),
                extensions: dec.extensions,
                hint: "Pay with an x402 client: wrapFetchWithPayment(fetch, client) from @x402/fetch (or the v1 x402-fetch npm), then retry this URL. Peek free: GET /top. Docs: https://outbid.sh/skill.md",
              };
            } catch {}
          }
        }
        return origJson(body);
      };
      next();
    });
    // Inbound half of the dialect split. A v1 client sends X-PAYMENT with
    // {x402Version:1, scheme, network:"base", payload} — but the facilitator
    // only advertises v2 kinds (supportedResponsesMap is keyed by version), so
    // a v1 payload can never verify as v1. Upgrade it to a v2 payload against
    // the caller's own cached quote. The EIP-3009 signature binds chainId, not
    // these labels; re-wrapping the envelope is safe.
    app.use((req, _res, next) => {
      if (!PAID_402_PATHS.has(normalizePaidPath(req.path))) return next();
      const raw = req.headers["payment-signature"] || req.headers["x-payment"];
      if (!raw) return next();
      try {
        const p = JSON.parse(Buffer.from(String(raw), "base64").toString());
        if (p && p.x402Version === 1 && CAIP_NET[p.network]) {
          const caip = CAIP_NET[p.network];
          const match = (wireQuotes.get(quoteKey(req)) || []).find(
            (a) => a.scheme === p.scheme && a.network === caip,
          );
          const out = match
            ? { x402Version: 2, accepted: match, payload: p.payload }
            : { ...p, network: caip };
          req.headers["payment-signature"] = Buffer.from(JSON.stringify(out)).toString("base64");
          delete req.headers["x-payment"];
        }
      } catch {} // malformed header: let the middleware reject it, not us
      next();
    });

    app.use(
      paymentMiddleware(
        {
          "GET /route": {
            accepts: nextAccepts,
            description: "Pay $0.01 USDC to current #1 last_payer for a counted dispatch.",
            mimeType: "application/json",
          },
          "POST /dispatch": {
            accepts: nextAccepts,
            description: "Same as GET /route. Pay $0.01 to #1 last_payer.",
            mimeType: "application/json",
          },
          "GET /next": {
            accepts: nextAccepts,
            description: "Pay $0.01 USDC to current #1 last_payer for a counted dispatch. Same circuit as GET /route.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                method: "GET",
                output: {
                  example: {
                    ok: true,
                    rank: 1,
                    url: "https://example.com",
                    forward_headers: { "X-Outbid-Rank": "1" },
                  },
                },
              }),
            },
          },
          "POST /dispatch/next": {
            accepts: nextAccepts,
            description: "Same as GET /next. Pay $0.01 to #1 last_payer.",
            mimeType: "application/json",
          },
          // /bid is the only endpoint PayAI lists, so most arrivals GET it by
          // default. Before 2026-08-27 that returned 405: not a payment
          // challenge, and no x402 client re-issues as POST — it has no branch
          // for "wrong method". 138 hits, and 10 of the 15 third-party
          // indexers that saw it never came back; AgentEconomyReport went
          // "not yet rated" -> "rating D" on nothing but 405s. Paywalling GET
          // makes the listed door answer with an invoice. A *paid* GET still
          // falls through to the 405 handler below, whose 4xx cancels
          // settlement before any money moves. No discovery extension here:
          // the bid body only travels on POST, so GET must not be advertised
          // as callable.
          "GET /bid": {
            accepts: paidAccepts,
            description:
              "Bidding is POST /bid with a JSON body. This challenge exists so the paywall is visible to GET; pay and POST.",
            mimeType: "application/json",
          },
          ...(cfg.jobsEnabled ? {
            "GET /job/scrape": {
              accepts: [
                cfg.EVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.scrape.price_usdc), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS },
                cfg.SVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.scrape.price_usdc), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS },
              ].filter(Boolean),
              description: "First-party scrape. $0.005 USDC. Never opens browse.",
              mimeType: "application/json",
            },
            "GET /job/browse": {
              accepts: [
                cfg.EVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.browse.price_usdc), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS },
                cfg.SVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.browse.price_usdc), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS },
              ].filter(Boolean),
              description: "First-party browse. $0.05 USDC. Opt-in only.",
              mimeType: "application/json",
            },
            "GET /job/hop": {
              accepts: nextAccepts,
              description: "Leftover occupancy hop. $0.01 USDC to #1 last_payer.",
              mimeType: "application/json",
            },
          } : {}),
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
    if (cfg.jobsEnabled) {
      app.use((req, _res, next) => {
        if (JOB_PATHS.includes(normalizePaidPath(req.path))) req.outbidJobSettled = true;
        next();
      });
    }
    return { live: true };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(stripJobTrailingSlash);
  // Only our own reverse proxy (Tailscale funnel / Vercel) can reach the
  // loopback port, so trust its forwarding headers: this makes req.protocol
  // honor x-forwarded-proto (https, not the http loopback origin).
  app.set("trust proxy", true);
  // CORS: confirmed live before this that zero Access-Control-* headers
  // existed anywhere on this app -- a fetch() running inside a browser tab,
  // a Workers/Deno-style agent runtime, or a browser extension cannot read
  // a 402 (or its payment-required header) cross-origin without this; it
  // gets an opaque network error before it ever sees `accepts`. Wide open
  // by design: every response here is either free discovery or a public
  // paywall challenge, nothing behind it is per-origin sensitive.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Expose-Headers",
      "payment-required, x-payment-response, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    );
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Accept, X-Payment, Payment-Signature, Authorization",
      );
      return res.sendStatus(204);
    }
    next();
  });
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
  const LOGGED_PATHS = new Set(["/route", "/dispatch", "/bid", "/skill.md", "/next", "/dispatch/next", "/.well-known/x402", "/.well-known/api-catalog", "/.well-known/agent-skills/index.json", "/jobs", "/job/scrape", "/job/browse", "/job/hop"]);
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
          // Any credential on a paywall path is an attempted payment: x402 v2
          // (payment-signature), v1 (x-payment), or MPP/credit-key styles that
          // ride the Authorization header.
          paid_hdr: Boolean(
            req.headers["payment-signature"] || req.headers["x-payment"] || req.headers["authorization"],
          ),
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
  const homeMd = fs.readFileSync(path.join(publicDir, "llms.txt"), "utf8");
  app.get("/", (req, res, next) => {
    res.set("Vary", "Accept, Accept-Encoding");
    res.append("Link", '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"');
    res.append("Link", '</.well-known/x402>; rel="service-desc"; type="application/json"');
    res.append("Link", '</skill.md>; rel="service-doc"; type="text/markdown"');
    res.append("Link", '</llms.txt>; rel="describedby"; type="text/markdown"');
    const type = req.accepts(["text/html", "text/markdown", "text/plain"]);
    if (!type) {
      return res.status(406).json({
        ok: false,
        error: "not acceptable",
        code: "not_acceptable",
        hint: "Accept text/html or text/markdown",
      });
    }
    if (type !== "text/html") {
      return res.type("text/markdown; charset=utf-8").send(homeMd);
    }
    next();
  });
  app.use(express.static(publicDir));
  // Before the payment middleware: unpaid 402 challenges are the cheap thing
  // to spam, so they get limited too.
  app.use(makeBidLimiter({ max: cfg.RATE_LIMIT_MAX, windowMs: cfg.RATE_LIMIT_WINDOW_MS }));

  app.use(async (req, res, next) => {
    if (!cfg.jobsEnabled) return next();
    const p = normalizePaidPath(req.path);
    if ((p !== "/job/scrape" && p !== "/job/browse") || (req.method !== "GET" && req.method !== "HEAD")) return next();
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "url is required", job: p.slice("/job/".length) });
    try {
      await assertPublicHttpUrl(raw);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message, job: p.slice("/job/".length) });
    }
    next();
  });

  const x402 = await mountX402(app);

  let jobsFetch = overrides.jobsFetch || fetch;
  let housePayArmed = false;
  if (cfg.jobsEnabled && cfg.jobsReaderPay && cfg.jobsPayModule) {
    try {
      const pay = await import(cfg.jobsPayModule);
      jobsFetch = await pay.createPaymentFetch({ env: housePayEnv(cfg, overrides) });
      housePayArmed = true;
      console.log("jobs house-pay reader armed");
    } catch (err) {
      console.error("jobs house-pay not armed; settled scrape will 502 on reader 402:", err.message);
    }
  }

  const { v0Router } = await import("./v0.mjs");
  app.use("/v0", v0Router({ rpcUrl: cfg.SOLANA_RPC_URL }));

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

  // HEAD must never count a dispatch or leak the proof headers: Express
  // aliases HEAD onto app.get, and the payment middleware matches GET only,
  // so without these routes a HEAD /next got the paid product free (VirusTotal
  // did, 09:53Z). Explicit HEAD routes win by registration order.
  app.head("/route", (_req, res) => {
    res.set("X-Outbid-Note", "GET with x402 payment - see /.well-known/x402");
    res.status(402).end();
  });
  app.head("/next", (_req, res) => {
    res.set("X-Outbid-Note", "GET with x402 payment - see /.well-known/x402");
    res.status(402).end();
  });
  app.get("/route", (req, res) => {
    if (!x402.live) return res.status(403).json({ ok: false, error: "live 402 disabled" });
    return sendRoute(req, res, true);
  });
  app.post("/dispatch", (req, res) => {
    if (!x402.live) return res.status(403).json({ ok: false, error: "live 402 disabled" });
    return sendRoute(req, res, true);
  });
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
  // Unpaid GETs never reach here — the paywall above answers them with a 402.
  // This runs only when a payment VERIFIED against a GET, which cannot carry
  // the bid body. Returning 4xx cancels settlement (same contract as POST /bid
  // below), so the caller keeps their money and is told where to spend it.
  app.get("/bid", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({
      ok: false,
      error: "bid not placed: no money taken. POST /bid with {url, amount} to bid.",
    });
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
  const skillDigest = `sha256:${createHash("sha256").update(skillText, "utf8").digest("hex")}`;
  const skillDesc = (skillText.match(/^description:\s+(.+)$/m) || [])[1]?.trim() || "";
  app.get(["/skill.md", "/.well-known/agent-skills/outbid/SKILL.md"], (_req, res) => {
    res.type("text/markdown").send(skillText);
  });
  // Agent Skills Discovery RFC v0.2.0. Digest = SHA-256 of served skill bytes.
  app.get("/.well-known/agent-skills/index.json", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "outbid",
          type: "skill-md",
          description: skillDesc,
          url: `${baseUrl(req)}/skill.md`,
          digest: skillDigest,
        },
      ],
    });
  });

  // Mirrors the /route|/next|/dispatch paywall's own payTo resolution
  // (see the nextAccepts middleware above) so the declaration can never
  // again disagree with the live 402 -- was single-rail, first-match-wins.
  function nextWellKnownAccepts() {
    const top = store.ranked()[0];
    if (!top) return [];
    const evm = top.last_payer_evm || (/^0x[a-fA-F0-9]{40}$/.test(top.last_payer || "") ? top.last_payer : null);
    const svm = top.last_payer_svm || (top.last_payer && !top.last_payer.startsWith("0x") ? top.last_payer : null);
    const out = [];
    if (evm && cfg.EVM_ADDRESS) out.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.EVM_NETWORK, payTo: evm });
    if (svm && cfg.SVM_ADDRESS) out.push({ scheme: "exact", price: formatPrice(MIN_USDC), network: cfg.SVM_NETWORK, payTo: svm });
    return out;
  }

  // RFC 9727 API catalog: honest linkset over surfaces that exist. No OAuth
  // discovery on purpose — there is no auth server to describe; the payment
  // is the auth (x402), discoverable via the 402 challenge itself.
  app.get("/.well-known/api-catalog", (req, res) => {
    const base = baseUrl(req);
    res.set("Content-Type", "application/linkset+json").send(JSON.stringify({
      linkset: [
        {
          anchor: `${base}/`,
          "service-desc": [{ href: `${base}/.well-known/x402`, type: "application/json" }],
          "service-doc": [{ href: `${base}/skill.md`, type: "text/markdown" }],
          status: [{ href: `${base}/health` }],
        },
      ],
    }));
  });

  // Same handler on both paths. Do not drop a snapshot in public/ — GET /next
  // payTo is current #1 last_payer and would go stale. Express req.url rewrite
  // does not re-match routes; bind the function once.
  app.get(["/.well-known/x402", "/.well-known/x402.json"], (req, res) => {
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
          url: `${base}/route`,
          method: "GET",
          description: "Paid dispatch: $0.01 USDC to current #1 last_payer. Counted.",
          accepts: nextWellKnownAccepts(),
        },
        {
          url: `${base}/dispatch`,
          method: "POST",
          description: "Same as GET /route. $0.01 to #1 last_payer. Counted.",
          accepts: nextWellKnownAccepts(),
        },
        {
          url: `${base}/next`,
          method: "GET",
          description: "Paid dispatch: $0.01 USDC to current #1 last_payer. Same circuit as GET /route.",
          accepts: nextWellKnownAccepts(),
        },
        ...(cfg.jobsEnabled && housePayArmed ? [
          {
            url: `${base}/job/scrape`,
            method: "GET",
            description: "First-party scrape $0.005. Query url=. Never opens browse.",
            accepts: [
              cfg.EVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.scrape.price_usdc), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS },
              cfg.SVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.scrape.price_usdc), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS },
            ].filter(Boolean),
          },
          {
            url: `${base}/job/browse`,
            method: "GET",
            description: "First-party browse $0.05. Query url=. Opt-in only.",
            accepts: [
              cfg.EVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.browse.price_usdc), network: cfg.EVM_NETWORK, payTo: cfg.EVM_ADDRESS },
              cfg.SVM_ADDRESS && { scheme: "exact", price: formatJobPrice(FIRST_PARTY_JOBS.browse.price_usdc), network: cfg.SVM_NETWORK, payTo: cfg.SVM_ADDRESS },
            ].filter(Boolean),
          },
        ] : []),
        ...(cfg.jobsEnabled ? [
          {
            url: `${base}/job/hop`,
            method: "GET",
            description: "Leftover occupancy hop $0.01 to #1 last_payer.",
            accepts: nextWellKnownAccepts(),
          },
        ] : []),
      ],
      free_resources: [
        { url: `${base}/top`, method: "GET", description: "Current #1 JSON. Not counted. get_top." },
        { url: `${base}/api/board`, method: "GET", description: "Full ranking + dispatch_total." },
        { url: `${base}/skill.md`, method: "GET" },
        ...(cfg.jobsEnabled ? [{ url: `${base}/jobs`, method: "GET", description: "First-party job catalog. Free." }] : []),
      ],
    });
  });

  // ARD / ai-catalog: real doors only. No MCP, A2A, or ACP — we do not have those.
  app.get("/.well-known/ai-catalog.json", (req, res) => {
    const base = baseUrl(req);
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      specVersion: "1.0",
      host: { displayName: "outbid", identifier: "did:web:outbid.sh" },
      entries: [
        {
          identifier: "urn:air:outbid.sh:skill:outbid",
          displayName: "outbid skill",
          type: "text/markdown",
          url: `${base}/skill.md`,
          representativeQueries: [
            "what is the next URL when the seller died",
            "npx skills add agent-default/outbid",
            "GET /top then GET /route",
          ],
        },
        {
          identifier: "urn:air:outbid.sh:x402:well-known",
          displayName: "outbid x402",
          type: "application/json",
          url: `${base}/.well-known/x402`,
          representativeQueries: [
            "pay USDC to sit at #1 on outbid",
            "GET /next 402 paid dispatch",
            "x402 POST /bid",
          ],
        },
        {
          identifier: "urn:air:outbid.sh:docs:llms",
          displayName: "outbid llms.txt",
          type: "text/plain",
          url: `${base}/llms.txt`,
          representativeQueries: [
            "fallback next URL for agents",
            "outbid.sh skill",
            "#1 is the highest settled bid",
          ],
        },
      ],
    });
  });

  // Auth.md: no OAuth tokens. PRM/AS exist so agents find /auth.md; no token_endpoint.
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const base = baseUrl(req);
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      resource: `${base}/`,
      authorization_servers: [base],
      scopes_supported: [],
      bearer_methods_supported: ["header"],
      resource_documentation: `${base}/auth.md`,
    });
  });
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = baseUrl(req);
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      issuer: base,
      grant_types_supported: [],
      response_types_supported: [],
      agent_auth: {
        skill: `${base}/auth.md`,
        register_uri: `${base}/auth.md`,
        identity_types_supported: ["anonymous"],
        anonymous: { credential_types_supported: ["x402"] },
      },
    });
  });

  // Spectator MCP (peek_top / get_board / get_skill). No counted /route.
  mountMcp(app, { store, skillText, baseUrl });

  // First-party jobs. Off on live :4024 until JOBS_ENABLED=1 + GO restart.
  mountJobs(app, {
    enabled: cfg.jobsEnabled,
    publicBase: cfg.PUBLIC_BASE_URL,
    evmPayTo: cfg.EVM_ADDRESS || null,
    svmPayTo: cfg.SVM_ADDRESS || null,
    evmNetwork: cfg.EVM_NETWORK,
    svmNetwork: cfg.SVM_NETWORK,
    readerBase: cfg.readerBase,
    fetchImpl: jobsFetch,
    housePay: housePayArmed,
    isSettled: overrides.jobsIsSettled || ((req) => req.outbidJobSettled === true),
    fulfillHop: (req, res) => {
      if (!x402.live) return res.status(503).json({ ok: false, error: "hop needs live 402", leftover: "/route" });
      return sendRoute(req, res, true);
    },
  });

  app._outbid = { store, cfg, live: x402.live };
  app.use((req, res) => {
    res.set("Vary", "Accept, Accept-Encoding");
    // Dying-words self-adoption: our own dead-end carries the fallback the
    // spec asks sellers to emit. It points at FREE /top (peek #1's URL, not
    // counted) — /route is now the $0.01 paid dispatch, so first contact must
    // stay free or a churned buyer hits a paywall sight-unseen.
    const fb = `${baseUrl(req)}/top`;
    res.set("Link", `<${fb}>; rel="fallback"; type="application/json"`);
    if (req.accepts(["text/markdown", "application/json"]) === "application/json") {
      return res.status(404).json({
        ok: false,
        error: "not found",
        code: "not_found",
        fallback: fb,
        hint: "GET /top (free peek), then /route ($0.01 dispatch), /llms.txt, /skill.md",
      });
    }
    res.status(404).type("text/markdown; charset=utf-8").send(
      `# 404\n\nNo such path.\n\nFallback: GET ${fb} (free peek at #1), then /route for a paid dispatch.\n\n- GET /top\n- GET /llms.txt\n- GET /skill.md\n- GET /sitemap.xml\n- GET /openapi.json\n`,
    );
  });
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
