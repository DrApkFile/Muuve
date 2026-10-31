import { NextResponse, type NextRequest } from "next/server";

// Dev only: wallets reject a sign-in message whose domain differs from the page's, so keep
// local dev on the one address the API signs for (APP_BASE_URL, e.g. 127.0.0.1:3000) and
// send localhost:3000 there.
export function proxy(request: NextRequest) {
  const base = process.env.APP_BASE_URL;
  if (process.env.NODE_ENV !== "development" || !base) return;
  const canonical = new URL(base);
  if (request.headers.get("host") === canonical.host) return;
  // Not a 3xx: Next rewrites redirect Locations it considers same-origin into relative
  // paths, and it treats localhost and 127.0.0.1 as the same server, which would loop.
  const target = JSON.stringify(
    new URL(request.nextUrl.pathname + request.nextUrl.search, canonical.origin).toString(),
  );
  return new NextResponse(`<!doctype html><script>location.replace(${target})</script>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
