import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBoundedMacOSPreviewHTTPS,
  MACOS_PREVIEW_REMOTE_CODES,
  validateSparkleAppcastXML,
} from "../scripts/lib/sparkle-remote-inspection.mjs";

const VERSION = "42";
const DIGEST = "a".repeat(64);
const ARTIFACT_URL = `https://updates.example.test/releases/${VERSION}/${DIGEST}/TiboTattle.dmg`;
const SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const ENCLOSURE = `<enclosure url="${ARTIFACT_URL}" length="123" sparkle:edSignature="${SIGNATURE}" />`;
const APPCAST = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel><item><sparkle:version>${VERSION}</sparkle:version>${ENCLOSURE}</item></channel>
</rss>`;
const OPTIONS = Object.freeze({
  expectedArtifactOrigin: "https://updates.example.test",
  expectedArtifactURL: ARTIFACT_URL,
  expectedBundleVersion: VERSION,
  requireContentAddressed: true,
  requireSingleFullDmg: true,
});

test("incoming Sparkle parser accepts one content-addressed full DMG", () => {
  const result = validateSparkleAppcastXML(APPCAST, OPTIONS);
  assert.equal(result.valid, true);
  assert.equal(result.enclosures.length, 1);
  assert.equal(result.enclosures[0].url, ARTIFACT_URL);
  assert.equal(result.enclosures[0].artifactSha256, DIGEST);
  assert.equal(result.enclosures[0].version, VERSION);
  assert.equal(result.enclosures[0].signatureStructurallyValid, true);
});

test("incoming Sparkle parser rejects malformed XML and enclosure metadata", () => {
  for (const invalid of [
    "<rss><channel>",
    APPCAST.replace('length="123"', 'length="not-a-number"'),
    APPCAST.replace(`sparkle:edSignature="${SIGNATURE}"`, 'sparkle:edSignature="bad"'),
    APPCAST.replace(`<sparkle:version>${VERSION}</sparkle:version>`,
      `<sparkle:version>${VERSION}</sparkle:version><sparkle:version>${VERSION}</sparkle:version>`),
    APPCAST.replace(`<sparkle:version>${VERSION}</sparkle:version>`,
      `<sparkle:version><value>${VERSION}</value></sparkle:version>`),
    APPCAST.replace(`sparkle:edSignature="${SIGNATURE}"`,
      `sparkle:version="999" sparkle:edSignature="${SIGNATURE}"`),
  ]) {
    assert.deepEqual(validateSparkleAppcastXML(invalid, OPTIONS), {
      reason: "invalid_xml_or_sparkle_structure", valid: false,
    });
  }
});

test("incoming Sparkle parser rejects a wrong candidate or ambiguous full DMG", () => {
  assert.equal(validateSparkleAppcastXML(APPCAST, {
    ...OPTIONS,
    expectedArtifactURL: ARTIFACT_URL.replace("TiboTattle.dmg", "other.dmg"),
  }).reason, "mismatched_url");
  assert.equal(validateSparkleAppcastXML(APPCAST.replace(ENCLOSURE, ENCLOSURE + ENCLOSURE), OPTIONS).reason,
    "single_full_dmg_required");
  assert.equal(validateSparkleAppcastXML(APPCAST.replace("TiboTattle.dmg", "TiboTattle.delta"), OPTIONS).valid,
    false);
});

test("bounded remote fetch rejects redirects and oversized bodies without fallback", async () => {
  const URL = "https://updates.example.test/appcast.xml";
  let calls = 0;
  await assert.rejects(
    fetchBoundedMacOSPreviewHTTPS(URL, {
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        return new Response(null, { status: 302, headers: { location: "https://other.example.test/" } });
      },
    }),
    { code: MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchBoundedMacOSPreviewHTTPS(URL, {
      maximumBytes: 8,
      fetchImpl: async () => new Response("123456789", { status: 200 }),
    }),
    { code: MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE },
  );
});
