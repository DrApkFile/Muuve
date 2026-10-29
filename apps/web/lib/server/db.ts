import pg, { type PoolClient, type QueryResultRow } from "pg";
let pool: pg.Pool | undefined;
export function database() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      idleTimeoutMillis: 30000,
      options: "-c search_path=muuve,public",
      application_name: "muuve-backend",
    });
    pool.on("error", () => {
      console.error('{"event":"database.pool_error","code":"connection_lost"}');
    });
  }
  return pool;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (attempt < 2 && ["40P01", "40001"].includes((error as { code?: string }).code ?? ""))
        continue;
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("transaction_retry_exhausted");
}
export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
  client: pg.Pool | PoolClient = database(),
): Promise<T | undefined> {
  return (await client.query<T>(sql, values)).rows[0];
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
export async function audit(
  client: PoolClient,
  entity: string,
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  // Callers supply identifiers/states only. Never store raw provider/request payloads.
  await client.query("INSERT INTO events(entity_type,entity_id,type,payload) VALUES($1,$2,$3,$4)", [
    entity,
    id,
    type,
    payload,
  ]);
}
export async function enqueue(
  client: PoolClient,
  kind: string,
  entity: string,
  key: string,
  delay = 0,
) {
  await client.query(
    "INSERT INTO jobs(kind,entity_id,dedupe_key,run_after) VALUES($1,$2,$3,now()+$4*interval '1 second') ON CONFLICT(dedupe_key) DO NOTHING",
    [kind, entity, key, delay],
  );
}
