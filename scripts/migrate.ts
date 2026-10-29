import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { database, closeDatabase } from "../apps/web/lib/server/db";
export async function migrate() {
  if (process.env.MUUVE_ALLOW_MIGRATIONS !== "1")
    throw new Error("Set MUUVE_ALLOW_MIGRATIONS=1 only for an approved database");
  const ref = process.env.MUUVE_DATABASE_PROJECT_REF;
  if (ref) {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!(
      url.hostname === `db.${ref}.supabase.co` ||
      (url.hostname.endsWith(".pooler.supabase.com") &&
        decodeURIComponent(url.username).endsWith(`.${ref}`))
    ))
      throw new Error("Database project mismatch");
    if (url.hostname.endsWith(".pooler.supabase.com") && url.port !== "5432")
      throw new Error("Migrations require the session pooler, port 5432");
    if (url.searchParams.get("sslmode") !== "verify-full")
      throw new Error("Hosted database requires certificate-verified TLS");
  }
  const c = await database().connect();
  try {
    await c.query("SELECT pg_advisory_lock(72811699)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS public.muuve_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const root = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(file, root), "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex");
      const previous = (
        await c.query("SELECT checksum FROM public.muuve_migrations WHERE name=$1", [file])
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error("Applied migration checksum changed");
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""));
        await c.query("INSERT INTO public.muuve_migrations(name,checksum) VALUES($1,$2)", [
          file,
          checksum,
        ]);
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
      console.info(`Applied ${file}`);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(72811699)");
    c.release();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  try {
    await migrate();
  } catch {
    console.error(
      "Database migration failed; check approved configuration and migration checksums without logging credentials.",
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
