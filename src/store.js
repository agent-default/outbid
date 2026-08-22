import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIN_USDC = 0.01;
export const MAX_USDC = 999999;

export function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "amount is required" };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { ok: false, error: "amount must be a number" };
  if (n < MIN_USDC) return { ok: false, error: `amount must be at least $${MIN_USDC}` };
  if (n > MAX_USDC) return { ok: false, error: `amount must be at most $${MAX_USDC}` };
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) {
    return { ok: false, error: "amount must be whole cents" };
  }
  return { ok: true, dollars: cents / 100, cents };
}

export function formatPrice(dollars) {
  return `$${Number(dollars).toFixed(2)}`;
}

// Hosts that hide the real destination (shorteners) or are chat/invite
// funnels. Exact host or any subdomain. discord.com is path-gated below.
const BLOCKED_HOSTS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "buff.ly",
  "t.me", "discord.gg", "wa.me",
]);

function hostBlocked(hostname) {
  const parts = hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (BLOCKED_HOSTS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

export function normalizeTarget(input) {
  if (typeof input !== "string") return { ok: false, error: "url is required" };
  const raw = input.trim();
  if (!raw) return { ok: false, error: "url is required" };
  if (raw.length > 512) return { ok: false, error: "url too long" };

  if (raw.startsWith("@")) {
    const handle = raw.slice(1).replace(/^@+/, "");
    if (!/^[A-Za-z0-9_]{1,32}$/.test(handle)) {
      return { ok: false, error: "invalid @handle" };
    }
    return { ok: true, key: `@${handle.toLowerCase()}`, display: `@${handle}` };
  }

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "url must be http(s)" };
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (hostBlocked(url.hostname)) {
    return { ok: false, error: "link shorteners and chat/invite links are not allowed" };
  }
  if (/(^|\.)discord\.com$/.test(url.hostname) && /^\/invite(\/|$)/i.test(url.pathname)) {
    return { ok: false, error: "link shorteners and chat/invite links are not allowed" };
  }
  for (const k of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) url.searchParams.delete(k);
  }
  let href = url.toString();
  if (href.endsWith("/") && url.pathname === "/") href = href.slice(0, -1);
  if (url.pathname !== "/" && href.endsWith("/")) href = href.slice(0, -1);
  return { ok: true, key: href, display: href };
}

function listingId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function createStore(filePath) {
  const file = path.resolve(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function read() {
    if (!fs.existsSync(file)) return { listings: {}, payments: {} };
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.payments ||= {};
    return state;
  }

  function write(state) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function ranked(state = read()) {
    return Object.values(state.listings)
      .sort((a, b) => b.bid_usdc - a.bid_usdc || a.created_at.localeCompare(b.created_at))
      .map((row, i) => ({ rank: i + 1, ...row }));
  }

  function topBid(state = read()) {
    const rows = ranked(state);
    return rows.length ? rows[0].bid_usdc : 0;
  }

  function claimPrice(state = read()) {
    const top = topBid(state);
    return Number((top + MIN_USDC).toFixed(2));
  }

  function addBid({ url, description = "", add_usdc, payer = null, tx = null, dry = false }) {
    const target = normalizeTarget(url);
    if (!target.ok) return target;
    const amount = parseAmount(add_usdc);
    if (!amount.ok) return amount;
    const desc = String(description || "").trim().slice(0, 280);
    const state = read();
    const id = listingId(target.key);
    const now = new Date().toISOString();
    const prev = state.listings[id];
    const next = prev
      ? {
          ...prev,
          url: target.display,
          description: desc || prev.description,
          bid_usdc: Number((prev.bid_usdc + amount.dollars).toFixed(2)),
          updated_at: now,
          last_payer: payer,
          last_tx: tx,
          last_dry: dry,
        }
      : {
          id,
          url: target.display,
          description: desc,
          bid_usdc: amount.dollars,
          clicks: 0,
          created_at: now,
          updated_at: now,
          last_payer: payer,
          last_tx: tx,
          last_dry: dry,
        };
    state.listings[id] = next;
    write(state);
    const board = ranked(state);
    return { ok: true, listing: board.find((r) => r.id === id), board };
  }

  // Commit point for a SETTLED x402 payment. `atomic` is the settled amount in
  // USDC base units (6 decimals) taken from the payment requirements the
  // facilitator settled — never from the request's query or body. Idempotent on
  // (network, tx): a facilitator retry or double-fired hook credits once.
  function credit({ url, description = "", atomic, payer = null, tx, network = null }) {
    if (typeof tx !== "string" || !tx) return { ok: false, error: "settlement tx is required" };
    if (!/^\d+$/.test(String(atomic))) return { ok: false, error: "atomic amount must be an integer string" };
    // USDC is 6 decimals. Board stores dollars to the cent.
    const dollars = Math.round(Number(atomic) / 1e4) / 100;
    if (!Number.isFinite(dollars) || dollars <= 0) return { ok: false, error: "settled amount is zero" };
    const target = normalizeTarget(url);
    if (!target.ok) return target;

    const state = read();
    const paymentKey = `${network || "?"}:${tx}`;
    if (state.payments[paymentKey]) {
      return { ok: true, replay: true, payment: state.payments[paymentKey] };
    }

    const desc = String(description || "").trim().slice(0, 280);
    const id = listingId(target.key);
    const now = new Date().toISOString();
    const prev = state.listings[id];
    const next = prev
      ? {
          ...prev,
          url: target.display,
          description: desc || prev.description,
          bid_usdc: Number((prev.bid_usdc + dollars).toFixed(2)),
          updated_at: now,
          last_payer: payer,
          last_tx: tx,
        }
      : {
          id,
          url: target.display,
          description: desc,
          bid_usdc: dollars,
          clicks: 0,
          created_at: now,
          updated_at: now,
          last_payer: payer,
          last_tx: tx,
        };
    state.listings[id] = next;
    state.payments[paymentKey] = { listing_id: id, usdc: dollars, payer, tx, network, at: now };
    write(state);
    const board = ranked(state);
    return { ok: true, replay: false, listing: board.find((r) => r.id === id), board };
  }

  function click(id) {
    const state = read();
    const row = state.listings[id];
    if (!row) return { ok: false, error: "not found" };
    row.clicks += 1;
    write(state);
    return { ok: true, listing: row };
  }

  return {
    file,
    ranked,
    topBid,
    claimPrice,
    addBid,
    credit,
    click,
    get: (id) => read().listings[id] || null,
    payments: () => read().payments,
  };
}
