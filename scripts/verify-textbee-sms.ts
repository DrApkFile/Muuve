import { mkdir, open, readFile, writeFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { phone } from "@muuve/shared";
import { TextbeeOtpProvider } from "../apps/web/lib/server/providers/textbee";
import { assert } from "../apps/web/lib/server/errors";

// Real SMS provider probe only: no HTTP login, database sessions or chain actions.
const path = "keys/textbee-sms-test.json",
  codePath = "keys/textbee-sms-code.json",
  mode = process.argv.includes("--send")
    ? "send"
    : process.argv.includes("--resend-expired")
      ? "resend-expired"
      : process.argv.includes("--verify")
        ? "verify"
        : "invalid",
  evidence: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    mode,
    scope: "Local real-Textbee SMS probe; not hosted Render authentication",
    transactions_submitted: 0,
    sessions_created: 0,
  };
let lock: Awaited<ReturnType<typeof open>> | undefined, progress: any;
async function save() {
  await writeFile(path + ".tmp", JSON.stringify(progress) + "\n", { mode: 0o600 });
  await rename(path + ".tmp", path);
}
try {
  assert(
    mode !== "invalid" && process.argv.includes("--operator-approved-sms"),
    "explicit_sms_scope_required",
  );
  assert(
    process.env.SOLANA_CLUSTER === "devnet" &&
      process.env.OTP_PROVIDER === "textbee" &&
      ["local", "preview"].includes(process.env.APP_ENV ?? ""),
    "devnet_textbee_test_configuration_required",
  );
  lock = await open(path + ".lock", "wx", 0o600);
  const phonesPath = "keys/hosted-test-phones.json";
  assert(((await stat(phonesPath)).mode & 0o077) === 0, "private_phone_configuration_required");
  const phones = JSON.parse(await readFile(phonesPath, "utf8"));
  assert(
    phones.authorize_sms === true && phone.safeParse(phones.sender).success,
    "authorized_test_destination_required",
  );
  try {
    assert(((await stat(path)).mode & 0o077) === 0, "private_progress_required");
    progress = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    progress = {
      phase: "new",
      context: { challengeId: randomUUID(), phone: phones.sender },
      attempts: 0,
    };
    await save();
  }
  assert(progress.context.phone === phones.sender, "test_destination_mismatch");
  const provider = new TextbeeOtpProvider();
  if (mode === "send" || mode === "resend-expired") {
    if (mode === "send") {
      assert(progress.phase === "new", "existing_sms_attempt_preserved_no_automatic_resend");
      await writeFile(codePath, JSON.stringify({ code: "" }) + "\n", { mode: 0o600, flag: "wx" });
    } else {
      assert(
        progress.phase === "waiting_for_code" &&
          Date.now() - progress.started_at >= 600000 &&
          !progress.previous_expired_probe,
        "only_one_expired_probe_resend_allowed",
      );
      progress.previous_expired_probe = {
        context: progress.context,
        started_at: progress.started_at,
        reference: progress.reference,
      };
      progress.context = { challengeId: randomUUID(), phone: phones.sender };
      progress.attempts = 0;
      delete progress.reference;
      await writeFile(codePath, JSON.stringify({ code: "" }) + "\n", { mode: 0o600 });
    }
    progress.phase = "send_started";
    progress.started_at = Date.now();
    await save();
    progress.reference = await provider.send(progress.context.phone, "sms", progress.context);
    progress.phase = "waiting_for_code";
    await save();
    evidence.state = "real_textbee_request_accepted_delivery_unverified";
  } else {
    assert(
      progress.phase === "waiting_for_code" &&
        Date.now() - progress.started_at < 600000 &&
        progress.attempts < 5,
      "active_probe_required",
    );
    assert(((await stat(codePath)).mode & 0o077) === 0, "private_code_file_required");
    const input = JSON.parse(await readFile(codePath, "utf8"));
    assert(/^\d{6}$/.test(input.code), "six_digit_private_code_required");
    await writeFile(codePath, JSON.stringify({ code: "" }) + "\n", { mode: 0o600 });
    progress.attempts++;
    await save();
    assert(await provider.check(progress.reference, input.code, progress.context), "invalid_code");
    progress.phase = "verified";
    await save();
    evidence.state = "real_textbee_sms_received_and_verifier_passed";
  }
} catch (error) {
  evidence.state = "blocked_no_automatic_resend";
  evidence.code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "local_probe_configuration_or_transport_failure";
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(path + ".lock");
  }
  await mkdir("evidence/textbee", { recursive: true });
  const output = `evidence/textbee/sms-${mode}-${randomUUID()}.json`;
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(JSON.stringify({ ...evidence, evidence: output }));
}
