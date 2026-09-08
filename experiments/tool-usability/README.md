# Tool usability — what the cookbook is good for here

Leverage found in `anthropics/claude-cookbooks` → `tool_evaluation/`:
several agents independently run each task from an `evaluation.xml` of
`<task><prompt/><response/></task>`, and you score whether the **agent** used
the tool correctly. It measures interface quality, not implementation.

**Why this one and not the others.** `evals/` and `misc/building_evals.ipynb`
tempt us toward validating the wash score. That is G1, and G1 is INFEASIBLE:
OFAC has 2 Solana addresses, DefiLlama's hack feed carries none, so there are
no independent labels. Tool usability needs no external labels — the correct
decision given our own card is ours to define. **A pass here must never be
cited as evidence the score is valid.**

Run it as the cookbook does; score the decision, not the prose.

## Two defects found by using the tool, before running a single task

### 1. `merchant_card` costs ~6,600 tokens per call

Measured live, 2026-09-08, wallet `9N5TAHbtp9s8Ksrcn4b9Kig4uTRnevZC13bSsMnMAQ4c`:

| | |
|---|---|
| Response | **26,299 bytes ≈ 6,574 tokens** |
| `services` array alone | 21,672 bytes — **82% of the payload**, 23 entries |
| What a routing decision needs | **197 bytes** |
| Ratio | **133×** |

This is the *free* tool, the one we want agents to call first. Checking five
sellers costs ~33k tokens before any work happens. An agent that tries this
once will not try it twice, and no registry listing survives that.

Fix is additive, not breaking: return the decision core by default and put
the service catalogue behind an explicit `include=services` (or a separate
`get_x402_directory` call, which already exists). Nothing needs removing.

### 2. Our card and our gate disagree on the same input

For that wallet the card returns `next_action.decision:
insufficient_evidence`, with reason *"Absence of evidence is not evidence of
fraud — buy the cheap rung to disambiguate."* Correct, and it is the seller's
own listing: 23 services, 12 `live_402_verified`.

But `twzrd-x402-gate@0.9.4`'s default wash engine **aborts** on
null/partial/stale coverage (`wash-default.ts`: "unknown ≠ clean"). So the
same unscored seller is *proceed-with-a-cheaper-check* to the card and
*blocked* to the gate.

That is ClawRouter finding (3) — the one they were right about, and the
reason AutoGate was deleted — sitting inside our own two products as a
contradiction. Whichever is right, both cannot ship. Task
`thin-seller-is-not-a-refusal` pins the card's semantics as the intended one.

## What this does not establish

Nothing about demand, and nothing about whether the wash score predicts
anything. It measures whether an agent handed our tools reaches the decision
we intend. That is a prerequisite for a registry listing converting into a
call, not evidence anyone wants the call.
