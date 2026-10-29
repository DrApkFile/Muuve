import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const result = spawnSync(
  "cargo",
  [
    "test",
    "--locked",
    "--manifest-path",
    "programs/muuve_escrow/Cargo.toml",
    "--lib",
    "--features",
    "idl-build",
    "__anchor_private_print_idl",
    "--",
    "--show-output",
    "--test-threads=1",
  ],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ANCHOR_IDL_BUILD_PROGRAM_PATH: resolve("programs/muuve_escrow") },
  },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.stdout.write(result.stdout ?? "");
  process.exit(result.status ?? 1);
}
const sections = [
  ...result.stdout.matchAll(/--- IDL begin (\w+) ---\s*([\s\S]*?)--- IDL end \1 ---/g),
].map((m) => ({ kind: m[1], value: JSON.parse(m[2]) }));
const idl = sections.find((s) => s.kind === "program")?.value;
if (!idl) throw new Error("Anchor did not emit a program IDL");
idl.address = sections.find((s) => s.kind === "address")?.value?.replace(/^"+|"+$/g, "");
if (!idl.address) throw new Error("Anchor did not emit the program address");
idl.events = [];
idl.errors = [];
idl.constants = [];
for (const s of sections) {
  if (s.kind === "event") {
    idl.events.push(s.value.event);
    idl.types.push(...s.value.types);
  }
  if (s.kind === "errors") idl.errors.push(...s.value);
  if (s.kind === "constant") idl.constants.push(s.value);
}
idl.types = [...new Map(idl.types.map((t) => [t.name, t])).values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
mkdirSync("packages/shared/idl", { recursive: true });
writeFileSync("packages/shared/idl/muuve_escrow.json", JSON.stringify(idl, null, 2) + "\n");
console.info(
  `Generated Anchor IDL: ${idl.instructions.length} instructions, ${idl.accounts.length} accounts. Address is the explicit build ID or host-test fixture; no deployment is implied.`,
);
