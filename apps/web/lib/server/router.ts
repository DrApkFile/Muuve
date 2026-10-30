import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { schemas, uuid, ngnKobo } from "@muuve/shared";
import { AppError, assert } from "./errors";
import { transaction, one, audit } from "./db";
import {
  session,
  accountOrClaim,
  checkOrigin,
  issue,
  clearCookies,
  privyToken,
  jwks,
} from "./auth";
import { sendOtp, verifyOtp, publicUser } from "./otp";
import { userFor, createLink, listLinks, senderLink, linkView, preview, recall } from "./links";
import { share, startIntent, keep, assertCanAttestClaim } from "./claims";
import { quote, preparePayout, payoutView, retryPayout, receiveWebhook } from "./payouts";
import { mockRateProvider, mockBankDirectory, mockClevaGateway } from "./providers/finance";
import { verifyWallet } from "./providers/privy";
import { walletChallenge, walletLogin } from "./wallet-auth";
import { submitOperation, canAccessOperation, storedOperation } from "./operations";
import { fund } from "./funding";
import { Chain } from "./solana/chain";
import { expireLinks, failedPayouts, reconcileAll, runJobs } from "./jobs";
import { safeLog } from "./log";
import { monitor } from "./monitor";

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  assert(Number(req.headers.get("content-length") ?? 0) <= 16384, "body_too_large", 413);
  const text = await req.text();
  assert(Buffer.byteLength(text) <= 16384, "body_too_large", 413);
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new AppError("invalid_body");
  }
}
function response(data: unknown, status = 200, cookies: string[] = []) {
  const h = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const cookie of cookies) h.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers: h });
}
function cronAuthorized(req: Request) {
  const expected = process.env.CRON_SECRET,
    actual = req.headers.get("authorization")?.replace(/^Bearer /, "");
  assert(
    expected &&
      expected.length >= 32 &&
      actual &&
      actual.length === expected.length &&
      timingSafeEqual(Buffer.from(actual), Buffer.from(expected)),
    "unauthorized",
    401,
  );
}
async function publicLimit(req: Request) {
  const ip =
    process.env.TRUSTED_PROXY === "true"
      ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local")
      : "local";
  // Reuse an atomic advisory-lock-protected database bucket without logging the address.
  const { hash } = await import("./solana/codec");
  const bucket = hash(`preview:${ip}:${Math.floor(Date.now() / 60000)}`).toString("hex");
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [bucket]);
    const row = await one(
      "SELECT count(*) AS n FROM events WHERE entity_type='rate_limit' AND type=$1 AND created_at>now()-interval '1 minute'",
      [bucket],
      c,
    );
    assert(Number(row!.n) < 60, "rate_limited", 429);
    await audit(c, "rate_limit", randomUUID(), bucket);
  });
}
export async function handle(req: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const path = new URL(req.url).pathname.replace(/\/$/, ""),
      method = req.method;
    if (path === "/api/webhooks/payout" && method === "POST") {
      const raw = await req.text();
      assert(Buffer.byteLength(raw) <= 16384, "body_too_large", 413);
      return response(
        await receiveWebhook(
          raw,
          req.headers.get("x-muuve-timestamp"),
          req.headers.get("x-muuve-signature"),
        ),
      );
    }
    if (path.startsWith("/api/cron/")) {
      assert(method === "POST", "method_not_allowed", 405);
      cronAuthorized(req);
      if (path.endsWith("/expire")) return response(await expireLinks());
      if (path.endsWith("/failed-payouts")) return response(await failedPayouts());
      if (path.endsWith("/reconcile")) return response(await reconcileAll());
      if (path.endsWith("/work")) return response(await runJobs());
      if (path.endsWith("/monitor")) return response(await monitor());
      throw new AppError("not_found", 404);
    }
    checkOrigin(req);
    if (path === "/api/health" && method === "GET")
      return response({ service: "muuve-backend", chain: "devnet", payouts: "mock" });
    if (path === "/api/auth/wallet/challenge" && method === "POST") {
      const result = await walletChallenge(req, await body(req, schemas.walletChallenge));
      return response(result.body, 200, [result.cookie]);
    }
    if (path === "/api/auth/wallet/login" && method === "POST") {
      const result = await walletLogin(req, await body(req, schemas.walletLogin));
      return response({ user: result.user }, 200, result.cookies);
    }
    if (path === "/api/auth/otp/send" && method === "POST")
      return response(await sendOtp(req, await body(req, schemas.otpSend)));
    if (path === "/api/auth/otp/verify" && method === "POST") {
      const result = await verifyOtp(await body(req, schemas.otpVerify));
      return response(result.body, 200, result.cookies);
    }
    if (path === "/api/auth/signup" && method === "POST") {
      const input = await body(req, schemas.signup);
      let proof;
      try {
        proof = await session(req, "proof");
      } catch {
        proof = await session(req, "claim");
      }
      const result = await transaction(async (c) => {
        const locked = await one(
          "SELECT * FROM sessions WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
          [proof.id],
          c,
        );
        assert(locked, "unauthorized", 401);
        const user = await one(
          `INSERT INTO users(phone_e164,display_name,auth_origin) VALUES($1,$2,$3) ON CONFLICT(phone_e164) DO UPDATE SET phone_e164=EXCLUDED.phone_e164 RETURNING *`,
          [proof.phone_e164, input.display_name, input.origin],
          c,
        );
        if (proof.purpose === "proof")
          await c.query("UPDATE sessions SET consumed_at=now() WHERE id=$1", [proof.id]);
        else await c.query("UPDATE sessions SET user_id=$2 WHERE id=$1", [proof.id, user!.id]);
        await c.query(
          "UPDATE principals SET user_id=$2 WHERE owner_phone=$1 AND source='escrow_claim' AND user_id IS NULL",
          [proof.phone_e164, user!.id],
        );
        await audit(c, "user", user!.id, "user.account_verified");
        return {
          user: publicUser(user!),
          cookie: await issue(c, "account", proof.phone_e164, user!.id, null),
        };
      });
      return response({ user: result.user }, 200, [result.cookie]);
    }
    if (path === "/api/auth/refresh" && method === "POST") {
      const actor = await session(req, "account");
      const renewed = await transaction(async (c) => {
        await c.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [actor.id]);
        await c.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [actor.id]);
        return issue(c, "account", actor.phone_e164, actor.user_id, null);
      });
      return response({ refreshed: true }, 200, [renewed]);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      for (const purpose of ["account", "claim", "proof"] as const) {
        try {
          const s = await session(req, purpose);
          await transaction((c) =>
            c.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [s.id]),
          );
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 401) throw error;
        }
      }
      return response({ logged_out: true }, 200, clearCookies());
    }
    if (path === "/api/auth/jwks" && method === "GET") return response(await jwks());
    if (path === "/api/auth/privy-token" && method === "GET") {
      const s = await session(req, "account");
      return response({ token: await privyToken(s.user_id!) });
    }
    if (path === "/api/auth/wallet" && method === "POST") {
      const s = await session(req, "account"),
        input = await body(req, schemas.wallet),
        privy = await verifyWallet(s.user_id!, input.wallet_address);
      await transaction(async (c) => {
        const user = await one("SELECT * FROM users WHERE id=$1 FOR UPDATE", [s.user_id], c);
        assert(
          !user?.wallet_address || user.wallet_address === input.wallet_address,
          "wallet_already_linked",
          409,
        );
        await c.query("UPDATE users SET wallet_address=$2,privy_user_id=$3 WHERE id=$1", [
          s.user_id,
          input.wallet_address,
          privy,
        ]);
        await audit(c, "user", s.user_id!, "user.wallet_linked");
      });
      return response({ linked: true });
    }
    if (path === "/api/me" && method === "GET")
      return response({ user: publicUser(await userFor(await session(req, "account"))) });
    if (path === "/api/balance" && method === "GET") {
      const u = await userFor(await session(req, "account"));
      assert(u.wallet_address, "wallet_required", 409);
      const fx = await mockRateProvider.getRate();
      const amount =
        u.auth_origin === "cleva_preview"
          ? await mockClevaGateway.getLinkedBalance(u.id)
          : await new Chain().balance(u.wallet_address);
      return response({
        amount_base_units: amount,
        estimated_ngn_kobo: amount === "0" ? "0" : ngnKobo(amount, fx.ngnPerUsd),
        rate_ngn_per_usd: fx.ngnPerUsd,
        mock_rate: true,
      });
    }
    if (["/api/fund/demo", "/api/fund/cleva-preview"].includes(path) && method === "POST") {
      const s = await session(req, "account"),
        input = await body(req, schemas.fund),
        key = req.headers.get("idempotency-key");
      assert(key && key.length >= 8 && key.length <= 128, "idempotency_key_required");
      return response(await fund(s, input.amount_base_units, key, path.endsWith("cleva-preview")));
    }
    if (path === "/api/links" && method === "GET")
      return response({ links: await listLinks(await session(req, "account")) });
    if (path === "/api/links/prepare" && method === "POST")
      return response(
        await createLink(await session(req, "account"), await body(req, schemas.create)),
      );
    if (path === "/api/links/submit" && method === "POST")
      return response(
        await submitOperation(await session(req, "account"), await body(req, schemas.submit), {
          kind: "create",
        }),
      );
    let match = path.match(/^\/api\/operations\/([^/]+)$/);
    if (match && method === "GET") {
      const actor = await accountOrClaim(req),
        id = uuid.parse(match[1]);
      return await transaction(async (c) => {
        const op = await one("SELECT * FROM operations WHERE id=$1", [id], c);
        assert(op && (await canAccessOperation(c, op, actor)), "not_found", 404);
        return response({ ...(await storedOperation(c, id)), state: op.state });
      });
    }
    match = path.match(/^\/api\/public\/links\/([^/]+)$/);
    if (match && method === "GET") {
      await publicLimit(req);
      return response(await preview(uuid.parse(match[1])));
    }
    match = path.match(/^\/api\/links\/([^/]+)(?:\/(recall)\/(prepare|submit))?$/);
    if (match) {
      const id = uuid.parse(match[1]),
        s = await session(req, "account");
      await senderLink(s, id);
      if (!match[2] && method === "GET") return response({ link: await linkView(id) });
      if (match[3] === "prepare" && method === "POST")
        return response(await recall(s, id, (await body(req, schemas.recall)).slot_index));
      if (match[3] === "submit" && method === "POST")
        return response(
          await submitOperation(s, await body(req, schemas.submit), { kind: "recall", linkId: id }),
        );
    }
    match = path.match(
      /^\/api\/claims\/([^/]+)\/(share|intent\/(?:prepare|submit)|keep\/(?:prepare|submit)|cashout\/(?:quote|prepare|submit|retry))$/,
    );
    if (match) {
      const id = uuid.parse(match[1]),
        action = match[2]!,
        s = await session(req, "claim");
      await assertCanAttestClaim(s, id, { allowTerminal: true });
      if (action === "share" && method === "GET") return response(await share(s, id));
      assert(method === "POST", "method_not_allowed", 405);
      if (action === "intent/prepare") {
        const input = await body(req, schemas.intent);
        return response(
          await startIntent(
            s,
            id,
            input.path,
            input.path === "keep" ? await session(req, "account") : undefined,
          ),
        );
      }
      if (action === "intent/submit")
        return response(
          await submitOperation(s, await body(req, schemas.submit), { kind: "intent", linkId: id }),
        );
      if (action === "keep/prepare")
        return response(await keep(s, await session(req, "account"), id));
      if (action === "keep/submit")
        return response(
          await submitOperation(s, await body(req, schemas.submit), {
            kind: "claim_keep",
            linkId: id,
          }),
        );
      if (action === "cashout/quote")
        return response(await quote(s, await body(req, schemas.quote), id));
      if (action === "cashout/prepare")
        return response(await preparePayout(s, await body(req, schemas.cashout), id));
      if (action === "cashout/submit")
        return response(
          await submitOperation(s, await body(req, schemas.submit), {
            kind: "claim_cashout",
            linkId: id,
          }),
        );
      if (action === "cashout/retry")
        return response(await retryPayout(s, id, await body(req, schemas.cashout)));
    }
    if (path === "/api/banks" && method === "GET") {
      await accountOrClaim(req);
      return response({ banks: await mockBankDirectory.listBanks(), mock: true });
    }
    if (path === "/api/banks/resolve" && method === "POST") {
      await accountOrClaim(req);
      const input = await body(req, schemas.bank);
      return response({
        account_name: (
          await mockBankDirectory.resolveAccount(input.bank_code, input.account_number)
        ).accountName,
        mock: true,
      });
    }
    if (path === "/api/payouts/quote" && method === "POST")
      return response(await quote(await session(req, "account"), await body(req, schemas.quote)));
    if (path === "/api/payouts/prepare" && method === "POST")
      return response(
        await preparePayout(await session(req, "account"), await body(req, schemas.cashout)),
      );
    if (path === "/api/payouts/submit" && method === "POST")
      return response(
        await submitOperation(await session(req, "account"), await body(req, schemas.submit), {
          kind: "wallet_payout",
        }),
      );
    match = path.match(/^\/api\/payouts\/([^/]+)$/);
    if (match && method === "GET")
      return response({
        payout: await payoutView(await accountOrClaim(req), uuid.parse(match[1])),
      });
    throw new AppError("not_found", 404);
  } catch (error) {
    const status =
      error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
    const code =
      error instanceof AppError
        ? error.code
        : status === 400
          ? "invalid_request"
          : "internal_error";
    safeLog({ event: "request.failed", request_id: requestId, code });
    return response({ error: code, request_id: requestId }, status);
  }
}
