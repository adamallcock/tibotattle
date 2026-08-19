import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLocalMetadataBundleVerificationContext,
} from "../src/application/index.js";
import * as legacyVerifier from "../src/bundle-verifier.js";
import * as canonicalJson from "../src/export/canonical-json.js";
import * as verification from "../src/export/bundle-verification.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import * as legacyPrivacy from "../src/export-privacy.js";
import * as legacySchema from "../src/export-schema.js";
import * as platform from "../src/platform/index.js";
import * as storage from "../src/storage.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const VERIFICATION_EXPORTS = Object.freeze([
  "BundleVerificationError",
  "LOCAL_METADATA_BUNDLE_VERIFICATION_LIMITS",
  "assertValidExportRecord",
  "createLocalMetadataBundleByteVerifier",
  "createPrivacySafeBundleVerifier",
  "exportSchemas",
  "inspectSensitiveExportStrings",
  "validateExportRecord",
]);
const LEGACY_VERIFIER_EXPORTS = Object.freeze([
  "BundleVerificationError",
  "loadVerifiedLocalMetadataBundleBytes",
  "loadVerifiedLocalMetadataBundleFiles",
  "verifyLocalMetadataBundleFiles",
]);
const SCHEMA_EXPORTS = Object.freeze([
  "assertValidExportRecord",
  "exportSchemas",
  "validateExportRecord",
]);

function fakeReviewPairStorage({ reader }) {
  return Object.freeze({
    contractVersion: "windows-review-pair-storage-v1",
    writeReviewPair: async () => ({ status: "published" }),
    readReviewPair: reader,
    recoverReviewPairTransactions: async () => ({ recovered: 0, transactionsFound: 0 }),
    recoverOwnerOnlyPairTransactions: async () => ({ recovered: 0, transactionsFound: 0 }),
    writeOwnerOnlyPairNoClobber: async () => ({ status: "published" }),
    readOwnerOnlyLocalMetadataBundlePair: reader,
  });
}

