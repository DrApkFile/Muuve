import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Render startup configuration diagnostics", () => {
  for (const entry of ["api", "worker"] as const) {
    it(`names forbidden ${entry} variables without logging their values`, () => {
      const marker = "private-startup-test-value";
      const result = spawnSync(
        process.execPath,
        entry === "api" ? ["scripts/start-api.mjs"] : ["--import", "tsx", "scripts/worker.ts"],
        {
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "production",
            RENDER: "true",
            APP_ENV: "preview",
            APP_BASE_URL: "https://muuve.test",
            OTP_PROVIDER: "twilio",
            OPERATOR_ADMIN_SECRET_FILE: marker,
            OPERATOR_APPROVED_DEVNET: "false",
            DEVNET_TEST_RECIPIENT: marker,
            TEST_MINT_SECRET: marker,
            TEST_MINT_SECRET_FILE: marker,
            // Runtime secrets must not be reported as operator-only variables.
            FEE_PAYER_SECRET: marker,
            ATTESTOR_SECRET: marker,
            TREASURY_SECRET: marker,
            TEST_MINT_AUTHORITY_SECRET: marker,
          },
        },
      );
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      for (const name of [
        "OPERATOR_ADMIN_SECRET_FILE",
        "OPERATOR_APPROVED_DEVNET",
        "DEVNET_TEST_RECIPIENT",
        "TEST_MINT_SECRET",
        "TEST_MINT_SECRET_FILE",
      ])
        expect(output).toContain(name);
      expect(output).not.toContain(marker);
      expect(output).not.toContain("TEST_MINT_AUTHORITY_SECRET");
      expect(output).not.toContain("FEE_PAYER_SECRET");
      expect(output).not.toContain("ATTESTOR_SECRET");
      expect(output).not.toContain("TREASURY_SECRET");
    });
  }
});
