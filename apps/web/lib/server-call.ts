"use server";

import { cookies, headers } from "next/headers";
import { handle } from "./server/router";

// Every browser request to the backend goes through this server action. It runs the API
// handler in-process on the server, so the browser never calls /api/* itself. Session
// cookies stay httpOnly: we read them from the incoming request and write back whatever
// the handler sets.

export type CallResult =
  { ok: true; data: unknown } | { ok: false; error: string; status: number; request_id?: string };

const FORWARDED = ["cookie", "user-agent", "x-forwarded-for", "x-real-ip"];
const ALLOWED_HEADERS = new Set(["idempotency-key"]);

// Where the API runs. With no backend config (a bare local checkout) dev calls go to the
// hosted devnet API instead; MUUVE_API_URL overrides both.
function remoteApi() {
  if (process.env.MUUVE_API_URL) return process.env.MUUVE_API_URL;
  if (!process.env.APP_BASE_URL && process.env.NODE_ENV === "development")
    return "https://muuve.onrender.com";
  return null;
}

function applySetCookie(
  jar: Awaited<ReturnType<typeof cookies>>,
  line: string,
  allowSecure: boolean,
) {
  const [pair = "", ...attrs] = line.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  if (eq < 1) return;
  const options: Parameters<typeof jar.set>[2] = {};
  for (const attr of attrs) {
    const [key = "", value = ""] = attr.split("=");
    const name = key.toLowerCase();
    if (name === "httponly") options.httpOnly = true;
    else if (name === "secure") options.secure = allowSecure;
    else if (name === "path") options.path = value;
    else if (name === "max-age") options.maxAge = Number(value);
    else if (name === "samesite")
      options.sameSite = value.toLowerCase() as "lax" | "strict" | "none";
  }
  jar.set(pair.slice(0, eq), pair.slice(eq + 1), options);
}

export async function serverCall(
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<CallResult> {
  // Only the public app API; cron and webhook routes need their own secrets.
  if (
    typeof path !== "string" ||
    !path.startsWith("/api/") ||
    path.startsWith("/api/cron/") ||
    path.startsWith("/api/webhooks/") ||
    path.includes("..")
  )
    return { ok: false, error: "not_found", status: 404 };

  const incoming = await headers();
  const forward = new Headers();
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) forward.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders))
    if (ALLOWED_HEADERS.has(name.toLowerCase())) forward.set(name, value);
  if (body !== undefined) forward.set("content-type", "application/json");

  // Next.js already rejects server actions whose Origin doesn't match the host serving the
  // page, so the cross-site check has happened by now.
  // In-process: the API sees the address it is configured for (keeps localhost working).
  // Remote API (e.g. pages on Vercel, API on Render): pass the page's real origin. The API
  // must have APP_BASE_URL set to this site, because wallets only sign a login message
  // whose domain matches the page they're on.
  const remote = remoteApi();
  const base =
    remote ?? process.env.APP_BASE_URL ?? `http://${incoming.get("host") ?? "localhost"}`;
  forward.set("origin", (remote && incoming.get("origin")) || new URL(base).origin);
  const request = new Request(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: forward,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res: Response;
  try {
    res = remote
      ? await fetch(request, { cache: "no-store", signal: AbortSignal.timeout(30000) })
      : await handle(request);
  } catch {
    return { ok: false, error: "network_error", status: 0 };
  }

  // Browsers drop Secure cookies on plain-http dev hosts; keep the flag only over https.
  const https =
    (incoming.get("x-forwarded-proto") ?? "").includes("https") ||
    (incoming.get("origin") ?? "").startsWith("https://");
  const jar = await cookies();
  for (const line of res.headers.getSetCookie()) applySetCookie(jar, line, https);

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    return {
      ok: false,
      error: typeof json.error === "string" ? json.error : "unknown_error",
      status: res.status,
      request_id: typeof json.request_id === "string" ? json.request_id : undefined,
    };
  return { ok: true, data: json };
}
