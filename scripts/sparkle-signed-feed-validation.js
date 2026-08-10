/**
 * Local validation of an OFFICIAL feed-signed Sparkle appcast, exactly as the
 * pinned Sparkle 2.9.3 `generate_appcast` tool emits it and exactly as the
 * deployed Worker guard (apps/worker/src/sparkle-appcast-guard.ts,
 * parseOfficialSignedSparkleAppcast) accepts it.
 *
 * Why this exists (2026-08-10 incident): production apps ship with
 * SURequireSignedFeed=true, so Sparkle refuses any appcast document that does
 * not end with the embedded `sparkle-signatures` trailer comment carrying an
 * Ed25519 signature over every byte before the comment ("The update feed is
 * improperly signed and could not be validated"). A hand-built minimal
 * appcast was published once and broke every installed updater. This module
 * is the local gate that makes that impossible to repeat: the appcast
 * generator self-validates its output with it, and the update publisher runs
 * it as a preflight before any network call.
 *
 * The two regular expressions below are copied CHARACTER-FOR-CHARACTER from
 * the Worker guard. test/sparkle-signed-feed-validation.test.js reads both
 * source files and fails loudly if the literals ever drift apart, so a guard
 * edit cannot silently diverge from this local gate. Do not "clean up" the
 * literals here; change the guard first and let the drift test force the
 * mirror update.
 */
import { createPublicKey, verify } from "node:crypto";

/**
 * Mirrors `trailer` in parseOfficialSignedSparkleAppcast
 * (apps/worker/src/sparkle-appcast-guard.ts). Must stay character-identical.
 */
export const SPARKLE_SIGNED_FEED_TRAILER_PATTERN = /<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/]+={0,2})\nlength: ([0-9]+)\n-->\n?$/u;

/**
 * Mirrors `official` in parseOfficialSignedSparkleAppcast
 * (apps/worker/src/sparkle-appcast-guard.ts). Must stay character-identical.
 */
export const OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN = /^<\?xml version="1\.0" standalone="yes"\?><!-- sparkle-sign-warning:\n[^\u0000\r]*?--><rss xmlns:sparkle="http:\/\/www\.andymatuschak\.org\/xml-namespaces\/sparkle" version="2\.0">\s*<channel>\s*<title>([^<&\r\n]{1,128})<\/title>\s*<item>\s*<title>([^<&\r\n]{1,64})<\/title>\s*<pubDate>([^<&\r\n]{1,64})<\/pubDate>\s*<sparkle:version>([^<&\r\n]{1,32})<\/sparkle:version>\s*<sparkle:shortVersionString>([^<&\r\n]{1,32})<\/sparkle:shortVersionString>\s*<sparkle:minimumSystemVersion>([0-9]+(?:\.[0-9]+){1,2})<\/sparkle:minimumSystemVersion>\s*<sparkle:hardwareRequirements>arm64<\/sparkle:hardwareRequirements>\s*<enclosure\b([^>]*?)>\s*<\/enclosure\s*>\s*<\/item>\s*<\/channel>\s*<\/rss>$/u;

const BUNDLE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u;
const SHORT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ARTIFACT_FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const XML_ATTRIBUTE_PATTERN =
  /\s+([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*("[^"]*"|'[^']*')/gu;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function importPublicEdKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string"
      || !ED25519_PUBLIC_KEY_PATTERN.test(value)
      || Buffer.from(value, "base64").length !== 32
      || Buffer.from(value, "base64").toString("base64") !== value) {
    fail(
      "Sparkle public Ed25519 key must be canonical base64 for 32 bytes",
      "SPARKLE_SIGNED_FEED_PUBLIC_KEY_INVALID",
    );
  }
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(value, "base64")]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail(
      "Sparkle public Ed25519 key could not be imported",
      "SPARKLE_SIGNED_FEED_PUBLIC_KEY_INVALID",
    );
  }
}

function canonicalSignatureBytes(value) {
  if (typeof value !== "string" || !ED25519_SIGNATURE_PATTERN.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) return null;
  return bytes;
}

/**
 * Mirrors the guard's parseXmlAttributes: simple quoted attributes only, no
 * duplicates, no markup or raw entities inside values, no residue.
 */
function parseEnclosureAttributes(source) {
  const attributes = new Map();
  const pattern = new RegExp(XML_ATTRIBUTE_PATTERN.source, "gu");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, key, quotedValue] = match;
    if (attributes.has(key)) {
      fail(
        "Signed appcast enclosure has a duplicate attribute",
        "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
      );
    }
    const value = quotedValue.slice(1, -1);
    if (value.includes("<") || value.includes(">")
        || /&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9A-Fa-f]+);)/u.test(value)) {
      fail(
        "Signed appcast enclosure attribute values must be simple quoted text",
        "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
      );
    }
    attributes.set(key, value);
  }
  if (!/^\s*$/u.test(source.replace(pattern, ""))) {
    fail(
      "Signed appcast enclosure attributes must be simple quoted values",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
    );
  }
  return attributes;
}

