// Client spend ledger. Source of truth for spend — not the vault, not the
// facilitator. Keyed (locker, window_start, agent) per graph/nodes/capacity.md.
// Amounts are atomic USDC (6 decimals) as BigInt. No floats.
import fs from "node:fs";
import path from "node:path";

const key = (locker, windowStart) => `${locker}|${windowStart}`;

// Seconds. The only default. Direct reserve() and createLeash must match.
export const RESERVATION_TTL = 120;
export const RESERVATION_TTL_MS = RESERVATION_TTL * 1000;

class BaseJournal {
  // Sum across every agent under this locker's window. The cap is the
  // locker's, not per agent; the agent split is kept for audit.
  spent(locker, windowStart) {
    const entry = this._read()[key(locker, windowStart)];
    if (!entry) return 0n;
    return Object.values(entry.agents).reduce((sum, v) => sum + BigInt(v), 0n);
  }

  spentByAgent(locker, windowStart, agent) {
    const entry = this._read()[key(locker, windowStart)];
    return entry?.agents[agent] === undefined ? 0n : BigInt(entry.agents[agent]);
  }

  reserved(locker, windowStart, nowMs = Date.now()) {
    const state = this._read();
    const entry = state[key(locker, windowStart)];
    if (!entry) return 0n;
    if (this._purge(entry, nowMs)) this._write(state);
    const held = Object.values(entry.holds || {}).reduce((sum, h) => sum + BigInt(h.amount), 0n);
    const flying = Object.values(entry.inflight || {}).reduce((sum, h) => sum + BigInt(h.amount), 0n);
    return held + flying;
  }

