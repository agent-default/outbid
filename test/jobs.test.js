import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalog, FIRST_PARTY_JOBS, formatJobPrice, jobsEnabled, quoteAccepts } from "../src/jobs.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataFile = path.join(os.tmpdir(), `outbid-jobs-${process.pid}.json`);
const accessLog = path.join(os.tmpdir(), `outbid-jobs-${process.pid}.jsonl`);

async function listen(overrides = {}) {
  const { createApp } = await import("../src/server.js");
  const app = await createApp({
    X402_DRY: "1",
    EVM_ADDRESS: "",
    SVM_ADDRESS: "",
    DATA_FILE: dataFile,
    DISPATCH_LOG: accessLog,
    ...overrides,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("jobs stay dark unless JOBS_ENABLED=1", async () => {
  assert.equal(jobsEnabled({}), false);
  assert.equal(jobsEnabled({ JOBS_ENABLED: "1" }), true);
  const { server, base } = await listen({ JOBS_ENABLED: "" });
  try {
    const res = await fetch(`${base}/jobs`);
    assert.equal(res.status, 404);
    const job = await fetch(`${base}/job/scrape?url=https://example.com/`);
    assert.equal(job.status, 404);
  } finally {
    server.close();
  }
});

test("enabled catalog is first-party jobs, not /call", async () => {
  const { server, base } = await listen({ JOBS_ENABLED: "1" });
  try {
    const res = await fetch(`${base}/jobs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.concept, "first-party-jobs");
    assert.deepEqual(body.jobs.map((j) => j.name).sort(), ["browse", "hop", "scrape"]);
    assert.equal(body.jobs.find((j) => j.name === "scrape").price_usdc, 0.005);
    assert.equal(body.jobs.find((j) => j.name === "browse").price_usdc, 0.05);
    assert.equal(body.jobs.find((j) => j.name === "hop").price_usdc, 0.01);
    assert.ok(body.not.includes("/call"));
    assert.ok(body.leftover.includes("/route"));
    assert.equal(body.live, "on");
    assert.equal(body.house_pay, "off");
    assert.equal(body.jobs.find((j) => j.name === "scrape").fulfillment, "reader_requires_payment_until_house_pay");
    assert.equal(body.jobs.find((j) => j.name === "hop").fulfillment, "leftover-route");
    const md = await fetch(`${base}/jobs.md`);
    assert.equal(md.status, 200);
    const text = await md.text();
    const canon = fs.readFileSync(path.join(root, "skill", "JOBS.md"), "utf8");
    assert.equal(text, canon);
    assert.match(text, /first-party/);
    assert.match(text, /Not a capability matcher/);
  } finally {
    server.close();
  }
});

test("unpaid scrape/browse/hop are 402 quotes; scrape needs url; never auto-browse", async () => {
  const { server, base } = await listen({ JOBS_ENABLED: "1" });
  try {
    const missing = await fetch(`${base}/job/scrape`);
    assert.equal(missing.status, 400);
    const scrape = await fetch(`${base}/job/scrape?url=https://example.com/`);
    assert.equal(scrape.status, 402);
    const quote = await scrape.json();
    assert.equal(quote.accepts[0].maxAmountRequired, "5000");
    assert.match(quote.hint, /never opens browse/i);
    const browse = await fetch(`${base}/job/browse?url=https://example.com/`);
    assert.equal(browse.status, 402);
    assert.equal((await browse.json()).accepts[0].maxAmountRequired, "50000");
    const hop = await fetch(`${base}/job/hop`);
    assert.equal(hop.status, 402);
    assert.equal((await hop.json()).accepts[0].maxAmountRequired, "10000");
    const spoof = await fetch(`${base}/job/scrape?url=https://example.com/`, {
      headers: { "x-payment": "test", "payment-signature": "test" },
    });
    assert.equal(spoof.status, 402, "a payment header is not settlement");
    const head = await fetch(`${base}/job/scrape?url=https://example.com/`, { method: "HEAD" });
    assert.equal(head.status, 402);
    const ssrf = await fetch(`${base}/job/scrape?url=http://127.0.0.1/`);
    assert.equal(ssrf.status, 400);
    const slash = await fetch(`${base}/job/scrape/?url=https://example.com/`);
    assert.equal(slash.status, 402);
  } finally {
    server.close();
  }
});

test("injected reader 422 on settled scrape does not call browse", async () => {
  const calls = [];
  const { server, base } = await listen({
    JOBS_ENABLED: "1",
    jobsIsSettled: () => true,
    jobsFetch: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: false, reason: "needs_browser" }), { status: 422 });
    },
  });
  try {
    const unpaidGate = await listen({ JOBS_ENABLED: "1" });
    try {
      const unpaid = await fetch(`${unpaidGate.base}/job/scrape?url=https://example.com/`);
      assert.equal(unpaid.status, 402);
    } finally {
      unpaidGate.server.close();
    }
    assert.equal(calls.length, 0);
    const paid = await fetch(`${base}/job/scrape?url=https://example.com/`);
    assert.equal(paid.status, 422);
    const body = await paid.json();
    assert.equal(body.reason, "needs_browser");
    assert.equal(body.scrape_never_opens_browse, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/scrape\?/);
    assert.doesNotMatch(calls[0], /\/browse\?/);
  } finally {
    server.close();
  }
});

