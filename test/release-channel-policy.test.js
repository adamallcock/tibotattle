import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import {
  INTERNAL_DOGFOOD_RELEASE_CHANNEL,
  INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
  RELEASE_CHANNELS_SCHEMA_VERSION,
  STABLE_RELEASE_CHANNEL,
  STABLE_SERVICE_ORIGIN_MODE,
  assertReleaseChannelConfiguration,
  assertReleaseChannelPublication,
  createReleaseChannelProvenance,
  getReleaseChannel,
  resolveReleaseChannel,
} from "../config/release-channels.js";
import { parseArguments as parseReleaseArguments } from "../scripts/release-macos-app.js";
import {
  parseSparkleUpdatePublisherArguments,
} from "../scripts/publish-sparkle-update.js";

const STABLE = getReleaseChannel(STABLE_RELEASE_CHANNEL);
const TEST_PUBLIC_KEY_SHA256 = "a".repeat(64);

function dedicatedDogfoodChannel() {
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
    name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    configured: true,
    buildManifestChannel: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    serviceOriginMode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
    serviceOrigin: "https://dogfood.tibotattle.example",
    publicWebsiteOrigin: "https://dogfood.tibotattle.example",
    sparkle: {
      origin: "https://updates.dogfood.tibotattle.example",
      appcastURL:
        "https://updates.dogfood.tibotattle.example/internal-dogfood/appcast.xml",
      appcastObjectKey: "internal-dogfood/appcast.xml",
      r2Bucket: "tibotattle-dogfood-updates",
      objectPrefix: "internal-dogfood/releases",
      publicEdKeySha256: "b".repeat(64),
    },
  };
}

function stablePublication() {
  return createReleaseChannelProvenance(STABLE_RELEASE_CHANNEL, {
    publicEdKeySha256: TEST_PUBLIC_KEY_SHA256,
  });
}

test("stable channel remains exactly bound to the reviewed deployment manifest", () => {
  assert.equal(STABLE.configured, true);
  assert.equal(STABLE.serviceOriginMode, STABLE_SERVICE_ORIGIN_MODE);
  assert.equal(STABLE.serviceOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(STABLE.publicWebsiteOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(STABLE.sparkle.origin, DEPLOYMENT_ENDPOINTS.sparkle.origin);
  assert.equal(STABLE.sparkle.appcastURL, DEPLOYMENT_ENDPOINTS.sparkle.appcastURL);
  assert.equal(STABLE.sparkle.r2Bucket, DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket);
  assert.equal(STABLE.sparkle.appcastObjectKey, "appcast.xml");
  assert.equal(STABLE.sparkle.objectPrefix, "releases");
  assert.deepEqual(STABLE.sparkle.keyContinuity, {
    mode: "previous_stable_manifest_required",
    bootstrap: "explicit_owner_only",
  });
});

test("internal dogfood is visible to observers but cannot resolve operationally without owner configuration", () => {
  const dogfood = getReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL);
  assert.equal(dogfood.configured, false);
  assert.equal(dogfood.serviceOriginMode, null);
  assert.equal(dogfood.serviceOrigin, null);
  assert.equal(dogfood.publicWebsiteOrigin, null);
  assert.deepEqual(dogfood.sparkle, {
    origin: null,
    appcastURL: null,
    appcastObjectKey: null,
    r2Bucket: null,
    objectPrefix: null,
    publicEdKeySha256: null,
    keyContinuity: null,
  });
  assert.throws(
    () => resolveReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL),
    { code: "RELEASE_CHANNEL_NOT_CONFIGURED" },
  );
});

test("dogfood rejects copied production endpoints, paths, and keys", () => {
  const unconfiguredWithProduction = {
    ...getReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL),
    serviceOrigin: STABLE.serviceOrigin,
  };
  assert.throws(
    () => assertReleaseChannelConfiguration(unconfiguredWithProduction),
    { code: "RELEASE_CHANNEL_DOGFOOD_NOT_CONFIGURED" },
  );

  const copied = {
    ...STABLE,
    name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    buildManifestChannel: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    serviceOriginMode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
    sparkle: { ...STABLE.sparkle, publicEdKeySha256: TEST_PUBLIC_KEY_SHA256 },
  };
  assert.throws(
    () => assertReleaseChannelConfiguration(copied),
    { code: "RELEASE_CHANNEL_PRODUCTION_COLLISION" },
  );
});

