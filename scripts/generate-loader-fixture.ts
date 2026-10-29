import { PublicKey } from "@solana/web3.js";
import { mkdir, writeFile } from "node:fs/promises";
import { writeBuffer, deployInstruction } from "./paced-deployment";
const program = new PublicKey(new Uint8Array(32).fill(1)),
  buffer = new PublicKey(new Uint8Array(32).fill(2)),
  authority = new PublicKey(new Uint8Array(32).fill(3));
const write = writeBuffer(buffer, authority, 42, Buffer.from([7, 8, 9])),
  deploy = deployInstruction(program, buffer, authority, 1234);
const accounts = (ix: typeof write) =>
  ix.keys
    .map((k) => `${k.pubkey.toBase58()}:${Number(k.isSigner)}:${Number(k.isWritable)}`)
    .join(",");
await mkdir("tests/fixtures", { recursive: true });
await writeFile(
  "tests/fixtures/loader-v3.txt",
  [
    `write_data=${write.data.toString("hex")}`,
    `write_accounts=${accounts(write)}`,
    `deploy_data=${deploy.data.toString("hex")}`,
    `deploy_accounts=${accounts(deploy)}`,
  ].join("\n") + "\n",
);
console.info("Wrote TypeScript loader fixture; the Rust SDK cross-check must pass before use.");
