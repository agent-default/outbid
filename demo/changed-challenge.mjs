// CONTROLLED DEMONSTRATION — not a real purchase, not a live seller.
// A local server issues a 402, the assessment binds to those exact terms, and a
// payment presenting different terms is refused BEFORE the request leaves the
// process. No wallet, no signature, no settlement, no third party.
import http from "node:http";
import {
  challengeBind, buildAssessment, decideMandate, observeMethodHold,
  assertPaymentMatchesAssessment, assessmentAuthorizes, twzrdCheck,
} from "../skills/outbid/smart-fetch.js";

const READER_SOL = "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM";
const READER_EVM = "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F";
const ATTACKER  = "9urRvUx69HqAopvnbCbLpMGN1hVoi6gQYSKz1z6ZUCA5";

const termsA = [
  { scheme: "exact", network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxAmountRequired: "50000", payTo: READER_SOL },
  { scheme: "exact", network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxAmountRequired: "50000", payTo: READER_EVM },
];

const srv = http.createServer((req, res) => {
  res.writeHead(402, { "content-type": "application/json" });
  res.end(JSON.stringify({ x402Version: 1, accepts: termsA }));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/paid-resource`;

const line = (s) => console.log(s);
line("CONTROLLED DEMONSTRATION — local 402, no wallet, no settlement\n");

// 1. The origin issues its challenge. The assessment binds to those exact terms.
const bind = challengeBind(url, "GET", termsA);
const wallets = [];
for (const a of termsA) wallets.push(await twzrdCheck(a.payTo, Number(a.maxAmountRequired) / 1e6));
const endpoint = await observeMethodHold(url);
const { action, reasons, cap } = decideMandate(wallets, endpoint);
const assessment = buildAssessment({ bind, wallets, endpoint, action, reasons, cap });

line("1. CHALLENGE OBSERVED — assessment bound to these exact terms");
for (const r of bind.rails) line(`     ${r.network}  ${r.amount} (${Number(r.amount) / 1e6} USDC)  payTo ${r.payTo}`);
line(`   url    ${bind.url}`);
line(`   method ${bind.method}`);
line(`   wallet verdicts   ${wallets.map((v) => `${v.seller.slice(0, 8)}=${v.decision}`).join("  ")}`);
line(`   endpoint observed method_hold=${endpoint.method_hold}`);
line(`   missing evidence  ${assessment.observed.missing.join(", ")}`);
line(`   delivery_proof    ${assessment.observed.delivery_proof}`);
line(`   DECISION          ${action}${cap != null ? ` cap=$${cap}` : ""}  reasons=[${reasons.join(", ")}]\n`);

const pay = (accepted) => Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { sig: "<not-signed>" } })).toString("base64");

// 2. A payment on the assessed terms is authorised.
line("2. PAYMENT ON THE ASSESSED TERMS");
try {
  assertPaymentMatchesAssessment([assessment], pay({ scheme: "exact", network: "solana", asset: termsA[0].asset, amount: "50000", payTo: READER_SOL }));
  line("   -> authorised: the assessment covers these terms\n");
} catch (e) { line(`   -> UNEXPECTED ${e.name}\n`); }

// 3. Recipient swapped. Same URL, same price, different payee.
line("3. RECIPIENT CHANGED (same url, same amount, different payTo)");
try {
  assertPaymentMatchesAssessment([assessment], pay({ scheme: "exact", network: "solana", asset: termsA[0].asset, amount: "50000", payTo: ATTACKER }));
  line("   -> LEAK: payment allowed\n");
} catch (e) {
  line(`   -> REFUSED ${e.name}  unpaid, before the request left the process`);
  line(`      assessed payees : ${e.twzrd.previous.challenge.rails.map((r) => r.payTo.slice(0, 12)).join(", ")}`);
  line(`      presented payee : ${e.twzrd.next.payTo.slice(0, 12)}\n`);
}

// 4. Amount raised.
line("4. AMOUNT CHANGED ($0.05 assessed, $5.00 presented)");
try {
  assertPaymentMatchesAssessment([assessment], pay({ scheme: "exact", network: "solana", asset: termsA[0].asset, amount: "5000000", payTo: READER_SOL }));
  line("   -> LEAK: payment allowed\n");
} catch (e) {
  line(`   -> REFUSED ${e.name}  unpaid`);
  line(`      assessed amount : ${e.twzrd.previous.challenge.rails.find((r) => r.payTo === READER_SOL)?.amount}`);
  line(`      presented amount: ${e.twzrd.next.amount}\n`);
}

// 5. The origin re-issues a different challenge mid-flight.
line("5. ORIGIN RE-ISSUES A DIFFERENT CHALLENGE MID-FLIGHT");
const termsB = [{ ...termsA[0], payTo: ATTACKER }];
const bind2 = challengeBind(url, "GET", termsB);
line(`   -> assessment authorizes the new challenge? ${assessmentAuthorizes(assessment, bind2)}`);
line("      gate402 throws TwzrdChallengeChangedError on this path, unpaid\n");

line("RECORD (what the buyer keeps):");
console.log(JSON.stringify(assessment, null, 1));
srv.close();
