import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createStore, normalizeTarget, parseAmount } from "../src/store.js";

test("parseAmount rejects sub-cent and non-numeric", () => {
  assert.equal(parseAmount("0.001").ok, false);
  assert.equal(parseAmount("nope").ok, false);
  assert.equal(parseAmount("0.05").dollars, 0.05);
});

test("normalizeTarget strips trackers and handles @", () => {
  const u = normalizeTarget("HTTPS://Example.com/a/?utm_source=x");
  assert.equal(u.ok, true);
  assert.equal(u.display, "https://example.com/a");
  const h = normalizeTarget("@Alice");
  assert.equal(h.key, "@alice");
});

test("credit uses settled atomic USDC, not a dollar claim", () => {
  const file = path.join(os.tmpdir(), `outbid-credit-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  const r = store.credit({
    url: "https://paid.example",
    description: "settled",
    atomic: "50000", // 0.05 USDC, 6 decimals
    payer: "0xabc",
    tx: "0xdead",
    network: "eip155:84532",
  });
  assert.equal(r.ok, true);
  assert.equal(r.replay, false);
  assert.equal(r.listing.bid_usdc, 0.05);
  assert.equal(r.listing.last_tx, "0xdead");
  fs.rmSync(file);
});

test("credit is idempotent on network:tx", () => {
  const file = path.join(os.tmpdir(), `outbid-replay-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  const once = {
    url: "https://paid.example",
    atomic: "50000",
    payer: "0xabc",
    tx: "0xdead",
    network: "eip155:84532",
  };
  store.credit(once);
  const again = store.credit(once);
  assert.equal(again.ok, true);
  assert.equal(again.replay, true);
  assert.equal(store.ranked()[0].bid_usdc, 0.05);
  store.credit({ ...once, tx: "0xbeef" });
  assert.equal(store.ranked()[0].bid_usdc, 0.1);
  fs.rmSync(file);
});

test("credit refuses a missing tx", () => {
  const file = path.join(os.tmpdir(), `outbid-notx-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  const r = store.credit({ url: "https://x.example", atomic: "50000", tx: "", network: "eip155:84532" });
  assert.equal(r.ok, false);
  fs.rmSync(file, { force: true });
});

test("rank is cumulative bid, older wins ties", () => {
  const file = path.join(os.tmpdir(), `outbid-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  store.addBid({ url: "https://a.example", add_usdc: 0.05, description: "a" });
  store.addBid({ url: "https://b.example", add_usdc: 0.05, description: "b" });
  store.addBid({ url: "https://a.example", add_usdc: 0.02, description: "a+" });
  const board = store.ranked();
  assert.equal(board[0].url, "https://a.example");
  assert.equal(board[0].bid_usdc, 0.07);
  assert.equal(board[0].rank, 1);
  assert.equal(board[1].rank, 2);
  fs.rmSync(file);
});

test("shorteners and chat/invite links are rejected", () => {
  const blocked = [
    "https://bit.ly/3xyz",
    "http://t.co/abc",
    "tinyurl.com/foo",
    "https://goo.gl/maps1",
    "https://is.gd/x",
    "https://buff.ly/y",
    "https://t.me/somegroup",
    "https://discord.gg/abc123",
    "https://discord.com/invite/abc123",
    "https://wa.me/15551234567",
    "https://www.bit.ly/sub",       // subdomain of a blocked host
  ];
  for (const u of blocked) {
    const r = normalizeTarget(u);
    assert.equal(r.ok, false, `${u} should be blocked`);
    assert.match(r.error, /not allowed/);
  }
  // Non-invite discord and lookalike hosts stay allowed; @handles untouched.
  assert.equal(normalizeTarget("https://discord.com/developers").ok, true);
  assert.equal(normalizeTarget("https://notbit.ly.example.com/x").ok, true);
  assert.equal(normalizeTarget("@someone").ok, true);
});

test("dispatchTop 404s when the board is empty", () => {
  const file = path.join(os.tmpdir(), `outbid-dispatch-empty-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  const r = store.dispatchTop();
  assert.equal(r.ok, false);
  assert.match(r.error, /no #1/);
  fs.rmSync(file, { force: true });
});

test("dispatchTop increments #1 dispatches, not clicks", () => {
  const file = path.join(os.tmpdir(), `outbid-dispatch-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  store.addBid({ url: "https://second.example", add_usdc: 0.01 });
  store.addBid({ url: "https://first.example", add_usdc: 0.05 });
  const once = store.dispatchTop();
  assert.equal(once.ok, true);
  assert.equal(once.listing.url, "https://first.example");
  assert.equal(once.listing.rank, 1);
  assert.equal(once.listing.dispatches, 1);
  assert.equal(once.listing.clicks, 0);
  store.dispatchTop();
  const board = store.ranked();
  assert.equal(board[0].dispatches, 2);
  assert.equal(board[1].dispatches, 0);
  assert.equal(store.dispatchCount(), 2);
  fs.rmSync(file, { force: true });
});

test("recordNext logs a settle without raising bid_usdc", () => {
  const file = path.join(os.tmpdir(), `outbid-next-${process.pid}-${Date.now()}.json`);
  const store = createStore(file);
  store.addBid({ url: "https://first.example", add_usdc: 0.05, payer: "0xabc" });
  const r = store.recordNext({ atomic: "10000", payer: "0xdef", tx: "0xnext1", network: "eip155:8453" });
  assert.equal(r.ok, true);
  assert.equal(r.payment.kind, "next");
  assert.equal(store.ranked()[0].bid_usdc, 0.05);
  assert.equal(store.ranked()[0].dispatches, 0);
  const replay = store.recordNext({ atomic: "10000", payer: "0xdef", tx: "0xnext1", network: "eip155:8453" });
  assert.equal(replay.replay, true);
  fs.rmSync(file, { force: true });
});
