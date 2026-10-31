// Transaction and claim-key helpers. @solana/web3.js is imported lazily so the
// public claim page stays light until the recipient actually confirms something.
import bs58 from "bs58";
import { api, type OperationState } from "./api";

const web3 = () => import("@solana/web3.js");

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Has the browser wallet add its signature to the exact server-prepared transaction. */
export async function signWithWallet(
  txBase64: string,
  signTransaction: (bytes: Uint8Array) => Promise<Uint8Array>,
) {
  return toBase64(await signTransaction(fromBase64(txBase64)));
}

/** Adds the link's claim-key signature, keeping every server signature and the message intact. */
export async function signWithClaimKey(txBase64: string, secretKey: Uint8Array) {
  const { Keypair, Transaction } = await web3();
  const tx = Transaction.from(fromBase64(txBase64));
  tx.partialSign(Keypair.fromSecretKey(secretKey));
  return toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

// ---------- Claim key ----------
// Derived on the sender's device: the wallet signs a fixed message per link, and the
// signature's SHA-256 seeds an ed25519 keypair. Muuve never stores it, and the sender
// can re-derive it to share the link again. Only the public key goes to the server.

export const claimMessage = (linkIdHex: string) =>
  new TextEncoder().encode(`muuve-claim-v1:${linkIdHex}`);

export async function claimKeyFromSignature(signature: Uint8Array) {
  const { Keypair } = await web3();
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", signature as BufferSource));
  const pair = Keypair.fromSeed(seed);
  return { publicKey: pair.publicKey.toBase58(), secret: bs58.encode(pair.secretKey) };
}

export function decodeClaimSecret(secret: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(secret);
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

// In-memory only: lets the share screen show the link right after creation without
// asking the wallet to sign again. Never written to storage.
const secrets = new Map<string, string>();
export const rememberClaimSecret = (linkId: string, secret: string) => secrets.set(linkId, secret);
export const recallClaimSecret = (linkId: string) => secrets.get(linkId);

export function claimUrl(linkId: string, secret: string) {
  return `${window.location.origin}/c/${linkId}#k=${secret}`;
}

// ---------- Operations ----------

export const TERMINAL_STATES: OperationState[] = ["finalized", "failed"];

/** Polls an operation with bounded backoff until it is finalized or failed. */
export async function waitForOperation(
  operationId: string,
  onState?: (state: OperationState) => void,
  timeoutMs = 120_000,
): Promise<OperationState> {
  const started = Date.now();
  let delay = 1200;
  let last: OperationState = "submitted";
  while (Date.now() - started < timeoutMs) {
    try {
      const op = await api<{ state: OperationState }>(`/api/operations/${operationId}`);
      last = op.state;
      onState?.(last);
      if (TERMINAL_STATES.includes(last)) return last;
    } catch {
      // Transient read failures: keep polling within the time budget.
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 6000);
  }
  return last;
}
