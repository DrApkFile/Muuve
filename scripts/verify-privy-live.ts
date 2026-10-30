import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { createPrivateKey, randomUUID, randomBytes, sign } from "node:crypto";
import { Keypair, Connection, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { PrivyClient, type User } from "@privy-io/node";
import { SignJWT, importPKCS8, jwtVerify, createLocalJWKSet } from "jose";
import bs58 from "bs58";
import { handle } from "../apps/web/lib/server/router";
import { database, closeDatabase } from "../apps/web/lib/server/db";
import { validWalletSignature } from "../apps/web/lib/server/wallet-auth";
import { verifyWallet } from "../apps/web/lib/server/providers/privy";
import { verifyCustomAuthToken } from "../apps/web/lib/server/auth";
import { secretValue } from "../apps/web/lib/server/secrets";
import { DEVNET_GENESIS } from "../apps/web/lib/server/solana/chain";

const evidence: Record<string, unknown> = {
  started_at: new Date().toISOString(),
  scope:
    "New local API and disposable SQL, real Privy, real hosted JWKS; no hosted login or chain submission",
  checks: [],
  blockchain_transactions_submitted: 0,
  private_keys_exported: false,
};
const privateFile = "keys/privy-live-test.json";
function assert(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
function check(name: string, details: Record<string, unknown> = {}) {
  (evidence.checks as unknown[]).push({ name, state: "passed", ...details });
}
let stage = "preflight";
let cookie = "";
async function main() {
  const origin = process.env.APP_BASE_URL,
    appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  assert(
    process.env.MUUVE_PRIVY_TEST_APPROVED === "1" &&
      origin === "https://muuve.onrender.com" &&
      process.env.SOLANA_CLUSTER === "devnet" &&
      process.env.PAYOUT_PROVIDER === "mock" &&
      appId,
    "explicit_devnet_test_configuration_required",
  );
  assert(
    new URL(process.env.DATABASE_URL ?? "").hostname === "127.0.0.1",
    "disposable_loopback_database_required",
  );
  assert(
    ((await stat("keys/devnet/test-sender.json")).mode & 0o077) === 0,
    "private_wallet_permissions_required",
  );
  const sender = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile("keys/devnet/test-sender.json", "utf8"))),
  );
  let progress: { user_id: string; sender: string; phase: string; privy_user_id?: string };
  try {
    assert(((await stat(privateFile)).mode & 0o077) === 0, "private_progress_permissions_required");
    progress = JSON.parse(await readFile(privateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    progress = { user_id: randomUUID(), sender: sender.publicKey.toBase58(), phase: "reserved" };
  }
  assert(progress.sender === sender.publicKey.toBase58(), "test_identity_wallet_mismatch");
  const save = () =>
    writeFile(privateFile, JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  await save();
  // A stable pre-existing test account fixture; authenticating it still requires its actual wallet signature.
  await database().query(
    "INSERT INTO users(id,display_name,auth_origin,wallet_address) VALUES($1,'Privy test sender','wallet',$2)",
    [progress.user_id, progress.sender],
  );
  async function call(path: string, body?: unknown) {
    const result = await handle(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: origin!, "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    assert(result.ok, `local_api_http_${result.status}`);
    const values = new Map(
      cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf("=");
          return [pair.slice(0, i), pair.slice(i + 1)];
        }),
    );
    for (const value of result.headers.getSetCookie()) {
      const pair = value.split(";")[0]!,
        i = pair.indexOf("="),
        key = pair.slice(0, i),
        token = pair.slice(i + 1);
      if (token) values.set(key, token);
      else values.delete(key);
    }
    cookie = [...values].map(([k, v]) => `${k}=${v}`).join("; ");
    return result.json();
  }
  stage = "local_wallet_login";
  const challenge = await call("/api/auth/wallet/challenge", { wallet_address: progress.sender });
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      sender.secretKey.slice(0, 32),
    ]),
    type: "pkcs8",
    format: "der",
  });
  const signature = bs58.encode(sign(null, Buffer.from(challenge.message), key));
  const login = await call("/api/auth/wallet/login", {
    challenge_id: challenge.challenge_id,
    signature,
  });
  assert(login.user.id === progress.user_id, "authenticated_fixture_identity_mismatch");
  check("wallet_only_local_api_login_and_database", { phone_required: false });
  const bridge = await call("/api/auth/privy-token");
  await verifyCustomAuthToken(bridge.token);
  const jwksResponse = await fetch(origin + "/api/auth/jwks", {
    signal: AbortSignal.timeout(45000),
  });
  assert(jwksResponse.ok, "hosted_jwks_unavailable");
  const jwks = await jwksResponse.json();
  assert(jwks.keys?.length === 1 && !("d" in jwks.keys[0]), "public_jwks_required");
  const verified = await jwtVerify(bridge.token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: origin,
    audience: appId,
  });
  assert(
    verified.payload.sub === progress.user_id &&
      verified.protectedHeader.kid === process.env.AUTH_JWT_KID,
    "hosted_jwks_token_mismatch",
  );
  check("real_hosted_jwks_verifies_local_api_bridge_jwt");
  const client = new PrivyClient({
    appId,
    appSecret: process.env.PRIVY_APP_SECRET!,
    timeout: 15000,
    maxRetries: 0,
  });
  const settings = await client.apps().getSettings();
  assert(settings.id === appId && settings.custom_jwt_auth, "privy_custom_auth_must_be_enabled");
  stage = "dedicated_privy_identity";
  let user: User;
  try {
    user = await client.users().getByCustomAuthID({ custom_user_id: progress.user_id });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    assert(progress.phase === "reserved", "prior_privy_creation_outcome_requires_reconciliation");
    progress.phase = "creating";
    await save();
    user = await client.users().create({
      linked_accounts: [{ type: "custom_auth", custom_user_id: progress.user_id }],
      wallets: [{ chain_type: "solana" }],
    });
  }
  progress.privy_user_id = user.id;
  progress.phase = "created";
  await save();
  const wallet = user.linked_accounts.find(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy",
  );
  assert(
    wallet?.type === "wallet" && "id" in wallet && typeof wallet.id === "string",
    "dedicated_embedded_wallet_required",
  );
  const walletId = wallet.id,
    address = wallet.address;
  const record = await client.wallets().get(walletId);
  assert(
    record.owner_id && record.address === address && record.chain_type === "solana",
    "wallet_owner_record_mismatch",
  );
  const quorum = await client.keyQuorums().get(record.owner_id);
  assert(
    quorum.authorization_threshold === 1 &&
      quorum.user_ids?.length === 1 &&
      quorum.user_ids[0] === user.id &&
      quorum.authorization_keys.length === 0 &&
      (quorum.key_quorum_ids?.length ?? 0) === 0 &&
      Array.isArray(record.additional_signers) &&
      record.additional_signers.length === 0,
    "dedicated_user_only_owner_quorum_required",
  );
  assert(
    (await verifyWallet(progress.user_id, address)) === user.id,
    "server_ownership_verification_failed",
  );
  let rejected = false;
  try {
    await verifyWallet(progress.user_id, progress.sender);
  } catch (error) {
    rejected = (error as { status?: number }).status === 403;
  }
  assert(rejected, "unowned_wallet_must_be_rejected");
  check("privy_server_records_bind_custom_user_and_wallet", {
    wallet_address: address,
    user_id: progress.user_id,
    privy_user_id: user.id,
    user_only_owner_quorum_verified: true,
  });
  const message = new TextEncoder().encode(
    `Muuve devnet test only. No transfer. ${randomBytes(16).toString("hex")}`,
  );
  stage = "jwt_authorized_message_signing";
  const signed = await client
    .wallets()
    .solana()
    .signMessage(walletId, { message, authorization_context: { user_jwts: [bridge.token] } });
  assert(
    signed.encoding === "base64" &&
      validWalletSignature(
        address,
        new TextDecoder().decode(message),
        bs58.encode(Buffer.from(signed.signature, "base64")),
      ),
    "privy_message_signature_invalid",
  );
  check("privy_accepts_muuve_jwt_and_signs_valid_solana_message");
  stage = "unsigned_authorization_rejection";
  rejected = false;
  try {
    await client.wallets().solana().signMessage(walletId, { message });
  } catch (error) {
    rejected = [401, 403].includes((error as { status?: number }).status ?? 0);
  }
  assert(rejected, "wallet_signing_must_require_user_authorization");
  check("app_secret_without_user_authorization_cannot_sign");
  stage = "expired_jwt_rejection";
  const expired = await new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid: process.env.AUTH_JWT_KID })
    .setIssuer(origin)
    .setAudience(appId)
    .setSubject(progress.user_id)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
    .sign(await importPKCS8(secretValue("AUTH_JWT_PRIVATE_KEY")!, "ES256"));
  rejected = false;
  try {
    await client
      .wallets()
      .solana()
      .signMessage(walletId, { message, authorization_context: { user_jwts: [expired] } });
  } catch (error) {
    rejected = [400, 401, 403].includes((error as { status?: number }).status ?? 0);
  }
  assert(rejected, "expired_jwt_must_be_rejected");
  check("privy_rejects_expired_muuve_jwt");
  stage = "devnet_transaction_signing_without_submission";
  const rpc = new Connection(process.env.SOLANA_RPC_URL!, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
  });
  assert((await rpc.getGenesisHash()) === DEVNET_GENESIS, "devnet_genesis_required");
  const pub = new PublicKey(address);
  const tx = new Transaction({ feePayer: pub, ...(await rpc.getLatestBlockhash("finalized")) }).add(
    SystemProgram.transfer({ fromPubkey: pub, toPubkey: pub, lamports: 0 }),
  );
  const transaction = tx.serialize({ requireAllSignatures: false }).toString("base64");
  const result = await client
    .wallets()
    .solana()
    .signTransaction(walletId, {
      transaction,
      authorization_context: { user_jwts: [bridge.token] },
    });
  const signedTx = Transaction.from(Buffer.from(result.signed_transaction, "base64"));
  assert(
    signedTx.serializeMessage().equals(tx.serializeMessage()) && signedTx.verifySignatures(),
    "signed_transaction_message_or_signature_invalid",
  );
  check("privy_signs_exact_devnet_test_transaction_without_broadcast", { amount_lamports: 0 });
  await call("/api/auth/logout", {});
  cookie = "";
  progress.phase = "verified";
  await save();
  evidence.state = "passed_local_wallet_login_real_privy_and_hosted_jwks";
}
try {
  await main();
} catch (error) {
  evidence.state = "blocked_or_failed";
  evidence.stage = stage;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") evidence.provider_http_status = status;
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "provider_or_transport_failure";
  process.exitCode = 1;
} finally {
  if (cookie) {
    try {
      await handle(
        new Request(`${process.env.APP_BASE_URL}/api/auth/logout`, {
          method: "POST",
          headers: { origin: process.env.APP_BASE_URL!, cookie },
        }),
      );
    } catch {
      /* Disposable sessions are also destroyed with the test database. */
    }
  }
  await closeDatabase();
}
await mkdir("evidence/privy-wallet", { recursive: true });
evidence.finished_at = new Date().toISOString();
await writeFile(
  "evidence/privy-wallet/live-verification.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.info(JSON.stringify(evidence));
