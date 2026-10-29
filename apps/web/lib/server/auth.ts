import { randomUUID, createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT, jwtVerify, exportJWK, importPKCS8 } from "jose";
import type { PoolClient } from "pg";
import { one } from "./db";
import { assert, AppError } from "./errors";
export type Session = {
  id: string;
  purpose: "account" | "claim" | "proof";
  user_id: string | null;
  phone_e164: string;
  link_id: string | null;
  expires_at: Date;
};
const names = { account: "muuve_session", claim: "muuve_claim", proof: "muuve_phone_proof" };
function secret() {
  const s = process.env.SESSION_SECRET;
  assert(s && s.length >= 32, "session_not_configured", 503);
  return new TextEncoder().encode(s);
}
export function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export async function issue(
  c: PoolClient,
  purpose: Session["purpose"],
  phone: string,
  user: string | null,
  link: string | null,
): Promise<string> {
  const id = randomUUID(),
    seconds = { account: 2592000, claim: 1200, proof: 900 }[purpose];
  await c.query(
    "INSERT INTO sessions(id,purpose,phone_e164,user_id,link_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second')",
    [id, purpose, phone, user, link, seconds],
  );
  const token = await new SignJWT({ sid: id, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("muuve")
    .setAudience(`muuve:${purpose}`)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secret());
  return cookie(names[purpose], token, seconds);
}
export async function session(req: Request, purpose: Session["purpose"]): Promise<Session> {
  const cookies = new Map(
    (req.headers.get("cookie") ?? "").split(";").map((x) => {
      const i = x.indexOf("=");
      return [x.slice(0, i).trim(), x.slice(i + 1)];
    }),
  );
  const token = cookies.get(names[purpose]);
  assert(token, "unauthorized", 401);
  let id: unknown;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      issuer: "muuve",
      audience: `muuve:${purpose}`,
    });
    assert(payload.purpose === purpose, "unauthorized", 401);
    id = payload.sid;
  } catch {
    throw new AppError("unauthorized", 401);
  }
  assert(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id), "unauthorized", 401);
  const result = await one<Session>(
    "SELECT * FROM sessions WHERE id=$1 AND purpose=$2 AND expires_at>now() AND revoked_at IS NULL AND consumed_at IS NULL",
    [id, purpose],
  );
  assert(result, "unauthorized", 401);
  return result;
}
export async function accountOrClaim(req: Request) {
  try {
    return await session(req, "account");
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 401) throw error;
    return session(req, "claim");
  }
}
export function checkOrigin(req: Request) {
  if (["GET", "HEAD"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  assert(origin && origin === process.env.APP_BASE_URL, "invalid_origin", 403);
}
export async function privyToken(user: string) {
  const pem = process.env.AUTH_JWT_PRIVATE_KEY,
    kid = process.env.AUTH_JWT_KID,
    app = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  assert(pem && kid && app, "privy_not_configured", 503);
  return new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(user)
    .setIssuer(process.env.APP_BASE_URL!)
    .setAudience(app)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importPKCS8(pem, "ES256"));
}
export async function jwks() {
  const pem = process.env.AUTH_JWT_PRIVATE_KEY,
    kid = process.env.AUTH_JWT_KID;
  assert(pem && kid, "privy_not_configured", 503);
  return {
    keys: [
      {
        ...(await exportJWK(createPublicKey(createPrivateKey(pem)))),
        kid,
        alg: "ES256",
        use: "sig",
      },
    ],
  };
}
export const clearCookies = () => Object.values(names).map((n) => cookie(n, "", 0));