test("bundle verification owners expose exact APIs and legacy identities", () => {
  assert.deepEqual(
    Object.keys(verification).sort(),
    [...VERIFICATION_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(legacyVerifier).sort(),
    [...LEGACY_VERIFIER_EXPORTS].sort(),
  );
  assert.equal(
    legacyVerifier.BundleVerificationError,
    verification.BundleVerificationError,
  );
  assert.deepEqual(Object.keys(legacySchema).sort(), [...SCHEMA_EXPORTS]);
  for (const name of SCHEMA_EXPORTS) {
    assert.equal(legacySchema[name], verification[name], name);
  }
  assert.equal(
    legacyPrivacy.inspectSensitiveExportStrings,
    verification.inspectSensitiveExportStrings,
  );
  assert.deepEqual(Object.keys(canonicalJson), ["stableJson"]);
  assert.equal(storage.stableJson, canonicalJson.stableJson);
});

test("application composition injects exact file and hash ports", async () => {
  const calls = [];
  const context = createLocalMetadataBundleVerificationContext({
    readOwnerOnlyLocalMetadataBundlePair: async (options) => {
      calls.push(options);
      return {
        bundleBytes: new Uint8Array([123]),
        receiptBytes: new Uint8Array([123]),
      };
    },
    sha256Hex: () => "0".repeat(64),
    compatibilityTuple: exportCompatibilityTuple,
  });

  await assert.rejects(
    context.verifyLocalMetadataBundleFiles({
      bundleFile: "/private/bundle.json",
      receiptFile: "/private/receipt.json",
    }),
    (error) =>
      error instanceof verification.BundleVerificationError
      && error.code === "receipt_json",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bundleFile, "/private/bundle.json");
  assert.equal(calls[0].receiptFile, "/private/receipt.json");
  assert.equal(calls[0].maximumBundleBytes, 32 * 1024 * 1024);
  assert.equal(calls[0].maximumReceiptBytes, 1024 * 1024);
  assert.equal(
    calls[0].createError("paths_required")
      instanceof verification.BundleVerificationError,
    true,
  );
  assert.equal(typeof platform.sha256Hex, "function");
  assert.equal(
    typeof platform.readOwnerOnlyLocalMetadataBundlePair,
    "function",
  );
});

test("Windows bundle verification uses only the reviewed injected reader", async () => {
  const calls = [];
  const fallbackCalls = [];
  const storage = fakeReviewPairStorage({
    reader: async (options) => {
      calls.push(options);
      return {
        bundleBytes: new Uint8Array([123]),
        receiptBytes: new Uint8Array([123]),
      };
    },
  });
  const context = createLocalMetadataBundleVerificationContext({
    platformName: () => "windows",
    reviewPairStorage: storage,
    reviewPairStorageValidator: (candidate) => candidate === storage,
    readOwnerOnlyLocalMetadataBundlePair: async () => {
      fallbackCalls.push(true);
      throw new Error("POSIX fallback must not be called");
    },
    sha256Hex: () => "0".repeat(64),
    compatibilityTuple: exportCompatibilityTuple,
  });

  await assert.rejects(
    context.verifyLocalMetadataBundleFiles({
      bundleFile: "C:\\reviews\\bundle.json",
      receiptFile: "C:\\reviews\\receipt.json",
    }),
    (error) => error instanceof verification.BundleVerificationError
      && error.code === "receipt_json",
  );
  assert.equal(calls.length, 1);
  assert.equal(fallbackCalls.length, 0);
  assert.equal(calls[0].maximumBundleBytes, 32 * 1024 * 1024);
  assert.equal(calls[0].maximumReceiptBytes, 1024 * 1024);
});

test("Windows bundle verification fails closed without a reviewed reader", async () => {
  const fallbackCalls = [];
  const context = createLocalMetadataBundleVerificationContext({
    platformName: () => "windows",
    readOwnerOnlyLocalMetadataBundlePair: async () => {
      fallbackCalls.push(true);
      throw new Error("POSIX fallback must not be called");
    },
    sha256Hex: () => "0".repeat(64),
    compatibilityTuple: exportCompatibilityTuple,
  });

  await assert.rejects(
    context.verifyLocalMetadataBundleFiles({
      bundleFile: "C:\\reviews\\bundle.json",
      receiptFile: "C:\\reviews\\receipt.json",
    }),
    (error) => error instanceof TypeError
      && error.message === "Windows review pair storage reader is required",
  );
  assert.equal(fallbackCalls.length, 0);
});

test("macOS bundle verification retains the default reader when a Windows port is present", async () => {
  const injectedCalls = [];
  const fallbackCalls = [];
  const storage = fakeReviewPairStorage({
    reader: async () => {
      injectedCalls.push(true);
      return { bundleBytes: new Uint8Array([123]), receiptBytes: new Uint8Array([123]) };
    },
  });
  const context = createLocalMetadataBundleVerificationContext({
    platformName: () => "macos",
    reviewPairStorage: storage,
    readOwnerOnlyLocalMetadataBundlePair: async () => {
      fallbackCalls.push(true);
      return {
        bundleBytes: new Uint8Array([123]),
        receiptBytes: new Uint8Array([123]),
      };
    },
    sha256Hex: () => "0".repeat(64),
    compatibilityTuple: exportCompatibilityTuple,
  });

  await assert.rejects(
    context.verifyLocalMetadataBundleFiles({
      bundleFile: "/tmp/review.umx.json",
      receiptFile: "/tmp/review.privacy-receipt.json",
    }),
    (error) => error instanceof verification.BundleVerificationError
      && error.code === "receipt_json",
  );
  assert.equal(fallbackCalls.length, 1);
  assert.equal(injectedCalls.length, 0);
});

test("verification composition requires a live compatibility tuple port", () => {
  const hash = () => "0".repeat(64);
  assert.throws(
    () => verification.createLocalMetadataBundleByteVerifier({
      sha256Hex: hash,
    }),
    /compatibilityTuple must be a function/u,
  );
  assert.throws(
    () => verification.createPrivacySafeBundleVerifier({
      sha256Hex: hash,
    }),
    /compatibilityTuple must be a function/u,
  );
  assert.throws(
    () => createLocalMetadataBundleVerificationContext({
      readOwnerOnlyLocalMetadataBundlePair: async () => ({
        bundleBytes: new Uint8Array([123]),
        receiptBytes: new Uint8Array([123]),
      }),
      sha256Hex: hash,
    }),
    /compatibilityTuple must be a function/u,
  );
});

test("export verification is runtime-neutral and local-review enters through application composition", async () => {
  const ownedFiles = [
    "src/export/bundle-verification.js",
    "src/export/bundle-verifier.js",
    "src/export/canonical-json.js",
    "src/export/privacy.js",
    "src/export/schema.js",
  ];
  for (const relativeFile of ownedFiles) {
    const source = await readFile(
      resolve(REPOSITORY_ROOT, relativeFile),
      "utf8",
    );
    assert.doesNotMatch(source, /(?:from|import\()\s*["']node:/u);
    assert.doesNotMatch(source, /\b(?:Buffer|process)\b/u);
    assert.doesNotMatch(
      source,
      /from\s*["']\.\.\/(?:bundle-verifier|export-|storage)/u,
    );
  }

  const localReview = await readFile(
    resolve(REPOSITORY_ROOT, "local-review/cli.js"),
    "utf8",
  );
  assert.doesNotMatch(
    localReview,
    /src\/bundle-verifier\.js/u,
  );
  assert.match(
    localReview,
    /createLocalMetadataBundleVerificationContext/u,
  );

  const architecture = await readFile(
    resolve(
      REPOSITORY_ROOT,
      "scripts/check-architecture-boundaries.mjs",
    ),
    "utf8",
  );
  const baseline = architecture.slice(
    architecture.indexOf(
      "const LOCAL_REVIEW_LEGACY_MIGRATION_TARGETS",
    ),
    architecture.indexOf(
      "export const CURRENT_ARCHITECTURE_BOUNDARY_BASELINE",
    ),
  );
  assert.doesNotMatch(baseline, /src\/bundle-verifier\.js/u);
});