test("a reviewed dedicated dogfood policy keeps every publication identifier separate", () => {
  const dogfood = dedicatedDogfoodChannel();
  assert.equal(assertReleaseChannelConfiguration(dogfood), dogfood);
  const publication = {
    name: dogfood.name,
    serviceOriginMode: dogfood.serviceOriginMode,
    serviceOrigin: dogfood.serviceOrigin,
    publicWebsiteOrigin: dogfood.publicWebsiteOrigin,
    sparkle: { ...dogfood.sparkle },
  };
  assert.equal(assertReleaseChannelPublication(dogfood, publication), dogfood);

  for (const mutate of [
    (value) => ({ ...value, name: STABLE_RELEASE_CHANNEL }),
    (value) => ({
      ...value,
      sparkle: {
        ...value.sparkle,
        appcastURL: STABLE.sparkle.appcastURL,
      },
    }),
    (value) => ({
      ...value,
      sparkle: { ...value.sparkle, r2Bucket: STABLE.sparkle.r2Bucket },
    }),
  ]) {
    assert.throws(
      () => assertReleaseChannelPublication(dogfood, mutate(publication)),
      { code: "RELEASE_CHANNEL_PUBLICATION_MISMATCH" },
    );
  }
});

test("package and publisher CLIs require explicit named channel consent", () => {
  assert.throws(
    () => parseReleaseArguments(["--app", "TiboTattle.app"]),
    /--channel is required/u,
  );
  assert.throws(
    () => parseReleaseArguments([
      "--app", "TiboTattle.app",
      "--channel", INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    ]),
    { code: "RELEASE_CHANNEL_NOT_CONFIGURED" },
  );
  const bootstrapRelease = parseReleaseArguments([
    "--app", "TiboTattle.app",
    "--channel", STABLE_RELEASE_CHANNEL,
    "--stable-bootstrap",
  ]);
  assert.equal(bootstrapRelease.stableBootstrap, true);
  assert.throws(
    () => parseReleaseArguments([
      "--app", "TiboTattle.app",
      "--channel", STABLE_RELEASE_CHANNEL,
      "--previous-stable-manifest", "previous.json",
      "--stable-bootstrap",
    ]),
    /cannot be combined/u,
  );
  const publisherArguments = [
    "--bucket", STABLE.sparkle.r2Bucket,
    "--dmg", "release.dmg",
    "--appcast", "appcast.xml",
    "--release-manifest", "release.json",
    "--sparkle-public-ed-key", "a".repeat(44),
  ];
  assert.throws(
    () => parseSparkleUpdatePublisherArguments(publisherArguments),
    /--channel is required/u,
  );
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      ...publisherArguments,
      "--channel", INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    ]),
    { code: "RELEASE_CHANNEL_NOT_CONFIGURED" },
  );
  const bootstrapPublisher = parseSparkleUpdatePublisherArguments([
    ...publisherArguments,
    "--channel", STABLE_RELEASE_CHANNEL,
    "--stable-bootstrap",
  ]);
  assert.equal(bootstrapPublisher.stableBootstrap, true);
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      ...publisherArguments,
      "--channel", STABLE_RELEASE_CHANNEL,
      "--previous-stable-manifest", "previous.json",
      "--stable-bootstrap",
    ]),
    { code: "MACOS_STABLE_BOOTSTRAP_INVALID" },
  );
});

test("stable publication provenance rejects a wrong feed or bucket", () => {
  const publication = stablePublication();
  assert.throws(
    () => assertReleaseChannelPublication(STABLE_RELEASE_CHANNEL, {
      ...publication,
      sparkle: {
        ...publication.sparkle,
        appcastURL: "https://updates.example.invalid/appcast.xml",
      },
    }),
    { code: "RELEASE_CHANNEL_PUBLICATION_MISMATCH" },
  );
  assert.throws(
    () => assertReleaseChannelPublication(STABLE_RELEASE_CHANNEL, {
      ...publication,
      sparkle: {
        ...publication.sparkle,
        r2Bucket: "wrong-bucket",
      },
    }),
    { code: "RELEASE_CHANNEL_PUBLICATION_MISMATCH" },
  );
});