  // Atomic vs spent+held+inflight. Throws { code: "cap_exceeded" } rather than
  // over-reserving. Two beforePayment calls cannot both clear a joint over-cap.
  reserve({ locker, windowStart, agent, amount, cap, ttlMs = RESERVATION_TTL_MS, nowMs = Date.now(), id }) {
    if (typeof amount !== "bigint" || amount <= 0n) {
      throw new Error("journal: amount must be a positive BigInt");
    }
    if (typeof cap !== "bigint") throw new Error("journal: cap is required");
    const state = this._read();
    const k = key(locker, windowStart);
    const entry = (state[k] ??= { agents: {}, ids: {}, holds: {}, inflight: {} });
    entry.holds ??= {};
    entry.inflight ??= {};
    this._purge(entry, nowMs);
    const spent = Object.values(entry.agents).reduce((sum, v) => sum + BigInt(v), 0n);
    const held = Object.values(entry.holds).reduce((sum, h) => sum + BigInt(h.amount), 0n);
    const flying = Object.values(entry.inflight).reduce((sum, h) => sum + BigInt(h.amount), 0n);
    if (spent + held + flying + amount > cap) {
      const err = new Error("journal: reservation would exceed cap");
      err.code = "cap_exceeded";
      throw err;
    }
    const rid = id ?? `r-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (entry.holds[rid] || entry.inflight[rid]) {
      throw new Error("journal: reservation id already held");
    }
    entry.holds[rid] = { agent, amount: amount.toString(), until: nowMs + ttlMs };
    this._write(state);
    return rid;
  }

  // Signed and broadcast. Never TTL-purged. Counts against the cap until commit.
  inflight(reservationId, txHash, { nowMs = Date.now() } = {}) {
    if (typeof reservationId !== "string" || !reservationId) {
      throw new Error("journal: reservation id is required");
    }
    if (typeof txHash !== "string" || !txHash) throw new Error("journal: id is required");
    const state = this._read();
    for (const entry of Object.values(state)) {
      entry.holds ??= {};
      entry.inflight ??= {};
      this._purge(entry, nowMs);
      const flying = entry.inflight[reservationId];
      if (flying) {
        if (flying.tx !== txHash) throw new Error("journal: inflight tx mismatch");
        return true;
      }
      const hold = entry.holds[reservationId];
      if (!hold) continue;
      entry.inflight[reservationId] = {
        agent: hold.agent, amount: hold.amount, tx: txHash,
      };
      delete entry.holds[reservationId];
      this._write(state);
      return true;
    }
    return false;
  }

  commit(reservationId, txHash, { nowMs = Date.now() } = {}) {
    if (typeof reservationId !== "string" || !reservationId) {
      throw new Error("journal: reservation id is required");
    }
    if (typeof txHash !== "string" || !txHash) throw new Error("journal: id is required");
    const state = this._read();
    for (const [k, entry] of Object.entries(state)) {
      entry.holds ??= {};
      entry.inflight ??= {};
      this._purge(entry, nowMs);
      const flying = entry.inflight[reservationId];
      const hold = entry.holds[reservationId];
      const row = flying || hold;
      if (!row) continue;
      const [locker, windowStart] = k.split("|");
      if (flying) delete entry.inflight[reservationId];
      if (hold) delete entry.holds[reservationId];
      this._write(state);
      return this.record({
        locker,
        windowStart: Number(windowStart),
        agent: row.agent,
        amount: BigInt(row.amount),
        id: txHash,
        at: Math.floor(nowMs / 1000),
      });
    }
    return false;
  }

  release(reservationId, { nowMs = Date.now() } = {}) {
    if (typeof reservationId !== "string" || !reservationId) return false;
    const state = this._read();
    let found = false;
    for (const entry of Object.values(state)) {
      entry.holds ??= {};
      this._purge(entry, nowMs);
      if (entry.holds[reservationId]) {
        delete entry.holds[reservationId];
        found = true;
      }
    }
    if (found) this._write(state);
    return found;
  }

  _purge(entry, nowMs) {
    if (!entry.holds) return false;
    let changed = false;
    for (const [id, hold] of Object.entries(entry.holds)) {
      if (hold.until <= nowMs) {
        delete entry.holds[id];
        changed = true;
      }
    }
    return changed;
  }

  // Idempotent on id (use the settle signature). Returns false on replay.
  record({ locker, windowStart, agent, amount, id, at }) {
    if (typeof id !== "string" || !id) throw new Error("journal: id is required");
    if (typeof amount !== "bigint" || amount <= 0n) {
      throw new Error("journal: amount must be a positive BigInt");
    }
    const state = this._read();
    const k = key(locker, windowStart);
    const entry = (state[k] ??= { agents: {}, ids: {}, holds: {}, inflight: {} });
    if (entry.ids[id] !== undefined) return false;
    entry.ids[id] = { agent, amount: amount.toString(), at: at ?? Math.floor(Date.now() / 1000) };
    entry.agents[agent] = (BigInt(entry.agents[agent] ?? 0n) + amount).toString();
    this._write(state);
    return true;
  }

  entries(locker, windowStart) {
    const entry = this._read()[key(locker, windowStart)];
    return entry ? Object.entries(entry.ids).map(([id, v]) => ({ id, ...v })) : [];
  }
}

export class MemoryJournal extends BaseJournal {
  #state = {};
  _read() { return this.#state; }
  _write(state) { this.#state = state; }
}

export class FileJournal extends BaseJournal {
  #file;
  constructor(file) {
    super();
    this.#file = file;
  }

  // Exclusive create of `${file}.lock`. tmp+rename is atomic for one write;
  // two processes can still both read-modify-write without this.
  _withLock(fn) {
    const lockPath = `${this.#file}.lock`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const deadline = Date.now() + 2_000;
    let fd;
    for (;;) {
      try {
        fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() > deadline) throw new Error("journal lock timeout");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch { /* lock file already gone */ }
    }
  }

  spent(locker, windowStart) {
    return this._withLock(() => super.spent(locker, windowStart));
  }

  spentByAgent(locker, windowStart, agent) {
    return this._withLock(() => super.spentByAgent(locker, windowStart, agent));
  }

  reserved(locker, windowStart, nowMs = Date.now()) {
    return this._withLock(() => super.reserved(locker, windowStart, nowMs));
  }

  reserve(args) {
    return this._withLock(() => super.reserve(args));
  }

  inflight(reservationId, txHash, opts) {
    return this._withLock(() => super.inflight(reservationId, txHash, opts));
  }

  commit(reservationId, txHash, opts) {
    return this._withLock(() => super.commit(reservationId, txHash, opts));
  }

  release(reservationId, opts) {
    return this._withLock(() => super.release(reservationId, opts));
  }

  record(args) {
    return this._withLock(() => super.record(args));
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      // A corrupt tally must not read as zero spend.
      throw new Error(`journal unreadable: ${error.message}`);
    }
  }

  _write(state) {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
