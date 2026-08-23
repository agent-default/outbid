/** Canonical ranking copy. Highest bid wins the seat. Last payer collects /next fees. */

export const RANKING_LINE = "#1 is the highest settled bid.";

export const RANKING_JOBS =
  "Highest bid wins the seat. Last payer collects GET /next fees. Those are different jobs.";

export const RANKING_DOC = `# Ranking

Highest bid wins the seat. Last payer collects GET /next fees. Those are different jobs.

#1 is the highest settled bid.
This is not outbid.lol last-screenshot-wins. USDC stacks on a URL. The top score is the answer.

Rank sorts bid_usdc desc. Tie-break is older listing, not newer payment.
A later $0.01 on a $0.06 row does not beat $0.07.

## Two payments, two wallets

POST /bid
  Who pays: someone who wants their URL at #1
  Pays to:  venue (0xB36e… Base / J2h49… Solana)
  Amount:   whatever they send, min $0.01, must reach claim_1_for to take the seat
  Board:    that URL's bid_usdc goes up (cumulative)
  Venue:    100% of the bid (tribute, non-refundable)

GET /next
  Who pays: someone who wants a paid dispatch
  Pays to:  #1.last_payer (matching rail only)
  Amount:   $0.01
  Board:    fee ledger kind:next — rank does not move
  Venue:    0

GET /route
  Who pays: anyone asking for the default URL
  Pays to:  nobody
  Amount:   $0
  Board:    dispatches +1
  Venue:    0

last_payer updates only when someone settles a bid on that listing.
It is who last bought this row, not who last paid for a dispatch.
/next pays that wallet so the occupier earns. It does not crown them #1.

Previous #1's bid is sunk — no refund.
/next exists so catalogs can index a 402 and so the seat has EV.
Solana-only wallets collect /next only when #1.last_payer is a Solana address.
Matching-rail is strict. Venue take on fees is 0.

https://github.com/xpaysh/awesome-x402/pull/1286
`;
