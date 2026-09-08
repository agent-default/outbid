// Wrap a signer so the key is not touched until the leash allows it.
// afterSettle runs only after a successful send — a failed broadcast
// must not consume cap. graph/nodes/capacity.md.

export class LeashDenied extends Error {
  constructor(decision) {
    super(decision?.reason ?? "leash denied");
    this.name = "LeashDenied";
    this.code = decision?.code;
    this.decision = decision;
  }
}

function requireLeash(leash) {
  if (typeof leash?.beforePayment !== "function" || typeof leash?.afterSettle !== "function") {
    throw new Error("wrapSigner: leash is required");
  }
}

function requireInner(inner) {
  if (!inner || typeof inner.signTransaction !== "function") {
    throw new Error("wrapSigner: signer.signTransaction is required");
  }
}

export function wrapSigner(inner, leash, { locker, agent } = {}) {
  requireInner(inner);
  requireLeash(leash);
  const agentKey = agent ?? inner.address;
  if (!locker) {
    throw new Error("wrapSigner: locker is required");
  }
  if (!agentKey) {
    throw new Error("wrapSigner: agent is required");
  }

  async function signPayment({ amount, asset, transaction }) {
    const decision = await leash.beforePayment({
      locker, agent: agentKey, amount, asset,
    });
    if (!decision.ok) {
      throw new LeashDenied(decision);
    }
    const signed = await inner.signTransaction(transaction);
    return { signed, decision };
  }

  function confirm(decision, id) {
    return leash.afterSettle(decision, id);
  }

  async function sendPayment({ amount, asset, transaction, network }) {
    const { signed, decision } = await signPayment({ amount, asset, transaction });
    if (typeof inner.sendTransaction !== "function") {
      throw new Error("wrapSigner: signer.sendTransaction is required for sendPayment");
    }
    const id = await inner.sendTransaction(signed, network);
    confirm(decision, id);
    return { signed, decision, id };
  }

  return {
    address: inner.address ?? agentKey,
    locker,
    signPayment,
    confirm,
    sendPayment,
  };
}
