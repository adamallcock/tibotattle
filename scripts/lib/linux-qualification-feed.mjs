// Read-only admission of an already signed feed for isolated Linux qualification.
// This module never signs, learns trust roots from inputs, or publishes anything.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import distribution from "../../config/electron-production-distribution.cjs";
import { createLinuxUpdateVerifier } from "../../apps/electron/linux-update-authenticity.js";

const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider.js");
const FEED_URL = `${distribution.PRODUCTION_ELECTRON_TARGETS["linux-x64"].feedURL}/latest-linux.yml`;
const MAXIMUM_FEED_BYTES = 64 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 ** 3;
const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;
const fail = boundary => { throw Object.assign(new Error(`LINUX_QUALIFICATION_${boundary}_INVALID`),
  { code: `LINUX_QUALIFICATION_${boundary}_INVALID` }); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value !== null && typeof value === "object"
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const validSize = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
function boundedCopy(value, maximum, boundary) {
  if (!(value instanceof Uint8Array) || !validSize(value.byteLength, maximum)) fail(boundary);
  return Buffer.from(value);
}
function verifier(keys, currentVersion, now = Date.now) {
  return createLinuxUpdateVerifier({ keys, currentVersion, now,
    backend: { load: async () => null, save: async () => {} } });
}

/** Validate immutable inputs using the same parser and signature authority as
 * the installed updater. This throwaway admission state is not replay proof;
 * the installed app still owns its durable sequence/version high-water state.
 * keys/now are explicit synthetic-test seams, never CLI/environment/feed inputs.
 * image hashes must come from the caller's independently measured AppImage. */
export async function validateLinuxQualificationFeed({ feedBytes, descriptor, image,
  currentVersion = image?.version } = {}, {
  keys = distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS, now = Date.now,
} = {}) {
  try {
    const bytes = boundedCopy(feedBytes, MAXIMUM_FEED_BYTES, "FEED");
    if (!exact(descriptor, ["file", "bytes", "sha256"]) || descriptor.file !== "latest-linux.yml"
      || !validSize(descriptor.bytes, MAXIMUM_FEED_BYTES) || !HASH.test(descriptor.sha256 ?? "")
      || descriptor.bytes !== bytes.length || descriptor.sha256 !== digest(bytes)
      || typeof image?.version !== "string" || !VERSION.test(image.version)
      || !validSize(image.bytes, MAXIMUM_ARTIFACT_BYTES) || !HASH.test(image.sha256 ?? "")
      || typeof image.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(image.sha512)) fail("FEED");
    const expectedFeed = Object.freeze({ ...descriptor });
    const expectedImage = { version: image.version, bytes: image.bytes, sha256: image.sha256, sha512: image.sha512 };
    // Reject malformed UTF-8 rather than authorizing a replacement-character
    // interpretation that differs from the reviewed input bytes.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const info = parseUpdateInfo(text, "latest-linux.yml", FEED_URL);
    const authority = verifier(keys, currentVersion, now);
    const { updateAvailable } = await authority.authorize(info);
    const manifest = info.tibotattleLinuxUpdate.manifest;
    const artifactFileName = `TiboTattle-${expectedImage.version}-linux-x86_64.AppImage`;
    if (manifest.version !== expectedImage.version || manifest.size !== expectedImage.bytes
      || manifest.sha256 !== expectedImage.sha256 || info.sha512 !== expectedImage.sha512
      || info.files[0].sha512 !== expectedImage.sha512 || info.files[0].url !== artifactFileName) fail("FEED");
    return Object.freeze({
      // Buffers cannot be frozen. Every read gets a copy; callers cannot change
      // the retained positive feed by editing their original or returned bytes.
      get feedBytes() { return Buffer.from(bytes); },
      descriptor: expectedFeed, artifactFileName,
      artifactRequestPath: `${new URL(distribution.PRODUCTION_ELECTRON_TARGETS["linux-x64"].feedURL).pathname}/${artifactFileName}`,
      manifest: Object.freeze({ ...manifest }), updateAvailable,
    });
  } catch { fail("FEED"); }
}

/** Same-length, one-byte corruption of an independently bound source stream.
 * Use only for the explicit negative download phase. Original chunks and the
 * stored AppImage stay unchanged; completion requires the exact original hash. */
export function createLinuxQualificationCorruptStream({ expectedBytes, expectedSha256 } = {}) {
  if (!validSize(expectedBytes, MAXIMUM_ARTIFACT_BYTES) || !HASH.test(expectedSha256 ?? "")) fail("STREAM");
  const hash = createHash("sha256"); let count = 0, corrupted = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        if (!(chunk instanceof Uint8Array) || count + chunk.length > expectedBytes) fail("STREAM");
        const output = Buffer.from(chunk);
        hash.update(output); count += output.length;
        if (!corrupted && output.length > 0) { output[0] ^= 1; corrupted = true; }
        done(null, output);
      } catch { done(Object.assign(new Error("LINUX_QUALIFICATION_STREAM_INVALID"), { code: "LINUX_QUALIFICATION_STREAM_INVALID" })); }
    },
    flush(done) {
      if (!corrupted || count !== expectedBytes || hash.digest("hex") !== expectedSha256) {
        done(Object.assign(new Error("LINUX_QUALIFICATION_STREAM_INVALID"), { code: "LINUX_QUALIFICATION_STREAM_INVALID" }));
      } else done();
    },
  });
}

// Production staging preserves these source-relative paths inside app.asar.
// The fixed selection checks updater composition and embedded key policy; it
// does not replace the caller's admission of the entire artifact/ASAR digests.
export const LINUX_QUALIFICATION_AUTHORITY_FILES = Object.freeze([
  "config/electron-production-distribution.cjs",
  "config/macos-bundle-version-plan.cjs",
  "apps/electron/main.js",
  "apps/electron/desktop-runtime.js",
  "apps/electron/desktop-updater.js",
  "apps/electron/linux-update-authenticity.js",
]);
const readReviewedSource = file => readFile(new URL(`../../${file}`, import.meta.url));

/** Passively compare actual packaged files against BOTH the separately admitted
 * candidate source and reviewed runner source. readSourceFile must read the
 * admitted candidate revision, never package-reported hashes or runner files.
 * readAsarFile must read the independently digest-verified extracted ASAR.
 * No packaged JavaScript is evaluated. Overrides are synthetic-test seams. */
export async function validateLinuxQualificationPackagedAuthority({ readAsarFile, readSourceFile } = {}, {
  readReviewedFile = readReviewedSource, keys = distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS,
} = {}) {
  try {
    if (typeof readAsarFile !== "function" || typeof readSourceFile !== "function"
      || typeof readReviewedFile !== "function") fail("AUTHORITY");
    verifier(keys, "0.0.0"); // Includes the actual runtime's nonempty/closed key-policy check.
    const files = [];
    for (const file of LINUX_QUALIFICATION_AUTHORITY_FILES) {
      const source = boundedCopy(await readSourceFile(file), 1024 ** 2, "AUTHORITY");
      const reviewed = boundedCopy(await readReviewedFile(file), 1024 ** 2, "AUTHORITY");
      const packaged = boundedCopy(await readAsarFile(file), 1024 ** 2, "AUTHORITY");
      if (!source.equals(reviewed) || !source.equals(packaged)) fail("AUTHORITY");
      files.push(Object.freeze({ file, bytes: source.length, sha256: digest(source) }));
    }
    return Object.freeze({ schemaVersion: "tibotattle-linux-qualification-authority-v1",
      status: "packaged_source_matches_reviewed_authority", files: Object.freeze(files) });
  } catch { fail("AUTHORITY"); }
}
