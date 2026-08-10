/**
 * Cross-gate drift and mutation tests for the official signed Sparkle feed
 * validator (scripts/sparkle-signed-feed-validation.js).
 *
 * Three duties:
 *   1. Accept the exact byte shape the pinned Sparkle 2.9.3 generate_appcast
 *      emits (fixture adapted from officialSignedAppcastBytes in
 *      apps/worker/test/sparkle-appcast-guard.spec.ts, signed with an
 *      in-test Ed25519 keypair — never a production key).
 *   2. Reject every single-field mutation with its named failure reason.
 *   3. Pin the validator's regex literals CHARACTER-IDENTICAL to the Worker
 *      guard's parseOfficialSignedSparkleAppcast
 *      (apps/worker/src/sparkle-appcast-guard.ts), so any future guard edit
 *      fails this test loudly instead of silently diverging from the local
 *      release gate.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getReleaseChannel } from "../config/release-channels.js";
import {
  OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN,
  SPARKLE_SIGNED_FEED_TRAILER_PATTERN,
  hasSparkleSignedFeedTrailer,
  validateSignedSparkleFeed,
} from "../scripts/sparkle-signed-feed-validation.js";
import { validateCandidateAppcastShape } from "../scripts/publish-sparkle-update.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const GUARD_SOURCE_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "src",
  "sparkle-appcast-guard.ts",
);
const VALIDATOR_SOURCE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "sparkle-signed-feed-validation.js",
);

const STABLE_CHANNEL = getReleaseChannel("stable");
const UPDATE_ORIGIN = STABLE_CHANNEL.sparkle.origin;
const OBJECT_PREFIX = STABLE_CHANNEL.sparkle.objectPrefix;

const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_PUBLIC_ED_KEY = TEST_KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
const OTHER_KEY_PAIR = generateKeyPairSync("ed25519");

const ARTIFACT_BYTES = Buffer.from("official-signed-feed-test-dmg");
const ARTIFACT_FILE_NAME = "TiboTattle-0.1.0-macOS-arm64.dmg";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Exact document shape of the pinned generate_appcast output, adapted from
 * the Worker spec's officialSignedAppcastBytes builder (same text, same
 * whitespace), signed with the in-test keypair.
 */
