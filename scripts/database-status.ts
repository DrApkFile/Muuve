import { database, closeDatabase } from "../apps/web/lib/server/db";
import { readdir, readFile } from "node:fs/promises";
try {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const ref = process.env.MUUVE_DATABASE_PROJECT_REF;
  if (
    ref &&
    !(
      url.hostname === `db.${ref}.supabase.co` ||
      (url.hostname.endsWith(".pooler.supabase.com") &&
        decodeURIComponent(url.username).endsWith(`.${ref}`))
    )
  )
    throw new Error("database_project_mismatch");
  const db = database();
  const identity = (await db.query("SELECT current_database() AS database,current_user AS role"))
    .rows[0];
  const tables = (
    await db.query(
      "SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='muuve' ORDER BY tablename",
    )
  ).rows;
  const expected = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter((x) => x.endsWith(".sql"))
    .sort();
  const expectedTables = (
    await Promise.all(
      expected.map((file) =>
        readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).flatMap((sql) =>
    [...sql.matchAll(/CREATE TABLE\s+(?:muuve\.)?(\w+)\s*\(/gi)].map((match) => match[1]),
  );
  const migrated = (
    await db.query("SELECT name FROM public.muuve_migrations ORDER BY name")
  ).rows.map((x) => x.name);
  const constraints = Number(
    (
      await db.query(
        "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='muuve'",
      )
    ).rows[0].count,
  );
  const indexes = Number(
    (await db.query("SELECT count(*) FROM pg_indexes WHERE schemaname='muuve'")).rows[0].count,
  );
  const permissions = (
    await db.query(`SELECT NOT EXISTS(SELECT 1 FROM pg_namespace n,aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='muuve' AND a.grantee=0 AND a.privilege_type='USAGE') AS public_schema_blocked,
    NOT EXISTS(SELECT 1 FROM information_schema.table_privileges WHERE table_schema='muuve' AND grantee='PUBLIC') AS public_tables_blocked`)
  ).rows[0];
  const passed =
    JSON.stringify(expected) === JSON.stringify(migrated) &&
    expectedTables.every((name) => tables.some((table) => table.tablename === name)) &&
    tables.every((x) => x.rowsecurity) &&
    constraints > 0 &&
    indexes > 0 &&
    permissions.public_schema_blocked &&
    permissions.public_tables_blocked;
  console.info(
    JSON.stringify({
      state: passed ? "passed" : "incomplete",
      ...identity,
      migrations: migrated,
      tables: tables.map((x) => x.tablename),
      all_tables_rls: tables.every((x) => x.rowsecurity),
      constraints,
      indexes,
      permissions,
    }),
  );
  if (!passed) process.exitCode = 1;
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    JSON.stringify({
      state: "blocked",
      code: code && /^[A-Z0-9_]+$/.test(code) ? code : "database_configuration_or_schema_required",
    }),
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
