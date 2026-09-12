/**
 * First-party paid jobs. Dark unless JOBS_ENABLED=1.
 * Not /call. Not a named-slot market. Occupancy /bid is leftover.
 * Fulfillment requires facilitator settlement (req.outbidJobSettled), never
 * a raw payment header.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const JOB_PATHS = Object.freeze(["/job/scrape", "/job/browse", "/job/hop"]);

export const FIRST_PARTY_JOBS = Object.freeze({
  scrape: {
    name: "scrape",
    price_usdc: 0.005,
    amount: "5000",
    path: "/job/scrape",
    needs_url: true,
    backend: "reader",
    description: "Public URL as markdown. Never opens browse.",
  },
  browse: {
    name: "browse",
    price_usdc: 0.05,
    amount: "50000",
    path: "/job/browse",
    needs_url: true,
    backend: "reader",
    description: "Opt-in render. Only when scrape returns needs_browser.",
  },
  hop: {
    name: "hop",
    price_usdc: 0.01,
    amount: "10000",
    path: "/job/hop",
    needs_url: false,
    backend: "route",
    description: "One next URL from leftover occupancy. Not a matcher.",
  },
});

const PRIVATE = new BlockList();
for (const [n, p, t] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"], ["::", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
]) PRIVATE.addSubnet(n, p, t);

export function jobsEnabled(env = process.env) {
  return env.JOBS_ENABLED === "1";
}

export function normalizePaidPath(p) {
  const s = String(p || "");
  if (s.length > 1 && s.endsWith("/")) return s.replace(/\/+$/, "") || "/";
  return s;
}

export function stripJobTrailingSlash(req, _res, next) {
  const q = req.url.indexOf("?");
  const pathOnly = q === -1 ? req.url : req.url.slice(0, q);
  const search = q === -1 ? "" : req.url.slice(q);
  if (pathOnly.length > 1 && pathOnly.endsWith("/") && (pathOnly === "/jobs/" || pathOnly.startsWith("/job/"))) {
    req.url = pathOnly.replace(/\/+$/, "") + search;
  }
  next();
}

export function formatJobPrice(dollars) {
  const n = Number(dollars);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) < 1e-9) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function catalog(base = "https://outbid.sh", { enabled = false, housePay = false } = {}) {
  return {
    ok: true,
    concept: "first-party-jobs",
    not: ["/call", "named-slot", "capability-matcher", "directory"],
    leftover: ["/top", "/route", "/bid"],
    house_pay: housePay ? "on" : "off",
    jobs: Object.values(FIRST_PARTY_JOBS).map((job) => ({
      name: job.name,
      method: "GET",
      url: `${String(base).replace(/\/+$/, "")}${job.path}`,
      price_usdc: job.price_usdc,
      amount: job.amount,
      needs_url: job.needs_url,
      description: job.description,
      fulfillment: job.backend === "reader"
        ? (housePay ? "house-pay-reader" : "reader_requires_payment_until_house_pay")
        : "leftover-route",
    })),
    skill: `${String(base).replace(/\/+$/, "")}/jobs.md`,
    live: enabled ? "on" : "off until JOBS_ENABLED=1 and operator GO restart",
  };
}

export function quoteAccepts(job, { evmPayTo, svmPayTo, evmNetwork = "base", svmNetwork = "solana" } = {}) {
  const rows = [];
  if (evmPayTo) {
    rows.push({
      scheme: "exact",
      network: evmNetwork === "base" || String(evmNetwork).startsWith("eip155") ? "base" : evmNetwork,
      maxAmountRequired: job.amount,
      payTo: evmPayTo,
      asset: USDC_BASE,
    });
  }
  if (svmPayTo) {
    rows.push({
      scheme: "exact",
      network: String(svmNetwork).startsWith("solana") ? "solana" : svmNetwork,
      maxAmountRequired: job.amount,
      payTo: svmPayTo,
      asset: USDC_SOLANA,
    });
  }
  if (!rows.length) {
    rows.push({
      scheme: "exact",
      network: "solana",
      maxAmountRequired: job.amount,
      payTo: null,
      asset: USDC_SOLANA,
    });
  }
  return rows;
}

export function quoteBody(job, accepts, resource) {
  return {
    x402Version: 1,
    error: "Payment required",
    accepts,
    hint: `Named first-party job ${job.name}. Pay under the facilitator, then retry. scrape never opens browse. Not /call. A payment header is not payment.`,
    resource,
  };
}

function ipBlocked(addr) {
  const a = String(addr || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (a.startsWith("::ffff:")) return ipBlocked(a.slice(7));
  const v = isIP(a);
  return !v || PRIVATE.check(a, v === 4 ? "ipv4" : "ipv6");
}

export async function assertPublicHttpUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw Object.assign(new Error("url is required"), { code: "BAD_URL" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw Object.assign(new Error("url must be http(s)"), { code: "BAD_URL" });
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    throw Object.assign(new Error("private target"), { code: "SSRF" });
  }
  if (isIP(host) && ipBlocked(host)) {
    throw Object.assign(new Error("private target"), { code: "SSRF" });
  }
  let recs;
  try { recs = await lookup(host, { all: true }); } catch {
    throw Object.assign(new Error("private target"), { code: "SSRF" });
  }
  if (!recs.length || recs.some((r) => ipBlocked(r.address))) {
    throw Object.assign(new Error("private target"), { code: "SSRF" });
  }
  return u;
}

function jobsMarkdown() {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "skill", "JOBS.md"), "utf8");
  } catch {
    return "# outbid jobs\n\nFirst-party paid jobs. Dark until GO.\n";
  }
}

export function mountJobs(app, {
  enabled,
  publicBase,
  evmPayTo,
  svmPayTo,
  evmNetwork,
  svmNetwork,
  readerBase = "https://reader.outbid.sh",
  fetchImpl = fetch,
  fulfillHop,
  housePay = false,
  isSettled = (req) => req.outbidJobSettled === true,
} = {}) {
  if (!enabled) return { mounted: false };

  const skill = jobsMarkdown();

  app.get("/jobs", (req, res) => {
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host");
    const base = publicBase || (host ? `${proto}://${host}` : "https://outbid.sh");
    res.json(catalog(base, { enabled: true, housePay }));
  });

  app.get("/jobs.md", (_req, res) => {
    res.type("text/markdown").send(skill);
  });

  function unpaid(job, req, res) {
    const accepts = quoteAccepts(job, { evmPayTo, svmPayTo, evmNetwork, svmNetwork });
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host") || "";
    const base = publicBase || (host ? `${proto}://${host}` : "");
    return res.status(402).json(quoteBody(job, accepts, `${base}${job.path}`));
  }

  function head402(_req, res) {
    res.set("X-Outbid-Note", "GET with facilitator-verified x402 payment");
    res.status(402).end();
  }
  app.head("/job/scrape", head402);
  app.head("/job/browse", head402);
  app.head("/job/hop", head402);

  app.get("/job/scrape", async (req, res) => {
    const job = FIRST_PARTY_JOBS.scrape;
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "url is required", job: job.name });
    try { await assertPublicHttpUrl(raw); } catch (err) {
      return res.status(400).json({ ok: false, error: err.message, job: job.name });
    }
    if (!isSettled(req)) return unpaid(job, req, res);
    return fulfillReader(res, { job, url: raw, readerBase, fetchImpl, route: "/scrape" });
  });

  app.get("/job/browse", async (req, res) => {
    const job = FIRST_PARTY_JOBS.browse;
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "url is required", job: job.name });
    try { await assertPublicHttpUrl(raw); } catch (err) {
      return res.status(400).json({ ok: false, error: err.message, job: job.name });
    }
    if (!isSettled(req)) return unpaid(job, req, res);
    return fulfillReader(res, { job, url: raw, readerBase, fetchImpl, route: "/browse" });
  });

  app.get("/job/hop", async (req, res) => {
    const job = FIRST_PARTY_JOBS.hop;
    if (!isSettled(req)) return unpaid(job, req, res);
    if (typeof fulfillHop === "function") return fulfillHop(req, res);
    return res.status(503).json({
      ok: false,
      error: "hop fulfillment needs live /route",
      leftover: "/route",
    });
  });

  return { mounted: true };
}

const READER_TIMEOUT_MS = 15_000;
const READER_MAX_BYTES = 2_000_000;

async function fulfillReader(res, { job, url, readerBase, fetchImpl, route }) {
  const target = new URL(route, `${String(readerBase).replace(/\/+$/, "")}/`);
  target.searchParams.set("url", url);
  let response;
  try {
    response = await fetchImpl(target, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return res.status(502).json({
      ok: false,
      job: job.name,
      error: timedOut ? "reader_timeout" : "reader_unreachable",
      detail: String(err?.message || err),
    });
  }
  const text = await response.text();
  if (text.length > READER_MAX_BYTES) {
    return res.status(502).json({ ok: false, job: job.name, error: "reader_too_large" });
  }
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  if (response.status === 402) {
    return res.status(502).json({
      ok: false,
      job: job.name,
      error: "reader_requires_payment",
      hint: "House-pay reader after facilitator settle. Do not take a second stranger 402.",
    });
  }
  if (response.status === 422) {
    return res.status(422).json({
      ...body,
      job: job.name,
      scrape_never_opens_browse: route === "/scrape",
    });
  }
  return res.status(response.status).json(typeof body === "object" ? { ...body, job: job.name } : { ok: false, job: job.name, body });
}