function parseEnclosureURL(value, { objectPrefix, updateOrigin, version }) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "Signed appcast enclosure URL is not a valid URL",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_URL_INVALID",
    );
  }
  const prefixSegments = objectPrefix.split("/");
  const segments = parsed.pathname.slice(1).split("/");
  const versionIndex = prefixSegments.length;
  if (parsed.origin !== updateOrigin
      || parsed.protocol !== "https:"
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.href !== value
      || segments.length !== versionIndex + 3
      || segments.slice(0, versionIndex).join("/") !== objectPrefix
      || segments[versionIndex] !== version
      || !SHA256_PATTERN.test(segments[versionIndex + 1] ?? "")
      || !SAFE_ARTIFACT_FILE_NAME_PATTERN.test(segments[versionIndex + 2] ?? "")) {
    fail(
      "Signed appcast enclosure URL must be an exact content-addressed DMG URL on the reviewed update origin",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_URL_INVALID",
    );
  }
  return Object.freeze({
    fileName: segments[versionIndex + 2],
    href: parsed.href,
    key: segments.join("/"),
    sha256: segments[versionIndex + 1],
  });
}

/**
 * Quick check for the embedded feed-signature trailer, used by callers to
 * distinguish "official signed candidate" from "unsigned candidate" before
 * running the full validation.
 */
export function hasSparkleSignedFeedTrailer(text) {
  return typeof text === "string"
    && SPARKLE_SIGNED_FEED_TRAILER_PATTERN.test(text);
}

/**
 * Validate one official feed-signed Sparkle appcast document with named
 * failure reasons (error.code):
 *
 *   SPARKLE_SIGNED_FEED_TRAILER_MISSING        no well-formed trailer comment
 *   SPARKLE_SIGNED_FEED_TRAILER_INVALID        trailer signature not canonical
 *   SPARKLE_SIGNED_FEED_LENGTH_MISMATCH        declared length != prefix bytes
 *   SPARKLE_SIGNED_FEED_ENVELOPE_SIGNATURE_INVALID  envelope does not verify
 *   SPARKLE_SIGNED_FEED_SHAPE_INVALID          document is not the exact
 *                                              generate_appcast shape the
 *                                              Worker guard accepts
 *   SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID      enclosure attributes malformed
 *   SPARKLE_SIGNED_FEED_ENCLOSURE_URL_INVALID  enclosure URL non-canonical
 *   SPARKLE_SIGNED_FEED_ARTIFACT_MISMATCH      enclosure disagrees with the
 *                                              supplied DMG bytes/sha256/size
 *   SPARKLE_SIGNED_FEED_ARTIFACT_SIGNATURE_INVALID  enclosure signature does
 *                                              not verify over the DMG bytes
 *   SPARKLE_SIGNED_FEED_PUBLIC_KEY_INVALID     supplied public key malformed
 *
 * `publicEdKey` (base64, 32 raw bytes) is optional: without it the envelope
 * and artifact signatures cannot be verified and those checks are skipped;
 * every structural check still runs. `dmg` is optional `{ bytes, fileName,
 * sha256, size }` (bytes optional when only consistency is wanted).
 */
