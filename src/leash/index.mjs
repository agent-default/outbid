// Refuse-before-sign. The vault records; this decides. Never signs, never
// settles, never puts TWZRD in a 402 asset. graph/nodes/capacity.md.
import { MINT, readLock, windowEnd } from "./lock.mjs";
import { FileJournal, MemoryJournal } from "./journal.mjs";
import { FileRoster, StaticRoster } from "./roster.mjs";
import { LeashDenied, wrapSigner } from "./signer.mjs";

export { FileJournal, MemoryJournal, FileRoster, StaticRoster, LeashDenied, wrapSigner };
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

export function createLeash({ rpc, journal, roster, now = () => Math.floor(Date.now() / 1000), programId }) {
  if (typeof rpc !== "function") throw new Error("leash: rpc is required");
  if (!journal) throw new Error("leash: journal is required");
  const membersOf = rosterFn(roster);

  // Every failure path returns a denial. There is no path that signs on
  // missing evidence: RPC down, absent lock, or unreadable tally → refuse.
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
    let spent;
    try {
      spent = journal.spent(locker, start);
    } catch (error) {
      return deny("tally_unreadable", `tally unreadable: ${error.message}`);
    }
    if (spent + amount > cap) {
      const micro = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
      return deny("cap_exceeded", `${micro(spent + amount)} exceeds the ${micro(cap)} cap`, {
        windowStart: start, windowEnd: end, spent, cap, remaining: cap > spent ? cap - spent : 0n,
      });
    }

    return {
      ok: true, locker, agent, amount,
      windowStart: start, windowEnd: end,
      grant, spent, cap, remaining: cap - spent - amount,
    };
  }

  // Success only. `id` is the settle signature; replays are not double-counted.
  function afterSettle(decision, id) {
    if (!decision?.ok) throw new Error("afterSettle: decision was not an approval");
    return journal.record({
      locker: decision.locker, windowStart: decision.windowStart,
      agent: decision.agent, amount: decision.amount, id, at: now(),
    });
  }

  return { beforePayment, afterSettle };
}
