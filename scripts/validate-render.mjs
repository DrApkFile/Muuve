import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
const source = readFileSync("render.yaml", "utf8"),
  blueprint = parse(source);
const schemaFile = process.argv[2] ?? "config/render.schema.json";
const schemaText = readFileSync(schemaFile, "utf8");
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(JSON.parse(schemaText));
if (!validate(blueprint)) throw new Error(JSON.stringify(validate.errors));
const names = new Set(blueprint.services.map((s) => s.name));
for (const service of blueprint.services) {
  if (service.rootDir !== "." || service.runtime !== "node")
    throw new Error("Invalid monorepo configuration");
  for (const command of [service.buildCommand, service.startCommand])
    for (const file of command.match(/scripts\/[\w-]+\.(?:mjs|ts)/g) ?? [])
      if (!existsSync(file)) throw new Error(`Missing command entry point: ${file}`);
  for (const env of service.envVars) {
    if (
      env.fromService &&
      (!names.has(env.fromService.name) ||
        !blueprint.services
          .find((s) => s.name === env.fromService.name)
          .envVars.some((e) => e.key === env.fromService.envVarKey))
    )
      throw new Error("Invalid shared environment reference");
    if (/OPERATOR_|DEVNET_TEST_|AUTH_JWT_PRIVATE_KEY_FILE/.test(env.key))
      throw new Error("Operator key/file in Render environment");
  }
}
const worker = blueprint.services.find((s) => s.type === "worker");
if (
  worker.envVars.some((e) => /PRIVY|TWILIO|TEXTBEE|SESSION_SECRET|CRON_SECRET|AUTH_JWT/.test(e.key))
)
  throw new Error("Unnecessary worker secret");
console.info(
  JSON.stringify({
    state: "passed",
    services: blueprint.services.length,
    schema: "https://render.com/schema/render.yaml.json",
    schema_sha256: createHash("sha256").update(schemaText).digest("hex"),
    checks: [
      "YAML syntax",
      "official JSON Schema",
      "entry points",
      "environment references",
      "worker secret separation",
    ],
  }),
);
