import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    maxWorkers: 2,
    fileParallelism: process.env.MUUVE_TEST_DB !== "1",
  },
  resolve: {
    alias: { "@muuve/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname },
  },
});
