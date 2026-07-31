import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as application from "../src/application/index.js";
import * as applicationOwner from
  "../src/application/local-export-set-verification.js";
import * as compressionOwner from "../src/export/compression.js";
import * as exportIndex from "../src/export/index.js";
import * as schemaOwner from "../src/export/set-schema.js";
import * as verificationOwner from "../src/export/set-verification.js";
import * as legacyCompression from "../src/export-compression.js";
import * as legacySchema from "../src/export-set-schema.js";
import * as legacyVerifier from "../src/export-set-verifier.js";
import * as platform from "../src/platform/index.js";
import * as platformOwner from
  "../src/platform/export-set-verification-storage.js";
import { ExportResourceLimitError } from "../src/export/resource-policy.js";
import { BundleVerificationError } from "../src/export/bundle-verifier.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCHEMA_EXPORTS = Object.freeze([
  "EXPORT_SET_CHUNK_BASENAME_WIDTH",
  "EXPORT_SET_CONTRACT_VERSION",
  "EXPORT_SET_CONTRACT_VERSION_V0_1",
  "EXPORT_SET_CONTRACT_VERSION_V0_2",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2",
  "EXPORT_SET_MANIFEST_VERSION",
  "EXPORT_SET_MANIFEST_VERSION_V0_1",
  "EXPORT_SET_MANIFEST_VERSION_V0_2",
  "EXPORT_SET_ORDER_VERSION",
  "EXPORT_SET_PACKING_VERSION",
  "EXPORT_SET_PACKING_VERSION_V0_1",
  "EXPORT_SET_PACKING_VERSION_V0_2",
  "MAXIMUM_EXPORT_SET_CHUNKS",
  "assertValidExportSetManifest",
  "exportSetChunkBasenames",
  "exportSetChunkBundleBasename",
  "exportSetChunkReceiptBasename",
  "exportSetManifestSchema",
  "exportSetManifestSchemaV0_1",
  "exportSetManifestSchemaV0_2",
  "validateExportSetManifest",
]);
const COMPRESSION_EXPORTS = Object.freeze([
  "EXPORT_GZIP_PROFILE",
  "ExportCompressionError",
  "compressExportBytes",
  "decompressExportBytes",
]);

