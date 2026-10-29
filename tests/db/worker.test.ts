import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset } from "../helpers";
import { database, closeDatabase } from "../../apps/web/lib/server/db";
import { maintenanceTask } from "../../apps/web/lib/server/worker";
import { runJobs } from "../../apps/web/lib/server/jobs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEVNET_GENESIS } from "../../apps/web/lib/server/solana/chain";
setupEnv();
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")("worker database ownership and recovery", () => {
  beforeEach(reset);
  afterAll(closeDatabase);
  it("runs a due maintenance task once across concurrent replicas", async () => {
    const action = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => maintenanceTask("expire", action)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(await maintenanceTask("expire", action)).toBe(false);
  });
  it("recovers expired maintenance ownership and backs off failed work", async () => {
    await database().query(
      "INSERT INTO worker_schedules(name,lease_until,lease_token) VALUES('reconcile',now()-interval '1 second',$1)",
      [randomUUID()],
    );
    await expect(
      maintenanceTask("reconcile", async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow();
    const row = (await database().query("SELECT * FROM worker_schedules WHERE name='reconcile'"))
      .rows[0];
    expect(row.lease_token).toBeNull();
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });
  it("does not let a stale maintenance owner release a replacement lease", async () => {
    const replacement = randomUUID();
    await maintenanceTask("expire", async () => {
      await database().query(
        "UPDATE worker_schedules SET lease_token=$1,lease_until=now()+interval '60 seconds' WHERE name='expire'",
        [replacement],
      );
    });
    expect(
      (await database().query("SELECT lease_token FROM worker_schedules WHERE name='expire'"))
        .rows[0].lease_token,
    ).toBe(replacement);
  });
  it("claims one queued job once and quarantines repeated failures", async () => {
    const id = randomUUID();
    await database().query(
      "INSERT INTO jobs(kind,entity_id,dedupe_key,attempts) VALUES('unknown_test_job',$1,'worker-test',9)",
      [id],
    );
    await Promise.all([runJobs(), runJobs(), runJobs()]);
    const row = (await database().query("SELECT * FROM jobs WHERE entity_id=$1", [id])).rows[0];
    expect(row.state).toBe("quarantined");
    expect(row.attempts).toBe(10);
    expect(row.lease_token).toBeNull();
  });
  it("reclaims an abandoned running job and does not take jobs during shutdown", async () => {
    const id = randomUUID();
    await database().query(
      "INSERT INTO jobs(kind,entity_id,dedupe_key,state,lease_until,lease_token) VALUES('unknown_test_job',$1,'recover','running',now()-interval '1 second',$2)",
      [id, randomUUID()],
    );
    const c = new AbortController();
    c.abort();
    await runJobs({ signal: c.signal });
    expect(
      (await database().query("SELECT attempts FROM jobs WHERE entity_id=$1", [id])).rows[0]
        .attempts,
    ).toBe(0);
    await runJobs();
    const row = (await database().query("SELECT * FROM jobs WHERE entity_id=$1", [id])).rows[0];
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lease_token).toBeNull();
  });
  it("runs the real worker entry point, advances queued work and drains SIGTERM", async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const call = JSON.parse(Buffer.concat(chunks).toString());
      const result =
        call.method === "getGenesisHash" ? DEVNET_GENESIS : { context: { slot: 1 }, value: 0 };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No test RPC port");
    const id = randomUUID();
    await database().query(
      "INSERT INTO jobs(kind,entity_id,dedupe_key,attempts) VALUES('worker_process_test',$1,'worker-process-test',9)",
      [id],
    );
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env: {
        ...process.env,
        SOLANA_RPC_URL: `http://127.0.0.1:${address.port}`,
        WORKER_POLL_MS: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    const exited = once(child, "exit");
    try {
      let progressed = false;
      for (let i = 0; i < 200; i++) {
        if (
          (await database().query("SELECT state FROM jobs WHERE entity_id=$1", [id])).rows[0]
            ?.state === "quarantined"
        ) {
          progressed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(progressed).toBe(true);
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe(0);
      expect(output.includes("worker.started")).toBe(true);
      expect(output.includes("worker.stopped")).toBe(true);
      expect(output.includes(process.env.FEE_PAYER_SECRET!)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45000);
});
