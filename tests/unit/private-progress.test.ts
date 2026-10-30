import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateProgressWriter } from "../../scripts/private-progress";

describe("private operator progress during concurrent duplicate requests", () => {
  it("serializes concurrent atomic replacements, preserves the latest state and private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "muuve-progress-")),
      path = join(root, "progress.json"),
      state = { events: [] as number[] },
      save = privateProgressWriter(path, () => state);
    try {
      const requests = Array.from({ length: 12 }, (_, index) => {
        state.events.push(index);
        return save();
      });
      await Promise.all(requests);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect(await readdir(root)).toEqual(["progress.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps later operations failed after a journal write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "muuve-progress-failure-")),
      save = privateProgressWriter(join(root, "missing", "journal.json"), () => ({
        state: "submitted",
      }));
    try {
      await expect(save()).rejects.toMatchObject({ code: "ENOENT" });
      await expect(save()).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
