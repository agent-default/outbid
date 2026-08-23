#!/usr/bin/env node
// probe-consumer.mjs — the CONSUME side of the board.
//
// A buying agent that needs its next call does not guess: it asks the board
// who is #1 right now. GET /route answers with a 302 whose Location header is
// the current top listing's URL — this script reads that routing table the way
// a consuming agent would, without spending anything.
//
// usage: OUTBID_URL=http://127.0.0.1:4024 node scripts/probe-consumer.mjs [--follow]
//   OUTBID_URL  board base url (default http://127.0.0.1:4024)
//   --follow    actually fetch the dispatched URL and report its status,
//               demonstrating a real end-to-end route -> call

import dotenv from "dotenv";

dotenv.config();
if (process.env.DOTENV_FILE) dotenv.config({ path: process.env.DOTENV_FILE, override: true });

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const unknown = args.filter((a) => a !== "--follow");
if (unknown.length) {
  console.error(`unknown argument: ${unknown.join(" ")}`);
  console.error("usage: OUTBID_URL=http://127.0.0.1:4024 node scripts/probe-consumer.mjs [--follow]");
  process.exit(2);
}

const base = (process.env.OUTBID_URL || "http://127.0.0.1:4024").replace(/\/+$/, "");
const TIMEOUT_MS = 10_000;

function get(url) {
  // redirect: "manual" — the 302 IS the answer; we read it, we don't chase it.
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// ---- 1. the routing table: GET /route, read the 302 without following it ----
let res;
try {
  res = await get(`${base}/route`);
} catch (err) {
  console.error(`cannot reach board at ${base}: ${err.cause?.code || err.message}`);
  process.exit(1);
}

if (res.status === 404) {
  // Two distinct 404s: the board answering "no #1" (JSON body), or a server
  // without the buy side deployed at all (express's plain "Cannot GET /route").
  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  if (parsed?.error) {
    console.error(`board is empty: ${parsed.error} — nothing ranked, nothing to route to`);
  } else {
    console.error(`GET ${base}/route -> 404 with no JSON body — buy side not deployed on this board yet`);
  }
  process.exit(1);
}

if (res.status < 300 || res.status >= 400) {
  console.error(`GET ${base}/route -> unexpected ${res.status} (wanted a 302)`);
  process.exit(1);
}

const location = res.headers.get("location");
if (!location) {
  console.error(`GET ${base}/route -> ${res.status} but no Location header`);
  process.exit(1);
}
const dispatchedUrl = new URL(location, `${base}/`).href;

console.log(`dispatched_url: ${dispatchedUrl}`);
console.log(`dispatches: ${res.headers.get("x-outbid-dispatches") ?? "?"}`);
console.log(`note: ${res.headers.get("x-outbid-note") ?? ""}`);
const rank = res.headers.get("x-outbid-rank");
const bid = res.headers.get("x-outbid-bid");
if (rank || bid) console.log(`rank: ${rank ?? "?"}  bid_usdc: ${bid ?? "?"}`);

// ---- 2. the JSON view of #1, where this board serves it ----
// The path is mid-flight on the sell side: try /api/top, fall back to /top.
let topShown = false;
for (const path of ["/api/top", "/top"]) {
  try {
    const top = await get(`${base}${path}`);
    if (top.ok) {
      console.log(`top (${path}): ${JSON.stringify(await top.json())}`);
      topShown = true;
      break;
    }
  } catch (err) {
    console.log(`top: ${path} unreachable (${err.cause?.code || err.message})`);
    break;
  }
}
if (!topShown) {
  console.log("top: no JSON top endpoint on this board yet (tried /api/top, /top); the /route headers above are authoritative");
}

// ---- 3. optionally prove the route end-to-end ----
if (follow) {
  const t0 = Date.now();
  try {
    const hit = await fetch(dispatchedUrl, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await hit.arrayBuffer().catch(() => {}); // drain so keep-alive doesn't hold the process open
    console.log(`follow: GET ${dispatchedUrl} -> ${hit.status} ${hit.statusText} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`follow: GET ${dispatchedUrl} failed: ${err.cause?.code || err.message}`);
    process.exit(1);
  }
}
