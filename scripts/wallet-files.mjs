import fs from "node:fs";

const DIR = process.env.OUTBID_WALLET_DIR || "/home/twzrd/security/wallets/outbid";

export const walletDir = DIR;

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadEvmPrivateKey() {
  if (process.env.EVM_PRIVATE_KEY) return process.env.EVM_PRIVATE_KEY;
  const file = process.env.EVM_PRIVATE_KEY_FILE || `${DIR}/payer.evm.json`;
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("{")) return JSON.parse(raw).privateKey;
  if (raw.startsWith("0x")) return raw;
  return `0x${raw}`;
}

export function loadSvmSecretBytes() {
  if (process.env.SVM_PRIVATE_KEY) {
    return null; // caller decodes base58
  }
  const file = process.env.SVM_PRIVATE_KEY_FILE || `${DIR}/payer.svm.json`;
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = Array.isArray(j) ? j : j.secretKey;
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(`SVM key file ${file} is not a 64-byte keypair`);
  }
  return Uint8Array.from(arr);
}

export function loadReceiverAddresses() {
  const evmFile = `${DIR}/receiver.evm.json`;
  const svmPub = `${DIR}/receiver.svm.pubkey`;
  return {
    evm: fs.existsSync(evmFile) ? readJson(evmFile).address : null,
    svm: fs.existsSync(svmPub) ? fs.readFileSync(svmPub, "utf8").trim() : null,
  };
}
