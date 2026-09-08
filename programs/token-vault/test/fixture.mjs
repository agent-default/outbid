import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  AccountRole as Role, address, appendTransactionMessageInstructions,
  createTransactionMessage, generateKeyPairSigner, getAddressEncoder,
  getBase64EncodedWireTransaction, getProgramDerivedAddress, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { confirmTx } from "./local-rpc.mjs";

export const PROGRAM = address("4FGcyxUtzqMJG4HqtYPiGk7zCMn75N5aLSCDFe3BJPjB");
export const MINT = address("PovfzmSRWs1spwusPpW3ED3B2o26Zhsm8CSDWeXciV3");
export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM = address("11111111111111111111111111111111");
export const ATOMIC = 1_000_000n;
export const COOLDOWN = 86_400;
const enc = getAddressEncoder();
let sequence = 0;

export async function ata(owner, mint = MINT) {
  const [key] = await getProgramDerivedAddress({
    programAddress: ATA, seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(mint)],
  });
  return key;
}

export async function putAccount(rpc, key, owner, data, lamports = 10_000_000) {
  await rpc("surfnet_setAccount", [key, { owner, data: data.toString("hex"), lamports }]);
}

export async function putMint(rpc, mint = MINT) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1_000_000_000n * ATOMIC, 36);
  data[44] = 6;
  data[45] = 1;
  await putAccount(rpc, mint, TOKEN, data);
}

export async function putTokens(rpc, key, owner, amount, mint = MINT) {
  const data = Buffer.alloc(165);
  data.set(enc.encode(mint));
  data.set(enc.encode(owner), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  await putAccount(rpc, key, TOKEN, data);
}

export async function deploy(rpc) {
  const bytes = await fs.readFile(new URL("../target/deploy/token_vault.so", import.meta.url));
  await rpc("surfnet_writeProgram", [PROGRAM, bytes.toString("hex"), 0]);
  await putMint(rpc);
}

export async function account(rpc, key) {
  return (await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }])).value;
}

export async function balance(rpc, key) {
  const value = await account(rpc, key);
  return value ? Buffer.from(value.data[0], "base64").readBigUInt64LE(64) : 0n;
}

export async function clock(rpc) {
  const value = await account(rpc, "SysvarC1ock11111111111111111111111111111111");
  return Number(Buffer.from(value.data[0], "base64").readBigInt64LE(32));
}

export async function travel(rpc, seconds) {
  await rpc("surfnet_timeTravel", [{ absoluteTimestamp: seconds * 1000 }]);
  assert.equal(await clock(rpc), seconds);
}

export async function fixture(rpc, mint = MINT) {
  const locker = await generateKeyPairSigner();
  await putAccount(rpc, locker.address, SYSTEM, Buffer.alloc(0), 10_000_000_000);
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM, seeds: [new TextEncoder().encode("lock"), enc.encode(locker.address)],
  });
  const source = await ata(locker.address, mint);
  const vault = await ata(pda, mint);
  const supply = 200_000n * ATOMIC;
  await putTokens(rpc, source, locker.address, supply, mint);

  function ix(tag, amount = 0n) {
    const data = Buffer.alloc(tag === 0 ? 9 : 1);
    data[0] = tag;
    if (tag === 0) {
      data.writeBigUInt64LE(amount, 1);
    }
    const full = [
      { address: locker.address, role: Role.WRITABLE_SIGNER },
      { address: source, role: Role.WRITABLE },
      { address: pda, role: Role.WRITABLE },
      { address: vault, role: Role.WRITABLE },
      { address: mint, role: Role.READONLY },
      { address: TOKEN, role: Role.READONLY },
      { address: SYSTEM, role: Role.READONLY },
      { address: ATA, role: Role.READONLY },
    ];
    let accounts = full;
    if (tag === 1 || tag === 2) {
      accounts = [full[0], full[2]];
    }
    if (tag === 1) {
      accounts = accounts.map((entry) => ({ ...entry, role: Role.READONLY }));
    }
    return { programAddress: PROGRAM, accounts, data };
  }

  async function wire(instruction, signer = locker) {
    const { value: bh } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const budget = Buffer.alloc(5);
    budget[0] = 2;
    budget.writeUInt32LE(200_000 + ++sequence, 1);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: bh.blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight),
      }, m),
      (m) => appendTransactionMessageInstructions([
        { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: budget },
        instruction,
      ], m),
    );
    return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
  }

  async function send(instruction, signer = locker) {
    const bytes = await wire(instruction, signer);
    const signature = await rpc("sendTransaction", [bytes, { encoding: "base64", skipPreflight: true }]);
    await confirmTx(rpc, signature);
  }

  async function read() {
    const bytes = await wire(ix(1));
    const { value } = await rpc("simulateTransaction", [bytes, { encoding: "base64", sigVerify: true }]);
    assert.equal(value.err, null, JSON.stringify(value));
    assert.equal(value.returnData?.programId, PROGRAM);
    const data = Buffer.from(value.returnData.data[0], "base64");
    assert.equal(data.length, 40, "versioned grant includes lock_time");
    assert.equal(data[31], 0);
    return {
      amount: data.readBigUInt64LE(0), cap: data.readBigUInt64LE(8),
      unbond: Number(data.readBigInt64LE(16)), wallets: data.readUInt16LE(24),
      qps: data.readUInt16LE(26), hours: data.readUInt16LE(28),
      version: data[30], time: Number(data.readBigInt64LE(32)),
    };
  }

  async function snapshot() {
    return Promise.all([pda, source, vault].map((key) => account(rpc, key)));
  }

  async function rejects(instruction, expected, signer = locker) {
    const before = await snapshot();
    await assert.rejects(send(instruction, signer), expected);
    assert.deepEqual(await snapshot(), before, "failed transaction changes no lock or token account");
  }

  return { locker, pda, source, vault, supply, ix, send, read, snapshot, rejects };
}
