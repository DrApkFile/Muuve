import { writeFile, rename } from "node:fs/promises";

// A process-level controller lock excludes other runners. Serialize writes within
// this runner too: concurrent HTTP duplicate tests must not race the same temp file.
// A failed write poisons the queue so no later step can hide a journal failure.
export function privateProgressWriter(path: string, snapshot: () => unknown) {
  let queue = Promise.resolve();
  return () => {
    queue = queue.then(async () => {
      await writeFile(path + ".tmp", JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 });
      await rename(path + ".tmp", path);
    });
    return queue;
  };
}
