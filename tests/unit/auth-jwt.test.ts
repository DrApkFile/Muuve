import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { privyToken, jwks, verifyCustomAuthToken } from "../../apps/web/lib/server/auth";
import { setupEnv } from "../helpers";
const original = { ...process.env };
let pem: string;
beforeEach(() => {
  setupEnv();
  delete process.env.AUTH_JWT_PRIVATE_KEY_FILE;
  pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.AUTH_JWT_PRIVATE_KEY = pem;
  process.env.AUTH_JWT_KID = "jwt-test";
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app";
});
afterEach(() => {
  process.env = { ...original };
});
describe("custom authentication token validation", () => {
  it("verifies UUID subject, issuer, audience, ES256, expiry and the published key ID", async () => {
    const id = randomUUID(),
      result = await verifyCustomAuthToken(await privyToken(id));
    expect(result.sub).toBe(id);
    expect(result.exp! - result.iat!).toBe(300);
    const publicKeys = await jwks();
    expect(publicKeys.keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      kid: "jwt-test",
      alg: "ES256",
    });
    expect(publicKeys.keys[0]).not.toHaveProperty("d");
  });
  it.each([
    "signature",
    "expired",
    "audience",
    "issuer",
    "subject",
    "kid",
    "missing_iat",
    "long_lifetime",
  ])("rejects %s", async (scenario) => {
    const now = Math.floor(Date.now() / 1000);
    const token = new SignJWT({
      sub: scenario === "subject" ? "not-a-user-uuid" : randomUUID(),
      iss: scenario === "issuer" ? "https://other.test" : "https://muuve.test",
      aud: scenario === "audience" ? "other-app" : "test-app",
      ...(scenario === "missing_iat" ? {} : { iat: scenario === "expired" ? now - 600 : now }),
      exp: scenario === "expired" ? now - 300 : now + (scenario === "long_lifetime" ? 301 : 300),
    }).setProtectedHeader({ alg: "ES256", kid: scenario === "kid" ? "wrong-key" : "jwt-test" });
    const key =
      scenario === "signature"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString()
        : pem;
    await expect(
      verifyCustomAuthToken(await token.sign(await importPKCS8(key, "ES256"))),
    ).rejects.toThrow();
  });
  it("rejects a symmetric signing algorithm", async () => {
    const token = await new SignJWT({ sub: randomUUID() })
      .setProtectedHeader({ alg: "HS256", kid: "jwt-test" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new Uint8Array(32));
    await expect(verifyCustomAuthToken(token)).rejects.toThrow();
  });
  it("refuses malformed subjects and noncanonical issuers before signing", async () => {
    await expect(privyToken("arbitrary-user")).rejects.toThrow("invalid_auth_subject");
    process.env.APP_BASE_URL = "https://muuve.test/";
    await expect(privyToken(randomUUID())).rejects.toThrow("invalid_auth_issuer");
  });
});
