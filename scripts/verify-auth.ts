import { randomUUID } from "node:crypto";
import { handle } from "../apps/web/lib/server/router";
import { privyToken, verifyCustomAuthToken } from "../apps/web/lib/server/auth";
import { createLocalJWKSet, jwtVerify } from "jose";
try {
  const id = randomUUID(),
    token = await privyToken(id);
  const response = await handle(new Request(`${process.env.APP_BASE_URL}/api/auth/jwks`));
  if (!response.ok) throw new Error("JWKS endpoint failed");
  const keys = await response.json();
  if (keys.keys.some((key: object) => "d" in key)) throw new Error("Private key in JWKS");
  const verified = await jwtVerify(token, createLocalJWKSet(keys), {
    algorithms: ["ES256"],
    issuer: process.env.APP_BASE_URL,
    audience: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  });
  if (verified.payload.sub !== id || (await verifyCustomAuthToken(token)).sub !== id)
    throw new Error("Subject mismatch");
  console.info(
    JSON.stringify({
      state: "passed",
      checks: [
        "ES256 signing",
        "public JWKS endpoint",
        "issuer",
        "audience",
        "subject",
        "kid",
        "expiry",
        "key correspondence",
      ],
    }),
  );
} catch {
  console.error(
    "Authentication signing verification failed; check local key and public configuration. No token or secret logged.",
  );
  process.exitCode = 1;
}
