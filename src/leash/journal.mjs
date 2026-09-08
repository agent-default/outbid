// Client spend ledger. Source of truth for spend — not the vault, not the
// facilitator. Keyed (locker, window_start, agent) per graph/nodes/capacity.md.
// Amounts are atomic USDC (6 decimals) as BigInt. No floats.
import fs from "node:fs";
import path from "node:path";

const key = (locker, windowStart) => `${locker}|${windowStart}`;

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

  // Idempotent on id (use the settle signature). Returns false on replay.
  record({ locker, windowStart, agent, amount, id, at }) {
    if (typeof id !== "string" || !id) throw new Error("journal: id is required");
    if (typeof amount !== "bigint" || amount <= 0n) {
      throw new Error("journal: amount must be a positive BigInt");
    }
    const state = this._read();
    const k = key(locker, windowStart);
    const entry = (state[k] ??= { agents: {}, ids: {} });
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