async function source(relativePath) {
  return readFile(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

test("export-set schema owner and compatibility API are exact identities", () => {
  assert.deepEqual(Object.keys(schemaOwner).sort(), [...SCHEMA_EXPORTS].sort());
  assert.deepEqual(Object.keys(legacySchema).sort(), [...SCHEMA_EXPORTS].sort());
  for (const name of SCHEMA_EXPORTS) {
    assert.equal(legacySchema[name], schemaOwner[name], name);
    assert.equal(exportIndex[name], schemaOwner[name], name);
  }
  assert.equal(
    schemaOwner.exportSetManifestSchema,
    schemaOwner.exportSetManifestSchemaV0_2,
  );
  const candidate = {
    schemaVersion: "invalid",
  };
  assert.equal(
    schemaOwner.assertValidExportSetManifest,
    legacySchema.assertValidExportSetManifest,
  );
  assert.throws(
    () => schemaOwner.assertValidExportSetManifest(candidate),
    /Privacy export-set manifest failed validation/u,
  );
});

test("shared compression owner and compatibility API preserve identity", () => {
  assert.deepEqual(
    Object.keys(compressionOwner).sort(),
    [...COMPRESSION_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(legacyCompression).sort(),
    [...COMPRESSION_EXPORTS].sort(),
  );
  for (const name of COMPRESSION_EXPORTS) {
    assert.equal(legacyCompression[name], compressionOwner[name], name);
    assert.equal(exportIndex[name], compressionOwner[name], name);
  }
});

test("verification, application, and platform owners expose reviewed APIs", () => {
  assert.deepEqual(Object.keys(verificationOwner).sort(), [
    "ExportSetVerificationError",
    "createLocalExportSetVerifier",
  ]);
  assert.deepEqual(Object.keys(legacyVerifier).sort(), [
    "ExportSetVerificationError",
    "verifyLocalExportSet",
  ]);
  assert.equal(
    legacyVerifier.ExportSetVerificationError,
    verificationOwner.ExportSetVerificationError,
  );
  assert.equal(
    exportIndex.ExportSetVerificationError,
    verificationOwner.ExportSetVerificationError,
  );
  assert.deepEqual(Object.keys(applicationOwner), [
    "createLocalExportSetVerificationContext",
  ]);
  assert.equal(
    application.createLocalExportSetVerificationContext,
    applicationOwner.createLocalExportSetVerificationContext,
  );
  assert.deepEqual(Object.keys(platformOwner), [
    "createExportSetVerificationStorageContext",
  ]);
  assert.equal(
    platform.createExportSetVerificationStorageContext,
    platformOwner.createExportSetVerificationStorageContext,
  );
});

test("schema and verification semantics are runtime-neutral owner code", async () => {
  for (const relativePath of [
    "src/export/set-schema.js",
    "src/export/set-verification.js",
  ]) {
    const text = await source(relativePath);
    assert.doesNotMatch(text, /(?:from|import\()\s*["']node:/u);
    assert.doesNotMatch(text, /\b(?:Buffer|process)\b/u);
    assert.doesNotMatch(
      text,
      /from\s*["']\.\.\/(?:application|platform|export-|storage)/u,
    );
  }
  const schema = await source("src/export/set-schema.js");
  assert.match(
    schema,
    /schemas\/export-set-v0\.1\/manifest\.schema\.json/u,
  );
  assert.match(
    schema,
    /schemas\/export-set-v0\.2\/manifest\.schema\.json/u,
  );
});

test("platform mechanics and flat modules respect the composition boundary", async () => {
  const storage = await source(
    "src/platform/export-set-verification-storage.js",
  );
  assert.match(storage, /from "node:fs\/promises"/u);
  assert.match(storage, /import\("node:sqlite"\)/u);
  assert.doesNotMatch(
    storage,
    /\.\.\/(?:application|export)(?:\/|["'])/u,
  );

  const schemaShim = await source("src/export-set-schema.js");
  assert.doesNotMatch(schemaShim, /\b(?:function|class)\b/u);
  assert.match(schemaShim, /from "\.\/export\/index\.js"/u);

  const compressionShim = await source("src/export-compression.js");
  assert.doesNotMatch(compressionShim, /\b(?:function|class)\b/u);
  assert.match(compressionShim, /from "\.\/export\/index\.js"/u);

  const verifierShim = await source("src/export-set-verifier.js");
  assert.doesNotMatch(verifierShim, /export (?:async )?function|export class/u);
  assert.match(verifierShim, /src\/application|\.\/application\/index\.js/u);
  assert.match(verifierShim, /\.\/platform\/index\.js/u);
});

test("local-review uses reviewed verifier composition and debt is removed", async () => {
  const localReview = await source("local-review/cli.js");
  assert.doesNotMatch(localReview, /src\/export-set-verifier\.js/u);
  assert.match(localReview, /createLocalExportSetVerificationContext/u);
  assert.match(localReview, /createExportSetVerificationStorageContext/u);

  const architecture = await source("scripts/check-architecture-boundaries.mjs");
  const baselineStart = architecture.indexOf(
    "const LOCAL_REVIEW_LEGACY_MIGRATION_TARGETS",
  );
  const baseline = architecture.slice(
    baselineStart,
    architecture.indexOf("]);", baselineStart) + 3,
  );
  assert.doesNotMatch(baseline, /src\/export-set-verifier\.js/u);
  assert.equal((baseline.match(/"src\//gu) ?? []).length, 3);
});

test("schema validation collapses hostile getters to fixed diagnostics", () => {
  const canary = "/private/manifest/DO_NOT_EXPOSE";
  const hostile = new Proxy({}, {
    get() {
      throw new Error(canary);
    },
  });
  const result = schemaOwner.validateExportSetManifest(hostile);
  assert.deepEqual(result, {
    valid: false,
    errors: [{
      path: "/",
      keyword: "invariant",
      schemaPath: "#/x-invariant/readable-input",
    }],
  });
  assert.throws(
    () => schemaOwner.assertValidExportSetManifest(hostile),
    (error) => !error.message.includes(canary)
      && /Privacy export-set manifest failed validation/u.test(error.message),
  );
});

test("verification config and invoked storage ports cannot leak canaries", async () => {
  const canary = "/private/config/DO_NOT_EXPOSE";
  const trapBind = (operation) => new Proxy(operation, {
    get(target, property, receiver) {
      if (property === "bind") throw new Error(canary);
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => verificationOwner.createLocalExportSetVerifier({
      get storage() {
        throw new Error(canary);
      },
    }),
    (error) => error instanceof TypeError && !error.message.includes(canary),
  );

  const base = platformOwner.createExportSetVerificationStorageContext();
  const verifier = verificationOwner.createLocalExportSetVerifier({
    storage: {
      ...base,
      async inspectOwnerDirectory() {
        throw new Proxy({}, {
          getPrototypeOf() {
            throw new Error(canary);
          },
        });
      },
    },
    bundleVerification: {
      async loadVerifiedLocalMetadataBundleBytes() {},
      async loadVerifiedLocalMetadataBundleFiles() {},
    },
    exportCompatibilityTuple() {
      return {};
    },
    manifestBasename: "manifest.json",
    manifestReceiptBasename: "manifest.receipt.json",
  });
  await assert.rejects(
    verifier.verifyLocalExportSet({ directory: "/ignored" }),
    (error) => error instanceof verificationOwner.ExportSetVerificationError
      && error.code === "export_set_verify_directory"
      && !error.message.includes(canary),
  );
  await assert.rejects(
    verifier.verifyLocalExportSet(new Proxy({}, {
      get() {
        throw new Error(canary);
      },
    })),
    (error) => error instanceof TypeError && !error.message.includes(canary),
  );

  const callableVerifier = verificationOwner.createLocalExportSetVerifier({
    storage: {
      ...base,
      artifactPath: trapBind(base.artifactPath),
    },
    bundleVerification: {
      loadVerifiedLocalMetadataBundleBytes: trapBind(async () => {}),
      loadVerifiedLocalMetadataBundleFiles: trapBind(async () => {}),
    },
    exportCompatibilityTuple() {
      return {};
    },
    manifestBasename: "manifest.json",
    manifestReceiptBasename: "manifest.receipt.json",
  });
  await assert.rejects(
    callableVerifier.verifyLocalExportSet({
      directory: "/definitely-not-a-real-export-set",
    }),
    (error) => error instanceof verificationOwner.ExportSetVerificationError
      && error.code === "export_set_verify_directory"
      && !error.message.includes(canary),
  );

  assert.throws(
    () => platformOwner.createExportSetVerificationStorageContext(
      new Proxy({}, {
        get() {
          throw new Error(canary);
        },
      }),
    ),
    (error) => error instanceof TypeError && !error.message.includes(canary),
  );
  await assert.rejects(
    base.inspectOwnerDirectory(new Proxy({}, {
      get() {
        throw new Error(canary);
      },
    })),
    (error) => error instanceof TypeError && !error.message.includes(canary),
  );
  assert.throws(
    () => compressionOwner.compressExportBytes(
      new Uint8Array([1]),
      new Proxy({}, {
        get() {
          throw new Error(canary);
        },
      }),
    ),
    (error) => error instanceof TypeError && !error.message.includes(canary),
  );
});

test("forged and subclassed reviewed errors are collapsed for every class", async () => {
  const canary = "/private/error/DO_NOT_EXPOSE";
  const reviewed = [
    {
      Class: BundleVerificationError,
      code: "bundle_input",
      name: "BundleVerificationError",
      publicCode: "bundle_input",
    },
    {
      Class: compressionOwner.ExportCompressionError,
      code: "gzip",
      name: "ExportCompressionError",
      publicCode: "export_compression_gzip",
    },
    {
      Class: ExportResourceLimitError,
      code: "rss",
      name: "ExportResourceLimitError",
      publicCode: "export_resource_rss",
    },
    {
      Class: verificationOwner.ExportSetVerificationError,
      code: "directory",
      name: "ExportSetVerificationError",
      publicCode: "export_set_verify_directory",
    },
  ];
  const candidates = [];
  for (const entry of reviewed) {
    const forged = new Error(canary);
    Object.setPrototypeOf(forged, entry.Class.prototype);
    forged.name = entry.name;
    forged.code = entry.publicCode;
    candidates.push(forged);
    class Subclass extends entry.Class {}
    candidates.push(new Subclass(entry.code));
    candidates.push(new Proxy(new entry.Class(entry.code), {}));
  }

  const base = platformOwner.createExportSetVerificationStorageContext();
  for (const candidate of candidates) {
    const verifier = verificationOwner.createLocalExportSetVerifier({
      storage: {
        ...base,
        async inspectOwnerDirectory() {
          throw candidate;
        },
      },
      bundleVerification: {
        async loadVerifiedLocalMetadataBundleBytes() {},
        async loadVerifiedLocalMetadataBundleFiles() {},
      },
      exportCompatibilityTuple() {
        return {};
      },
      manifestBasename: "manifest.json",
      manifestReceiptBasename: "manifest.receipt.json",
    });
    await assert.rejects(
      verifier.verifyLocalExportSet({ directory: "/ignored" }),
      (error) => error instanceof verificationOwner.ExportSetVerificationError
        && Object.getPrototypeOf(error)
          === verificationOwner.ExportSetVerificationError.prototype
        && error.code === "export_set_verify_directory"
        && !error.message.includes(canary),
    );
  }
});

test("canonical read faults are mapped without exposing paths or canaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "set-verification-read-fault-"));
  const basename = "manifest.json";
  const artifact = join(root, basename);
  const canary = `${root}/DO_NOT_EXPOSE`;
  try {
    await writeFile(artifact, "{}", { mode: 0o600 });
    const probe = await open(artifact, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    t.mock.method(fileHandlePrototype, "readFile", async () => {
      throw new Error(canary);
    });
    const storage =
      platformOwner.createExportSetVerificationStorageContext();
    await assert.rejects(
      storage.readCanonicalArtifact({
        root,
        basename,
        label: "manifest",
        maximumBytes: 1024,
        canonicalJson: JSON.stringify,
        createError: (code) =>
          new verificationOwner.ExportSetVerificationError(code),
      }),
      (error) => error instanceof verificationOwner.ExportSetVerificationError
        && error.code === "export_set_verify_manifest_changed"
        && !error.message.includes(root)
        && !error.message.includes(canary),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification-index setup failures close and remove partial state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "set-verification-index-fault-"));
  const canary = `${root}/DO_NOT_EXPOSE`;
  try {
    const probeFile = join(root, "probe");
    const probe = await open(probeFile, "w", 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    await rm(probeFile, { force: true });
    t.mock.method(fileHandlePrototype, "chmod", async () => {
      throw new Error(canary);
    });
    const storage =
      platformOwner.createExportSetVerificationStorageContext();
    await assert.rejects(
      storage.createUniquenessIndex({
        maximumBytes: 1024 * 1024,
        batchLimitRecords: 10,
        temporaryRoot: root,
        observeWorkspace() {},
        createError: (code) =>
          new verificationOwner.ExportSetVerificationError(code),
        createLimitError: (code) => new ExportResourceLimitError(code),
        isResourceLimitError() {
          throw new Error(canary);
        },
      }),
      (error) => error instanceof verificationOwner.ExportSetVerificationError
        && error.code === "export_set_verify_verification_index"
        && !error.message.includes(canary)
        && !error.message.includes(root),
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
