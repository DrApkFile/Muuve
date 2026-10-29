import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { parseEnv } from "node:util";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

// Explicit local provisioning only: no RPC, no wallet upload, no secret output.
process.umask(0o077);
const root = resolve(process.argv.find((x) => x.startsWith("--root="))?.slice(7) ?? ".");
const manifestPath = resolve(root, "config/devnet-public.json");
const knownManifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : undefined;
for (const entry of Object.values(knownManifest?.roles ?? {})) {
  if (!existsSync(resolve(root, entry.file)))
    throw new Error(
      "An existing identity's key file is missing. Restore its protected backup; refusing to replace it.",
    );
}
if (
  !existsSync(resolve(root, "keys/auth-private.pem")) &&
  (existsSync(resolve(root, "keys/auth-public.pem")) ||
    existsSync(resolve(root, "keys/auth-kid.txt")))
)
  throw new Error(
    "Existing signing identity is missing its private key; restore the backup instead of rotating it.",
  );
const dir = resolve(root, "keys/devnet");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(resolve(root, "keys"), 0o700);
chmodSync(dir, 0o700);
function privateFile(file, make) {
  if (!existsSync(file)) writeFileSync(file, make(), { flag: "wx", mode: 0o600 });
  if (!statSync(file).isFile()) throw new Error("Expected a regular secret file");
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8");
}
const pemPath = resolve(root, "keys/auth-private.pem");
const pem = privateFile(pemPath, () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
);
const key = createPrivateKey(pem);
if (
  !pem.startsWith("-----BEGIN PRIVATE KEY-----") ||
  key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
)
  throw new Error("Existing signing key is not ES256 PKCS8; refusing rotation");
const kid = privateFile(resolve(root, "keys/auth-kid.txt"), () => randomUUID() + "\n").trim();
const publicKey = createPublicKey(key);
const check = Buffer.from("Muuve local key correspondence check");
if (!verify("sha256", check, publicKey, sign("sha256", check, key)))
  throw new Error("Signing key verification failed");
const publicFile = resolve(root, "keys/auth-public.pem"),
  publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
if (existsSync(publicFile) && readFileSync(publicFile, "utf8") !== publicPem)
  throw new Error("Existing public key mismatch; refusing overwrite");
if (!existsSync(publicFile)) writeFileSync(publicFile, publicPem, { flag: "wx", mode: 0o600 });
const roles = {};
for (const role of [
  "deployment-authority",
  "admin",
  "attestor",
  "fee-payer",
  "treasury",
  "test-mint-authority",
  "test-sender",
  "test-recipient",
  "test-claim",
  "program",
  "test-mint",
  "deployment-buffer",
]) {
  const file = resolve(dir, `${role}.json`);
  const raw = privateFile(file, () => JSON.stringify([...Keypair.generate().secretKey]) + "\n");
  roles[role] = {
    public_key: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))).publicKey.toBase58(),
    file: relative(root, file),
  };
  if (knownManifest?.roles[role] && roles[role].public_key !== knownManifest.roles[role].public_key)
    throw new Error("A local key disagrees with the saved public identity; refusing replacement.");
}
if (new Set(Object.values(roles).map((x) => x.public_key)).size !== Object.keys(roles).length)
  throw new Error("Role collision");
const mint = roles["test-mint"].public_key;
const treasury = getAssociatedTokenAddressSync(
  new PublicKey(mint),
  new PublicKey(roles.treasury.public_key),
  false,
  TOKEN_PROGRAM_ID,
).toBase58();
const values = {
  APP_ENV: "local",
  APP_BASE_URL: "http://localhost:3000",
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  MUUVE_PROGRAM_ID: roles.program.public_key,
  USDT_MINT: mint,
  TOKEN_PROGRAM_ID: TOKEN_PROGRAM_ID.toBase58(),
  TREASURY_TOKEN_ACCOUNT: treasury,
  CLAIM_WINDOW_SECS: "172800",
  OTP_PROVIDER: "mock",
  WHATSAPP_OTP_ENABLED: "false",
  PAYOUT_PROVIDER: "mock",
  RATE_PROVIDER: "mock",
  MOCK_NGN_PER_USD: "1520",
  TRUSTED_PROXY: "false",
  SESSION_SECRET: randomBytes(32).toString("hex"),
  CRON_SECRET: randomBytes(32).toString("hex"),
  MOCK_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  AUTH_JWT_PRIVATE_KEY_FILE: "keys/auth-private.pem",
  AUTH_JWT_KID: kid,
};
for (const [name, role] of Object.entries({
  FEE_PAYER_SECRET: "fee-payer",
  ATTESTOR_SECRET: "attestor",
  TREASURY_SECRET: "treasury",
  TEST_MINT_AUTHORITY_SECRET: "test-mint-authority",
  OPERATOR_ADMIN_SECRET: "admin",
  OPERATOR_DEPLOYMENT_SECRET: "deployment-authority",
  DEVNET_TEST_SENDER_SECRET: "test-sender",
  DEVNET_TEST_CLAIM_SECRET: "test-claim",
  TEST_MINT_SECRET: "test-mint",
}))
  values[`${name}_FILE`] = roles[role].file;
Object.assign(values, {
  ADMIN_PUBLIC_KEY: roles.admin.public_key,
  ATTESTOR_PUBLIC_KEY: roles.attestor.public_key,
  FEE_PAYER_PUBLIC_KEY: roles["fee-payer"].public_key,
  TREASURY_OWNER_PUBLIC_KEY: roles.treasury.public_key,
  TEST_MINT_AUTHORITY_PUBLIC_KEY: roles["test-mint-authority"].public_key,
  DEVNET_TEST_RECIPIENT: roles["test-recipient"].public_key,
});
const envFile = resolve(root, ".env.local");
const old = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const parsed = parseEnv(old);
// Never replace existing settings or change an existing deployment identity.
for (const name of ["MUUVE_PROGRAM_ID", "USDT_MINT", "TREASURY_TOKEN_ACCOUNT", "AUTH_JWT_KID"])
  if (parsed[name] && parsed[name] !== values[name])
    throw new Error(`Existing ${name} disagrees with local keys; refusing overwrite`);
const additions = Object.entries(values).filter(
  ([name]) => parsed[name] === undefined && !(name.endsWith("_FILE") && parsed[name.slice(0, -5)]),
);
const addedText =
  (old.endsWith("\n") || !old ? "" : "\n") +
  additions.map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join("");
if (!existsSync(envFile)) writeFileSync(envFile, addedText, { flag: "wx", mode: 0o600 });
else if (additions.length) appendFileSync(envFile, addedText);
chmodSync(envFile, 0o600);
mkdirSync(resolve(root, "config"), { recursive: true });
writeFileSync(
  resolve(root, "config/devnet-public.json"),
  JSON.stringify(
    {
      network: "devnet",
      identity_source: "locally-derived; see evidence for on-chain status",
      program_id: roles.program.public_key,
      mint,
      token_program: TOKEN_PROGRAM_ID.toBase58(),
      treasury_token_account: treasury,
      roles,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o644 },
);
console.info(
  JSON.stringify({
    state: "local_keys_ready",
    algorithm: "ES256",
    encoding: "PKCS8",
    kid,
    private_files_mode: "0600",
    role_count: Object.keys(roles).length,
    manifest: "config/devnet-public.json",
    environment: ".env.local",
    network_actions: false,
  }),
);
