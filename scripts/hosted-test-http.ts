import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

/** Operator test transport: verified HTTPS, IPv4, no automatic retries or redirects.
 * Headers/body never appear in process arguments or logs. This is not browser evidence.
 */
export async function hostedTestFetch(url: string, init: RequestInit = {}) {
  const target = new URL(url);
  if (
    target.origin !== "https://muuve.onrender.com" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("unexpected_hosted_test_url");
  if (init.body !== undefined && typeof init.body !== "string")
    throw new Error("string_test_body_required");
  const directory = await mkdtemp("keys/http-test-");
  const requestHeaders = `${directory}/request-headers`,
    responseHeaders = `${directory}/response-headers`,
    responseBody = `${directory}/response-body`;
  try {
    const headerLines: string[] = [];
    new Headers(init.headers).forEach((value, name) => headerLines.push(`${name}: ${value}`));
    const headers = headerLines.join("\r\n") + "\r\n";
    for (const [path, value] of [
      [requestHeaders, headers],
      [responseHeaders, ""],
      [responseBody, ""],
    ])
      await writeFile(path!, value!, { mode: 0o600, flag: "wx" });
    const child = spawn(
      "curl",
      [
        "--disable",
        "--ipv4",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--connect-timeout",
        "10",
        "--max-time",
        "45",
        "--request",
        init.method ?? "GET",
        "--header",
        `@${requestHeaders}`,
        "--dump-header",
        responseHeaders,
        "--output",
        responseBody,
        "--write-out",
        "%{http_code}",
        ...(init.body === undefined ? [] : ["--data-binary", "@-"]),
        url,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let status = "";
    child.stdout.on("data", (data: Buffer) => {
      status += data.toString();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(init.body);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new Error("curl_transport_spawn_failed")));
      child.once("exit", resolve);
    });
    if (exit !== 0) throw new Error(`curl_transport_exit_${exit}`);
    if (!/^\d{3}$/.test(status)) throw new Error("curl_status_missing");
    const blocks = (await readFile(responseHeaders, "utf8"))
      .split(/\r?\n\r?\n/)
      .filter((block) => block.startsWith("HTTP/"));
    const last = blocks.at(-1);
    if (!last) throw new Error("curl_response_headers_missing");
    const returned = new Headers();
    for (const line of last.split(/\r?\n/).slice(1)) {
      const index = line.indexOf(":");
      if (index > 0) returned.append(line.slice(0, index), line.slice(index + 1).trim());
    }
    return new Response(await readFile(responseBody, "utf8"), {
      status: Number(status),
      headers: returned,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