export function validateSignedSparkleFeed({
  appcastText = null,
  appcastBytes = null,
  dmg = null,
  objectPrefix,
  publicEdKey = null,
  updateOrigin,
} = {}) {
  if (typeof updateOrigin !== "string" || updateOrigin.length === 0
      || typeof objectPrefix !== "string" || objectPrefix.length === 0) {
    fail(
      "Signed-feed validation requires the reviewed update origin and object prefix",
      "SPARKLE_SIGNED_FEED_VALIDATION_INPUT_INVALID",
    );
  }
  let text = appcastText;
  if (text === null) {
    if (!Buffer.isBuffer(appcastBytes)) {
      fail(
        "Signed-feed validation requires the appcast text or bytes",
        "SPARKLE_SIGNED_FEED_VALIDATION_INPUT_INVALID",
      );
    }
    text = appcastBytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(appcastBytes)) {
      fail(
        "Signed appcast bytes are not valid UTF-8",
        "SPARKLE_SIGNED_FEED_SHAPE_INVALID",
      );
    }
  }
  const publicKey = importPublicEdKey(publicEdKey);

  const trailer = SPARKLE_SIGNED_FEED_TRAILER_PATTERN.exec(text);
  if (trailer === null || trailer.index <= 0) {
    fail(
      "Signed appcast is missing the sparkle-signatures trailer required by SURequireSignedFeed clients",
      "SPARKLE_SIGNED_FEED_TRAILER_MISSING",
    );
  }
  const envelopeSignature = canonicalSignatureBytes(trailer[1]);
  if (envelopeSignature === null) {
    fail(
      "Signed appcast trailer does not carry a canonical Ed25519 signature",
      "SPARKLE_SIGNED_FEED_TRAILER_INVALID",
    );
  }
  const signedText = text.slice(0, trailer.index);
  const signedBytes = Buffer.from(signedText, "utf8");
  const declaredBytes = Number(trailer[2]);
  if (!Number.isSafeInteger(declaredBytes)
      || declaredBytes < 1
      || declaredBytes !== signedBytes.length) {
    fail(
      `Signed appcast trailer declares ${trailer[2]} bytes but the signed prefix is ${signedBytes.length} bytes`,
      "SPARKLE_SIGNED_FEED_LENGTH_MISMATCH",
    );
  }
  if (publicKey !== null) {
    let verified = false;
    try {
      verified = verify(null, signedBytes, publicKey, envelopeSignature);
    } catch {
      verified = false;
    }
    if (!verified) {
      fail(
        "Signed appcast envelope signature does not verify against the configured public Ed25519 key",
        "SPARKLE_SIGNED_FEED_ENVELOPE_SIGNATURE_INVALID",
      );
    }
  }

  const official = OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN.exec(signedText);
  if (official === null || Number.isNaN(Date.parse(official[3] ?? ""))) {
    fail(
      "Signed appcast document is not the exact official generate_appcast shape the Worker guard accepts",
      "SPARKLE_SIGNED_FEED_SHAPE_INVALID",
    );
  }
  const [
    ,
    channelTitle,
    itemTitle,
    pubDate,
    bundleVersion,
    shortVersion,
    minimumSystemVersion,
    attributeSource,
  ] = official;
  if (!BUNDLE_VERSION_PATTERN.test(bundleVersion ?? "")
      || !SHORT_VERSION_PATTERN.test(shortVersion ?? "")) {
    fail(
      "Signed appcast bundle or short version is not canonical",
      "SPARKLE_SIGNED_FEED_SHAPE_INVALID",
    );
  }

  const attributes = parseEnclosureAttributes(attributeSource);
  const expectedAttributes = ["url", "length", "type", "sparkle:edSignature"];
  if (attributes.size !== expectedAttributes.length
      || expectedAttributes.some((name) => !attributes.has(name))
      || attributes.get("type") !== "application/octet-stream") {
    fail(
      "Signed appcast enclosure must carry exactly url, length, type=application/octet-stream, and sparkle:edSignature",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
    );
  }
  const length = attributes.get("length");
  const lengthNumber = Number(length);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")
      || !Number.isSafeInteger(lengthNumber)
      || lengthNumber < 1
      || lengthNumber > MAX_ARTIFACT_BYTES) {
    fail(
      "Signed appcast enclosure length is invalid",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
    );
  }
  const enclosureSignature = canonicalSignatureBytes(
    attributes.get("sparkle:edSignature"),
  );
  if (enclosureSignature === null) {
    fail(
      "Signed appcast enclosure is missing a canonical Sparkle Ed25519 signature",
      "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID",
    );
  }
  const object = parseEnclosureURL(attributes.get("url"), {
    objectPrefix,
    updateOrigin,
    version: bundleVersion,
  });

  if (dmg !== null && dmg !== undefined) {
    if (typeof dmg !== "object") {
      fail(
        "Signed-feed validation dmg input must be an object",
        "SPARKLE_SIGNED_FEED_VALIDATION_INPUT_INVALID",
      );
    }
    const dmgBytes = Buffer.isBuffer(dmg.bytes) ? dmg.bytes : null;
    const dmgSize = dmg.size ?? dmgBytes?.length ?? null;
    if ((dmg.fileName !== undefined && dmg.fileName !== object.fileName)
        || (dmg.sha256 !== undefined && dmg.sha256 !== object.sha256)
        || (dmgSize !== null && dmgSize !== lengthNumber)) {
      fail(
        "Signed appcast enclosure URL, length, or checksum does not match the release DMG",
        "SPARKLE_SIGNED_FEED_ARTIFACT_MISMATCH",
      );
    }
    if (dmgBytes !== null && publicKey !== null) {
      let verified = false;
      try {
        verified = verify(null, dmgBytes, publicKey, enclosureSignature);
      } catch {
        verified = false;
      }
      if (!verified) {
        fail(
          "Signed appcast enclosure signature does not verify over the release DMG bytes",
          "SPARKLE_SIGNED_FEED_ARTIFACT_SIGNATURE_INVALID",
        );
      }
    }
  }

  return Object.freeze({
    bundleVersion,
    channelTitle,
    enclosure: Object.freeze({
      fileName: object.fileName,
      length: lengthNumber,
      objectKey: object.key,
      objectSha256: object.sha256,
      signature: attributes.get("sparkle:edSignature"),
      url: object.href,
    }),
    envelope: Object.freeze({
      length: declaredBytes,
      signature: trailer[1],
    }),
    itemTitle,
    minimumSystemVersion,
    pubDate,
    shortVersion,
  });
}
