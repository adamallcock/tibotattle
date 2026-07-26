import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`${name} requires a value\n`);
    process.exit(2);
  }
  return value;
}

const hoursIndex = process.argv.indexOf("--expires-in-hours");
const hours = hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1]) : 72;
const outputFile = optionValue("--output-file");
const persistTo = optionValue("--persist-to");
if (process.argv.includes("--remote")) {
  process.stderr.write("Remote grant issuance is deliberately unsupported\n");
  process.exit(2);
}
if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 30) {
  process.stderr.write("--expires-in-hours must be an integer from 1 to 720\n");
  process.exit(2);
}

const id = randomUUID();
const secret = randomBytes(32).toString("base64url");
const secretHash = createHash("sha256")
  .update(`app-usagemonitor/enrollment-invite/v1\0${id}\0${secret}`)
  .digest("hex");
const issuedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
const sql = `INSERT INTO enrollment_grants (
  id, secret_hash, state, issued_at, expires_at
) VALUES (
  '${id}', x'${secretHash}', 'issued', '${issuedAt}', '${expiresAt}'
);`;

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(workerDirectory, "node_modules", ".bin", "wrangler");
const invitation = `um_invite_${id}.${secret}`;
let outputDescriptor;
let outputIdentity;
if (outputFile) {
  try {
    outputDescriptor = openSync(outputFile, "wx", 0o600);
    outputIdentity = fstatSync(outputDescriptor);
    writeFileSync(outputDescriptor, `${invitation}\n`, { encoding: "utf8" });
    fsyncSync(outputDescriptor);
  } catch {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor);
    process.stderr.write("The owner-only invitation output file could not be reserved\n");
    process.exit(1);
  }
}
const result = spawnSync(
  wrangler,
  [
    "d1", "execute", "USAGE_MONITOR_DB",
    "--local",
    ...(persistTo ? ["--persist-to", persistTo] : []),
    "--command", sql,
  ],
  { cwd: workerDirectory, encoding: "utf8" },
);
if (result.status !== 0) {
  let removedReservedOutput = !outputFile;
  if (outputDescriptor !== undefined && outputFile && outputIdentity) {
    try {
      const current = lstatSync(outputFile);
      if (current.dev === outputIdentity.dev && current.ino === outputIdentity.ino) {
        unlinkSync(outputFile);
        removedReservedOutput = true;
      }
    } catch {
      removedReservedOutput = false;
    } finally {
      closeSync(outputDescriptor);
    }
  }
  process.stderr.write(
    "Grant issuance failed."
    + (removedReservedOutput
      ? ""
      : " The reserved invitation file could not be safely removed; delete it before retrying.")
    + "\n",
  );
  process.exit(result.status ?? 1);
}

if (outputFile) {
  closeSync(outputDescriptor);
  process.stdout.write(
    `Enrollment grant created in an owner-only file; delete that file after use. Expires: ${expiresAt}\n`,
  );
} else {
  process.stdout.write(
    [
      "Enrollment grant created. Show this value once and do not log or save it in the repository:",
      invitation,
      `Expires: ${expiresAt}`,
      "Target: local",
      "",
    ].join("\n"),
  );
}
