// Which agent keys a locker allows. v0 is an OPERATOR leash: the operator
// configures this list for their own agents. There is no cryptographic
// delegation from locker to agent — a copied roster file is a copied roster.
// Cross-signing belongs to multi-tenant pools and slash, neither of which is
// built. The tier ceiling (grant.wallets) is on-chain; the list is not.
import fs from "node:fs";
import path from "node:path";

function validate(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("roster: expected a map of locker -> pubkeys");
  }
  for (const keys of Object.values(state)) {
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
      throw new Error("roster: each locker needs an array of pubkeys");
    }
  }
  return state;
}

class BaseRoster {
  // An unknown locker has no agents. That reads as "nothing is allowed",
  // which is the safe direction.
  members(locker) {
    return this._read()[locker] ?? [];
  }

  count(locker) { return this.members(locker).length; }
  has(locker, agent) { return this.members(locker).includes(agent); }
}

export class StaticRoster extends BaseRoster {
  #state;
  constructor(state = {}) {
    super();
    this.#state = validate(state);
  }

  _read() { return this.#state; }
}

export class FileRoster extends BaseRoster {
  #file;
  constructor(file) {
    super();
    this.#file = file;
  }

  // A corrupt roster is an error, not an empty list. Empty would fail closed
  // too, but the operator must see a broken file rather than a silent lockout.
  _read() {
    try {
      return validate(JSON.parse(fs.readFileSync(this.#file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(`roster unreadable: ${error.message}`);
    }
  }

  write(state) {
    validate(state);
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    return this;
  }
}
