import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INTERNAL_DOGFOOD_RELEASE_CHANNEL,
  resolveReleaseChannel,
} from "../config/release-channels.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerRequire = createRequire(join(root, "apps/worker/package.json"));
const { parse } = workerRequire("jsonc-parser");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonc(path) {
  return parse(await readFile(path, "utf8"));
}

test("dogfood guard deployment matches the reviewed release channel", async () => {
  const channel = resolveReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL);
  const contract = await readJson(join(
    root,
    "apps/worker/src/dogfood-sparkle-release-contract.json",
  ));
  const config = await readJsonc(join(
    root,
    "apps/worker/wrangler.dogfood.jsonc",
  ));

  assert.equal(config.main, "src/dogfood-update-guard.ts");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [{
    pattern: new URL(channel.sparkle.atomicGuardURL).hostname,
    custom_domain: true,
  }]);
  const intel = resolveReleaseChannel(INTERNAL_DOGFOOD_RELEASE_CHANNEL, { architecture: "x64" });
  assert.deepEqual(contract, {
    intel: {
      appcastURL: intel.sparkle.appcastURL,
      appcastObjectKey: intel.sparkle.appcastObjectKey,
      objectPrefix: intel.sparkle.objectPrefix,
    },
    schemaVersion: "usage-monitor-worker-sparkle-release-contract-v1",
    channel: channel.name,
    serviceOrigin: channel.serviceOrigin,
    guardOrigin: new URL(channel.sparkle.atomicGuardURL).origin,
    updateOrigin: channel.sparkle.origin,
    appcastURL: channel.sparkle.appcastURL,
    appcastObjectKey: channel.sparkle.appcastObjectKey,
    r2Bucket: channel.sparkle.r2Bucket,
    objectPrefix: channel.sparkle.objectPrefix,
    guardSchema: "usage-monitor-sparkle-appcast-atomic-guard-v1",
    guardRoute: new URL(channel.sparkle.atomicGuardURL).pathname,
    appcastContentType: "application/xml; charset=utf-8",
    appcastCacheControl: "public, max-age=300, must-revalidate",
    artifactContentType: "application/x-apple-diskimage",
    artifactCacheControl: "public, max-age=31536000, immutable",
  });
  assert.deepEqual(config.r2_buckets, [{
    binding: "SPARKLE_RELEASES",
    bucket_name: channel.sparkle.r2Bucket,
  }]);
  assert.equal(config.d1_databases.length, 1);
  assert.match(
    config.d1_databases[0].database_id,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  assert.deepEqual(config.vars, {
    SPARKLE_APPCAST_GUARD_MODE: "enabled",
    SPARKLE_APPCAST_GUARD_CHANNEL: contract.channel,
    SPARKLE_APPCAST_GUARD_BUCKET: contract.r2Bucket,
    SPARKLE_APPCAST_GUARD_APPCAST_KEY: contract.appcastObjectKey,
    SPARKLE_APPCAST_GUARD_ENDPOINT_PATH: contract.guardRoute,
    SPARKLE_APPCAST_GUARD_CONTENT_TYPE: contract.appcastContentType,
    SPARKLE_APPCAST_GUARD_CACHE_CONTROL: contract.appcastCacheControl,
    SPARKLE_APPCAST_GUARD_MAX_XML_BYTES: "1048576",
    SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY:
      "ITd8MScUmLiMB0ulDrDdAn4ofHp0e6UxTkXbpK8DSvQ=",
    SPARKLE_APPCAST_GUARD_PUBLIC_ED_KEY_SHA256:
      channel.sparkle.publicEdKeySha256,
  });
  assert.equal(
    Object.hasOwn(config.vars, "SPARKLE_APPCAST_GUARD_TOKEN"),
    false,
  );
});
