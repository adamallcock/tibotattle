#!/usr/bin/env node
/** Explicit local signing only. Never provisions a key or publishes a feed. */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import distribution from "../config/electron-production-distribution.cjs";
import { createLinuxUpdateVerifier, LINUX_UPDATE_MANIFEST_SCHEMA } from "../apps/electron/linux-update-authenticity.js";
import { parseWindowsUpdaterYaml } from "./verify-electron-windows-update-artifacts.mjs";

const fail = () => { throw Object.assign(new Error("Linux update signing refused"), { code: "LINUX_UPDATE_SIGNING_REFUSED" }); };
const stableVersion = value => typeof value === "string" && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u.test(value);

async function readBounded(path, maximumBytes, { secret = false, keep = false } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes
        || (secret && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid()))) fail();
    const sha256 = createHash("sha256"), sha512 = createHash("sha512"), parts = [];
    let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length; if (count > maximumBytes) fail();
      sha256.update(chunk); sha512.update(chunk); if (keep) parts.push(chunk);
    }
    const after = await handle.stat(), named = await lstat(path);
    if (count !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || !named.isFile() || named.ino !== before.ino || named.dev !== before.dev) fail();
    return { bytes: count, sha256: sha256.digest("hex"), sha512: sha512.digest("base64"),
      ...(keep ? { contents: Buffer.concat(parts) } : {}) };
  } finally { await handle.close(); }
}

/** A signing adapter is explicit and local. Production CLI checks that its
 * private key matches the source-embedded publisher root before signing. */
export async function signLinuxUpdateFeed({ artifactPath, feedBytes, sequence, expiresAt, keyId, signer,
  keys = distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS, now = Date.now } = {}) {
  if (typeof signer !== "function" || !Number.isSafeInteger(sequence) || sequence < 1
      || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 31 * 24 * 60 * 60_000) fail();
  const feed = parseWindowsUpdaterYaml(feedBytes), artifact = await readBounded(artifactPath, 2 * 1024 ** 3);
  const file = feed.files?.[0];
  if (!stableVersion(feed.version) || !Array.isArray(feed.files) || feed.files.length !== 1
      || typeof file?.url !== "string" || file.url !== basename(artifactPath)
      || file.url !== `TiboTattle-${feed.version}-linux-x86_64.AppImage`
      || feed.path !== file.url || feed.sha512 !== artifact.sha512 || file.sha512 !== artifact.sha512
      || file.size !== artifact.bytes || Object.hasOwn(feed, "packages")
      || Object.keys(file).some(name => !["url", "size", "sha512", "blockMapSize"].includes(name))
      || (Object.hasOwn(file, "blockMapSize") && (!Number.isSafeInteger(file.blockMapSize)
        || file.blockMapSize < 1 || file.blockMapSize > artifact.bytes - 4))) fail();
  const authority = keys.find(key => key.id === keyId);
  if (!authority || sequence < authority.minimumSequence || sequence > authority.maximumSequence) fail();
  const verifier = createLinuxUpdateVerifier({ keys, currentVersion: feed.version, now,
    backend: { load: async () => null, save: async () => {} } });
  const manifest = { schemaVersion: LINUX_UPDATE_MANIFEST_SCHEMA, appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    channel: "stable", target: "linux-x64", version: feed.version, sequence,
    size: artifact.bytes, sha256: artifact.sha256, keyId, expiresAt };
  const signature = await signer(Buffer.from(`${JSON.stringify(manifest)}\n`));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) fail();
  // JSON is a YAML subset accepted by the pinned updater/parser. Construct the
  // exact feed instead of carrying unreviewed top-level fields through signing.
  const result = { version: feed.version, files: [{ ...file }], path: file.url, sha512: artifact.sha512,
    tibotattleLinuxUpdate: { manifest, signature: Buffer.from(signature).toString("base64") } };
  await verifier.authorize(result);
  return Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let privateBytes;
  try {
    const args = process.argv.slice(2), flags = ["--sign", "--artifact", "--feed", "--sequence", "--expires-at", "--key-id", "--private-key-file", "--output"];
    if (args[0] !== flags[0] || args.length !== 15 || flags.slice(1).some((flag, i) => args[1 + i * 2] !== flag)) fail();
    const [, , artifactPath, , feedPath, , sequenceText, , expiryText, , keyId, , keyPath, , outputPath] = args;
    if (!/^[1-9][0-9]{0,15}$/u.test(sequenceText) || !/^[1-9][0-9]{0,15}$/u.test(expiryText)) fail();
    const authority = distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS.find(key => key.id === keyId);
    if (!authority) fail(); // Refuse before touching private material when unprovisioned.
    privateBytes = (await readBounded(resolve(keyPath), 4096, { secret: true, keep: true })).contents;
    const privateKey = createPrivateKey(privateBytes);
    if (privateKey.asymmetricKeyType !== "ed25519"
        || createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64") !== authority.publicKey) fail();
    const result = await signLinuxUpdateFeed({ artifactPath: resolve(artifactPath),
      feedBytes: (await readBounded(resolve(feedPath), 64 * 1024, { keep: true })).contents,
      sequence: Number(sequenceText), expiresAt: Number(expiryText), keyId,
      signer: bytes => sign(null, bytes, privateKey) });
    const output = await open(resolve(outputPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(result); await output.sync(); } finally { await output.close(); }
    console.log(JSON.stringify({ status: "signed_locally", publication: "not_performed" }));
  } catch { console.error("LINUX_UPDATE_SIGNING_REFUSED"); process.exitCode = 1; }
  finally { privateBytes?.fill(0); }
}