test("quote helper and catalog stay first-party", () => {
  const rows = quoteAccepts(FIRST_PARTY_JOBS.scrape, {
    svmPayTo: "H4VtL3fEFq4vZnVWSBvdHzfVEtbEEeUWbFPVKN3gcDCE",
  });
  assert.equal(rows[0].network, "solana");
  assert.equal(rows[0].maxAmountRequired, "5000");
  const listed = catalog("https://outbid.sh");
  assert.equal(listed.jobs[0].url, "https://outbid.sh/job/scrape");
  assert.equal(formatJobPrice(0.005), "$0.005");
  assert.equal(formatJobPrice(0.05), "$0.05");
  assert.equal(formatJobPrice(0.01), "$0.01");
});

test("well-known lists job prices, not bid min, when jobs are on", async () => {
  const { server, base } = await listen({
    JOBS_ENABLED: "1",
    EVM_ADDRESS: "0x0000000000000000000000000000000000000001",
    SVM_ADDRESS: "H4VtL3fEFq4vZnVWSBvdHzfVEtbEEeUWbFPVKN3gcDCE",
    X402_DRY: "0",
  });
  try {
    const well = await (await fetch(`${base}/.well-known/x402`)).json();
    const scrape = well.resources.find((r) => r.url.endsWith("/job/scrape"));
    const browse = well.resources.find((r) => r.url.endsWith("/job/browse"));
    const hop = well.resources.find((r) => r.url.endsWith("/job/hop"));
    const jobs = well.free_resources.find((r) => r.url.endsWith("/jobs"));
    assert.equal(scrape, undefined, "do not advertise scrape until house-pay");
    assert.equal(browse, undefined, "do not advertise browse until house-pay");
    assert.ok(hop && jobs);
    const ssrf = await fetch(`${base}/job/scrape?url=http://127.0.0.1/`);
    assert.equal(ssrf.status, 400, "private url must 400 before the live paywall");
  } finally {
    server.close();
  }
});

test("src has no /call route; jobs module is not named-slot", () => {
  const jobs = fs.readFileSync(path.join(root, "src/jobs.mjs"), "utf8");
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  assert.equal(/app\.(get|post|use)\(\s*["'`]\/call/.test(server), false);
  assert.equal(/app\.(get|post|use)\(\s*["'`]\/call/.test(jobs), false);
  assert.match(jobs, /Not \/call/);
  assert.match(jobs, /not: \["\/call"/);
});

after(() => {
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(accessLog, { force: true });
});