function officialSignedAppcastText({
  artifactBytes = ARTIFACT_BYTES,
  artifactSignatureOver = null,
  bundleVersion = "1",
  enclosureSuffix = "",
  fileName = ARTIFACT_FILE_NAME,
  mutatePrefix = (value) => value,
  mutateSigned = (value) => value,
  shortVersion = "0.1.0",
  urlDigest = null,
} = {}) {
  const digest = urlDigest ?? sha256(artifactBytes);
  const artifactSignature = sign(
    null,
    artifactSignatureOver ?? artifactBytes,
    TEST_KEY_PAIR.privateKey,
  ).toString("base64");
  const prefix = mutatePrefix(`<?xml version="1.0" standalone="yes"?><!-- sparkle-sign-warning:
IMPORTANT: This file was signed by Sparkle. Any modifications to this file requires re-signing this file with generate_appcast or sign_update! The signed signature will be embedded at the end of this file.
--><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>TiboTattle</title>
        <item>
            <title>${shortVersion}</title>
            <pubDate>Wed, 05 Aug 2026 14:55:05 -0400</pubDate>
            <sparkle:version>${bundleVersion}</sparkle:version>
            <sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${UPDATE_ORIGIN}/${OBJECT_PREFIX}/${bundleVersion}/${digest}/${fileName}" length="${artifactBytes.length}" type="application/octet-stream" sparkle:edSignature="${artifactSignature}"${enclosureSuffix}></enclosure>
        </item>
    </channel>
</rss>`);
  const prefixBytes = Buffer.from(prefix, "utf8");
  const envelopeSignature = sign(null, prefixBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  return mutateSigned(`${prefix}<!-- sparkle-signatures:
edSignature: ${envelopeSignature}
length: ${prefixBytes.length}
-->
`);
}

function validate(text, overrides = {}) {
  return validateSignedSparkleFeed({
    appcastText: text,
    dmg: {
      bytes: ARTIFACT_BYTES,
      fileName: ARTIFACT_FILE_NAME,
      sha256: sha256(ARTIFACT_BYTES),
      size: ARTIFACT_BYTES.length,
    },
    objectPrefix: OBJECT_PREFIX,
    publicEdKey: TEST_PUBLIC_ED_KEY,
    updateOrigin: UPDATE_ORIGIN,
    ...overrides,
  });
}

test("accepts the exact official generate_appcast byte shape", () => {
  const text = officialSignedAppcastText();
  const validated = validate(text);
  assert.equal(validated.bundleVersion, "1");
  assert.equal(validated.shortVersion, "0.1.0");
  assert.equal(validated.channelTitle, "TiboTattle");
  assert.equal(validated.minimumSystemVersion, "13.0");
  assert.equal(validated.enclosure.fileName, ARTIFACT_FILE_NAME);
  assert.equal(validated.enclosure.length, ARTIFACT_BYTES.length);
  assert.equal(validated.enclosure.objectSha256, sha256(ARTIFACT_BYTES));
  assert.equal(
    validated.enclosure.url,
    `${UPDATE_ORIGIN}/${OBJECT_PREFIX}/1/${sha256(ARTIFACT_BYTES)}/${ARTIFACT_FILE_NAME}`,
  );
  assert.equal(
    validated.envelope.length,
    Buffer.byteLength(text.slice(0, text.indexOf("<!-- sparkle-signatures:"))),
  );
  assert.equal(hasSparkleSignedFeedTrailer(text), true);
  // Cross-gate: the same bytes must also pass the publisher's own stable
  // candidate shape validation, so generator, publisher, and Worker guard
  // agree on one shape.
  const enclosures = validateCandidateAppcastShape(text, "stable");
  assert.equal(enclosures.length, 1);
  assert.equal(enclosures[0].version, "1");
});

test("works without a public key (structure-only) and without dmg context", () => {
  const text = officialSignedAppcastText();
  const validated = validateSignedSparkleFeed({
    appcastText: text,
    objectPrefix: OBJECT_PREFIX,
    updateOrigin: UPDATE_ORIGIN,
  });
  assert.equal(validated.bundleVersion, "1");
});

test("rejects a title tampered after signing (envelope no longer verifies)", () => {
  // Same-length swap: the declared trailer length still matches, so the
  // named failure is specifically the Ed25519 envelope.
  const text = officialSignedAppcastText().replace(
    "<title>TiboTattle</title>",
    "<title>TiboTattlX</title>",
  );
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_ENVELOPE_SIGNATURE_INVALID" },
  );
});

test("rejects a wrong declared trailer length", () => {
  const text = officialSignedAppcastText().replace(
    /\nlength: ([0-9]+)\n/u,
    (match, digits) => `\nlength: ${Number(digits) + 1}\n`,
  );
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_LENGTH_MISMATCH" },
  );
});

test("rejects a truncated trailer", () => {
  const text = officialSignedAppcastText().replace(/-->\n$/u, "");
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_TRAILER_MISSING" },
  );
});

test("rejects an unsigned minimal document outright", () => {
  const unsigned = `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><item>
<enclosure url="${UPDATE_ORIGIN}/${OBJECT_PREFIX}/1/${sha256(ARTIFACT_BYTES)}/${ARTIFACT_FILE_NAME}" length="${ARTIFACT_BYTES.length}" sparkle:version="1" sparkle:edSignature="${sign(null, ARTIFACT_BYTES, TEST_KEY_PAIR.privateKey).toString("base64")}" />
</item></channel></rss>
`;
  assert.equal(hasSparkleSignedFeedTrailer(unsigned), false);
  assert.throws(
    () => validate(unsigned),
    { code: "SPARKLE_SIGNED_FEED_TRAILER_MISSING" },
  );
});

test("rejects a signed document that is not the official shape", () => {
  const text = officialSignedAppcastText({
    mutatePrefix: (value) => value.replace(
      /\s*<sparkle:hardwareRequirements>arm64<\/sparkle:hardwareRequirements>/u,
      "",
    ),
  });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_SHAPE_INVALID" },
  );
});

test("rejects a delta-carrying signed document", () => {
  const text = officialSignedAppcastText({
    mutatePrefix: (value) => value.replace(
      "</item>",
      `<sparkle:deltas><enclosure url="${UPDATE_ORIGIN}/${OBJECT_PREFIX}/1/${sha256("delta")}/delta.delta" length="4" sparkle:deltaFrom="0" sparkle:edSignature="${sign(null, Buffer.from("delt"), TEST_KEY_PAIR.privateKey).toString("base64")}" /></sparkle:deltas></item>`,
    ),
  });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_SHAPE_INVALID" },
  );
});

