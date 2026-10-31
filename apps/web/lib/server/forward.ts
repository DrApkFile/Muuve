// Serves /api/* for the browser. The API runs in-process, or, when the pages are deployed
// apart from it (pages on Vercel, API on Render), the request is forwarded server-side, so
// the browser only ever talks to the site it is on. A plain route rather than a server
// action: Next runs server actions one at a time, so background polling would queue in
// front of whatever the person just tapped.
import { handle } from "./router";

const FORWARDED = [
  "cookie",
  "user-agent",
  "x-forwarded-for",
  "x-real-ip",
  "content-type",
  "idempotency-key",
  // The API checks this against APP_BASE_URL, which must be this site's address: wallets
  // only sign a login message whose domain matches the page they're on.
  "origin",
];

// With no backend config (a bare local checkout) dev calls go to the hosted devnet API;
// MUUVE_API_URL overrides both.
function remoteApi() {
  if (process.env.MUUVE_API_URL) return process.env.MUUVE_API_URL;
  if (!process.env.APP_BASE_URL && process.env.NODE_ENV === "development")
    return "https://muuve.onrender.com";
  return null;
}

async function forward(request: Request, remote: string) {
  const url = new URL(request.url);
  // Cron and webhook routes need their own secrets and are only served by the API itself.
  if (url.pathname.startsWith("/api/cron/") || url.pathname.startsWith("/api/webhooks/"))
    return Response.json({ error: "not_found" }, { status: 404 });
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    return await fetch(new URL(url.pathname + url.search, remote), {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return Response.json({ error: "network_error" }, { status: 502 });
  }
}

export async function serve(request: Request) {
  const remote = remoteApi();
  const res = remote ? await forward(request, remote) : await handle(request);
  // Browsers drop Secure cookies on plain-http dev hosts; keep the flag only over https.
  const https =
    new URL(request.url).protocol === "https:" ||
    (request.headers.get("x-forwarded-proto") ?? "").includes("https");
  if (!remote && https) return res;
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "x-request-id", "retry-after"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const line of res.headers.getSetCookie())
    headers.append("set-cookie", https ? line : line.replace(/;\s*secure/gi, ""));
  return new Response(res.body, { status: res.status, headers });
}
