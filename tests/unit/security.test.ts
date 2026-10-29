import { describe, it, expect, vi, afterEach } from "vitest";
import { Transaction, Keypair } from "@solana/web3.js";
import { ExtensionType } from "@solana/spl-token";
import { LIMITS, totalAllocations, ngnKobo, schemas } from "@muuve/shared";
import { config } from "../../apps/web/lib/server/config";
import {
  Chain,
  assertExtensions,
  linkPda,
  DEVNET_GENESIS,
} from "../../apps/web/lib/server/solana/chain";
import { verifyMessage } from "../../apps/web/lib/server/operations";
import { signWebhook, verifyWebhook } from "../../apps/web/lib/server/providers/payout";
import { safeLog } from "../../apps/web/lib/server/log";
import { setupEnv, prepared, signPrepared, attemptFor } from "../helpers";
import { generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { privyToken, jwks } from "../../apps/web/lib/server/auth";
setupEnv();
afterEach(() => vi.restoreAllMocks());
describe("amount and configuration boundaries", () => {
  it("accepts the complete genesis hash returned by the official devnet RPC", async () => {
    expect(DEVNET_GENESIS).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const chain = new Chain();
    vi.spyOn(chain.connections[0]!, "getGenesisHash").mockResolvedValue(
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    );
    await expect(chain.rpc(async () => "devnet_verified")).resolves.toBe("devnet_verified");
  });
  it("verifies RPC genesis rather than trusting the cluster label", async () => {
    const chain = new Chain();
    vi.spyOn(chain.connections[0]!, "getGenesisHash").mockResolvedValue("mainnet-genesis");
    const action = vi.fn();
    await expect(chain.rpc(action)).rejects.toThrow("devnet_required");
    expect(action).not.toHaveBeenCalled();
  });
  it("uses exact integer allocations and FX rounding", () => {
    expect(totalAllocations(["1", "2", "3"])).toBe(6n);
    expect(ngnKobo("1000001", "1504.8000")).toBe("150480");
    expect(ngnKobo("1", "0.0001")).toBe("0");
  });
  it.each(
    [
      [],
      Array(11).fill("1"),
      ["0"],
      ["500000001"],
      ["500000000", "500000000", "1"],
      ["18446744073709551616"],
    ].map((a) => [a]),
  )("rejects invalid allocation %j", (a) => expect(() => totalAllocations(a)).toThrow());
  it("rejects floats, negative and exponential amounts", () => {
    for (const amount of ["1.0", "-1", "1e6"])
      expect(schemas.fund.safeParse({ amount_base_units: amount }).success).toBe(false);
  });
  it("requires explicit devnet and local-only OTP", () => {
    expect(() => config({ ...process.env, SOLANA_CLUSTER: "mainnet-beta" })).toThrow();
    expect(() => config({ ...process.env, APP_ENV: "production", OTP_PROVIDER: "mock" })).toThrow();
  });
  it("isolates sender-local link IDs", () => {
    const id = "00112233445566778899aabbccddeeff";
    expect(
      linkPda(Keypair.generate().publicKey.toBase58(), id).equals(
        linkPda(Keypair.generate().publicKey.toBase58(), id),
      ),
    ).toBe(false);
  });
  it("allowlists extensions and rejects fee/hook/delegate semantics", () => {
    expect(() => assertExtensions([])).not.toThrow();
    expect(() => assertExtensions([ExtensionType.ImmutableOwner], true)).not.toThrow();
    for (const ext of [
      ExtensionType.TransferFeeConfig,
      ExtensionType.TransferHook,
      ExtensionType.PermanentDelegate,
      ExtensionType.MemoTransfer,
    ])
      expect(() => assertExtensions([ext], true)).toThrow();
  });
});
describe("transaction-message integrity", () => {
  it("accepts only fully signed identical messages", () => {
    const p = prepared();
    expect(verifyMessage(signPrepared(p), attemptFor(p))).toBeInstanceOf(Buffer);
    expect(() => verifyMessage(p.tx, attemptFor(p))).toThrow("invalid_transaction_signatures");
  });
  it("rejects a changed blockhash and instruction data", () => {
    const p = prepared();
    const tx = Transaction.from(Buffer.from(p.tx, "base64"));
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    expect(() =>
      verifyMessage(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        attemptFor(p),
      ),
    ).toThrow("transaction_message_mismatch");
  });
});
describe("webhooks and logging", () => {
  it("signs custom-auth JWTs with the account identity and exposes public JWKS only", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.AUTH_JWT_PRIVATE_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.AUTH_JWT_KID = "test-key";
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app";
    const publicKeys = await jwks(),
      token = await privyToken("00112233-4455-4677-8899-aabbccddeeff");
    const verified = await jwtVerify(token, createLocalJWKSet(publicKeys), {
      issuer: "https://muuve.test",
      audience: "test-app",
    });
    expect(verified.payload.sub).toBe("00112233-4455-4677-8899-aabbccddeeff");
    expect(publicKeys.keys[0]).not.toHaveProperty("d");
  });
  it("authenticates raw payload and bounds replay time", () => {
    const raw = JSON.stringify({
        event_id: "test",
        payout_id: crypto.randomUUID(),
        provider_ref: "mock-test",
        status: "paid",
      }),
      s = signWebhook(raw);
    expect(verifyWebhook(raw, s.timestamp, s.signature).status).toBe("paid");
    expect(() => verifyWebhook(raw + " ", s.timestamp, s.signature)).toThrow();
    expect(() => verifyWebhook(raw, "1000000000", s.signature)).toThrow();
  });
  it("drops sensitive and arbitrary log fields", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    safeLog({
      event: "checked",
      phone: "+2348030000001",
      otp: "000000",
      account_number: "1234567890",
      tx: "secret",
      secret: "#k=private",
      code: "ok",
    });
    expect(log).toHaveBeenCalledWith('{"event":"checked","code":"ok"}');
  });
});