test("rejects an enclosure with an extra attribute", () => {
  const text = officialSignedAppcastText({
    enclosureSuffix: ' sparkle:deltaFrom="0"',
  });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_ENCLOSURE_INVALID" },
  );
});

test("rejects an enclosure URL off the reviewed update origin", () => {
  const text = officialSignedAppcastText({
    mutatePrefix: (value) => value.replaceAll(
      UPDATE_ORIGIN,
      "https://updates.example.test",
    ),
  });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_ENCLOSURE_URL_INVALID" },
  );
});

test("rejects an enclosure whose content address disagrees with the DMG", () => {
  const text = officialSignedAppcastText({ urlDigest: "a".repeat(64) });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_ARTIFACT_MISMATCH" },
  );
});

test("rejects an enclosure signature made over different bytes", () => {
  const text = officialSignedAppcastText({
    artifactSignatureOver: Buffer.from("some-other-artifact"),
  });
  assert.throws(
    () => validate(text),
    { code: "SPARKLE_SIGNED_FEED_ARTIFACT_SIGNATURE_INVALID" },
  );
});

test("rejects a feed signed by a different key", () => {
  const otherPublic = OTHER_KEY_PAIR.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const text = officialSignedAppcastText();
  assert.throws(
    () => validate(text, { publicEdKey: otherPublic }),
    { code: "SPARKLE_SIGNED_FEED_ENVELOPE_SIGNATURE_INVALID" },
  );
});

test("rejects a malformed public key input", () => {
  assert.throws(
    () => validate(officialSignedAppcastText(), { publicEdKey: "not-a-key" }),
    { code: "SPARKLE_SIGNED_FEED_PUBLIC_KEY_INVALID" },
  );
});

// ---------------------------------------------------------------------------
// Regex drift gate: the validator's two literals must be CHARACTER-IDENTICAL
// to the Worker guard's. Extraction walks the source text so escapes and
// character classes (which may contain unescaped "/") are handled.

function extractRegexLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `regex marker not found: ${marker}`);
  const start = source.indexOf("/", markerIndex + marker.length);
  assert.notEqual(start, -1, `regex literal not found after: ${marker}`);
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
    } else if (character === "[") {
      inClass = true;
    } else if (character === "/") {
      break;
    }
    index += 1;
  }
  assert.equal(source[index], "/", `unterminated regex literal after: ${marker}`);
  let end = index + 1;
  while (end < source.length && /[a-z]/u.test(source[end])) end += 1;
  return source.slice(start, end);
}

test("validator regex literals are character-identical to the Worker guard", async () => {
  const [guardSource, validatorSource] = await Promise.all([
    readFile(GUARD_SOURCE_PATH, "utf8"),
    readFile(VALIDATOR_SOURCE_PATH, "utf8"),
  ]);
  const guardTrailer = extractRegexLiteral(guardSource, "const trailer = ");
  const guardOfficial = extractRegexLiteral(guardSource, "const official = ");
  const validatorTrailer = extractRegexLiteral(
    validatorSource,
    "SPARKLE_SIGNED_FEED_TRAILER_PATTERN = ",
  );
  const validatorOfficial = extractRegexLiteral(
    validatorSource,
    "OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN = ",
  );
  assert.equal(
    validatorTrailer,
    guardTrailer,
    "sparkle-signed-feed-validation.js trailer regex drifted from the Worker guard; update the mirror to match apps/worker/src/sparkle-appcast-guard.ts exactly",
  );
  assert.equal(
    validatorOfficial,
    guardOfficial,
    "sparkle-signed-feed-validation.js official-shape regex drifted from the Worker guard; update the mirror to match apps/worker/src/sparkle-appcast-guard.ts exactly",
  );
  // The extracted literals are the ones actually exported (guards against a
  // second stray definition shadowing the compared text).
  assert.equal(
    validatorTrailer,
    `/${SPARKLE_SIGNED_FEED_TRAILER_PATTERN.source}/${SPARKLE_SIGNED_FEED_TRAILER_PATTERN.flags}`,
  );
  assert.equal(
    validatorOfficial,
    `/${OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN.source}/${OFFICIAL_SIGNED_SPARKLE_APPCAST_PATTERN.flags}`,
  );
});
