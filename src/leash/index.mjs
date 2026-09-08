// Refuse-before-sign. The vault records; this decides. Never signs, never
// settles, never puts TWZRD in a 402 asset. graph/nodes/capacity.md.
import crypto from "node:crypto";
import { MINT, readLock, windowEnd } from "./lock.mjs";
import { FileJournal, MemoryJournal, RESERVATION_TTL } from "./journal.mjs";
import { FileRoster, StaticRoster } from "./roster.mjs";
import { LeashDenied, wrapSigner } from "./signer.mjs";

export { FileJournal, MemoryJournal, FileRoster, StaticRoster, LeashDenied, wrapSigner, RESERVATION_TTL };
export * from "./lock.mjs";

const deny = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

function rosterFn(roster) {
  if (typeof roster === "function") {
    return roster;
  }
  if (roster && typeof roster.members === "function") {
    return (locker) => roster.members(locker);
  }
  throw new Error("leash: roster is required");
}

function micro(v) {
  return `$${(Number(v) / 1e6).toFixed(2)}`;
}

export function createLeash({
  rpc, journal, roster,
  now = () => Math.floor(Date.now() / 1000),
  programId,
  reservationTtl = RESERVATION_TTL,
}) {
  if (typeof rpc !== "function") throw new Error("leash: rpc is required");
  if (!journal) throw new Error("leash: journal is required");
  const membersOf = rosterFn(roster);

  function nowMs() {
    return now() * 1000;
  }

  function pending(locker, windowStart) {
    return journal.reserved(locker, windowStart, nowMs());
  }

  async function beforePayment({ locker, agent, amount, asset }) {
    if (typeof amount !== "bigint" || amount <= 0n) {
      return deny("bad_amount", "amount must be a positive BigInt of atomic USDC");
    }
    if (asset === MINT) {
      return deny("twzrd_as_asset", "TWZRD is never the 402 asset");
    }

    let lock;
    try {
      lock = await readLock(rpc, locker, programId);
    } catch (error) {
      return deny("no_lock", `lock unreadable: ${error.message}`);
    }
    const { grant, state } = lock;

    if (state.unbondTs !== 0) {
      return deny("unbonded", "unbond started; grant is zero");
    }
    if (grant.windowH === 0) {
      return deny("no_grant", "locked amount is below the first tier");
    }

    const t = now();
    const start = state.lockTime;
    const end = windowEnd(start, grant.windowH);
    if (t < start) return deny("window_not_open", "lock_time is in the future");
    if (t >= end) return deny("window_closed", "grant window has expired", { windowStart: start, windowEnd: end });

    let members;
    try {
      members = await membersOf(locker);
    } catch (error) {
      return deny("roster_unreadable", `roster unreadable: ${error.message}`);
    }
    if (!Array.isArray(members)) return deny("roster_unreadable", "roster must be an array");
    if (members.length > grant.wallets) {
      return deny("roster_too_large", `roster has ${members.length} keys; grant allows ${grant.wallets}`);
    }
    if (!members.includes(agent)) {
      return deny("agent_not_in_roster", "agent pubkey is not in this locker's roster");
    }

    const cap = grant.capUsd * 1_000_000n;
    let spent = 0n;
    let inFlight = 0n;
    let reservation;
    try {
      spent = journal.spent(locker, start);
      inFlight = pending(locker, start);
      reservation = journal.reserve({
        locker, windowStart: start, agent, amount, cap,
        ttlMs: reservationTtl * 1000, nowMs: nowMs(),
        id: crypto.randomUUID(),
      });
    } catch (error) {
      if (error.code === "cap_exceeded") {
        const committed = spent + inFlight;
        const detail = inFlight > 0n ? ` (${micro(inFlight)} in flight)` : "";
        return deny("cap_exceeded", `${micro(committed + amount)} exceeds the ${micro(cap)} cap${detail}`, {
          windowStart: start, windowEnd: end, spent, inFlight, cap,
          remaining: cap > committed ? cap - committed : 0n,
        });
      }
      return deny("tally_unreadable", `tally unreadable: ${error.message}`);
    }

    return {
      ok: true, locker, agent, amount, reservation,
      windowStart: start, windowEnd: end,
      grant, spent, inFlight, cap, remaining: cap - inFlight - amount,
    };
  }

  function markInflight(decision, id) {
    if (!decision?.ok) throw new Error("inflight: decision was not an approval");
    if (!decision.reservation) return false;
    return journal.inflight(decision.reservation, id, { nowMs: nowMs() });
  }

  function afterSettle(decision, id) {
    if (!decision?.ok) throw new Error("afterSettle: decision was not an approval");
    if (decision.reservation) {
      journal.inflight(decision.reservation, id, { nowMs: nowMs() });
      return journal.commit(decision.reservation, id, { nowMs: nowMs() });
    }
    return journal.record({
      locker: decision.locker, windowStart: decision.windowStart,
      agent: decision.agent, amount: decision.amount, id, at: now(),
    });
  }

  function release(decision) {
    if (!decision?.ok) throw new Error("release: decision was not an approval");
    if (!decision.reservation) return false;
    return journal.release(decision.reservation, { nowMs: nowMs() });
  }

  return { beforePayment, afterSettle, inflight: markInflight, release, pending };
}
