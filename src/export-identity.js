import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SECRET_BYTES = 32;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PSEUDONYM_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function defaultExportSecretFile() {
  return resolve(process.cwd(), ".usage-monitor", "export-participant-secret");
}

function decodeSecret(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const result = Buffer.from(value);
    if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
    return result;
  }
  if (typeof value !== "string") throw new Error("Participant secret must be a 32-byte base64url value");
  const normalized = value.trim();
  if (!BASE64URL_256_PATTERN.test(normalized)) throw new Error("Participant secret must be a 32-byte base64url value");
  const result = Buffer.from(normalized, "base64url");
  if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
  return result;
}

export function encodeParticipantSecret(secret) {
  return decodeSecret(secret).toString("base64url");
}

async function writeNewSecret(path, encoded) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${encoded}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function loadOrCreateParticipantSecret({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
} = {}) {
  if (environmentSecret) {
    return {
      secret: decodeSecret(environmentSecret),
      source: "environment",
      created: false,
    };
  }
  const path = resolve(secretFile);
  try {
    const encoded = (await readFile(path, "utf8")).trim();
    await chmod(path, 0o600);
    return { secret: decodeSecret(encoded), source: "owner_only_file", created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const secret = randomBytes(SECRET_BYTES);
  const encoded = encodeParticipantSecret(secret);
  try {
    await writeNewSecret(path, encoded);
    return { secret, source: "owner_only_file", created: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = (await readFile(path, "utf8")).trim();
    await chmod(path, 0o600);
    return { secret: decodeSecret(existing), source: "owner_only_file", created: false };
  }
}

function domainKey(secret, domain) {
  return Buffer.from(hkdfSync(
    "sha256",
    decodeSecret(secret),
    Buffer.from("app-usagemonitor/export-identity/v1", "utf8"),
    Buffer.from(domain, "utf8"),
    SECRET_BYTES,
  ));
}

export function deriveExportPseudonym(secret, prefix, subject) {
  if (!PSEUDONYM_PREFIX_PATTERN.test(prefix)) throw new Error("Pseudonym prefix is invalid");
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 4096) {
    throw new Error("Pseudonym subject must be a bounded non-empty string");
  }
  const digest = createHmac("sha256", domainKey(secret, prefix))
    .update(`app-usagemonitor/${prefix}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest("base64url");
  return `${prefix}:v1:${digest}`;
}

export function deriveParticipantId(secret) {
  return deriveExportPseudonym(secret, "participant", "self");
}

export function deriveSessionScopeId(secret, rawSessionSubject) {
  return deriveExportPseudonym(secret, "session", rawSessionSubject);
}

export function deriveEventId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "event", canonicalSubject);
}

export function deriveSnapshotId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "snapshot", canonicalSubject);
}

export function deriveMarkerId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "marker", canonicalSubject);
}

export function deriveAccountScopeId(secret, rawAccountScope) {
  if (rawAccountScope === null || rawAccountScope === undefined || rawAccountScope === "unattributed") return "unattributed";
  return deriveExportPseudonym(secret, "account", String(rawAccountScope));
}

export function deriveModelFingerprint(secret, rawModelId) {
  return deriveExportPseudonym(secret, "model", rawModelId);
}

export function randomBundleId() {
  return `bundle:v1:${randomBytes(SECRET_BYTES).toString("base64url")}`;
}
