import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as application from "../src/application/index.js";
import * as applicationOwner from "../src/application/local-export-set-materialization.js";
import * as exported from "../src/export/index.js";
import * as owner from "../src/export/set-materialization.js";
import { localExportSetMaterialization } from
  "../src/local-node-runtime.js";
import {
  createSupplementalSourcePlan,
  createExportSetMaterializationContract,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  ExportResourceLimitError,
  ExportSetError,
  EXPORT_GZIP_PROFILE,
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_ORDERING_VERSION,
  EXPORT_SET_PACKING_VERSION,
  normalizeSupplementalSourcePlan,
} from "../src/export/index.js";
import {
  createSourcePlanSummaryContract,
  summarizeExportSourcePlan,
} from "../src/export/source-plan-summary.js";
import * as platform from "../src/platform/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAT = Object.freeze([
  "EXPORT_SET_MANIFEST_BASENAME", "EXPORT_SET_MANIFEST_RECEIPT_BASENAME",
  "EXPORT_SET_ORDERING_VERSION", "ExportSetError", "combinedSourcePlanCommitment",
  "computeWorkspaceLogicalRecordsSha256", "materializeLocalExportSet",
]);

function deferredMaterializer({ onLease = null, onOpen = null } = {}) {
  const noop = () => {};
  const contract = Object.fromEntries([
    "sha256", "fail", "stableJson", "buildChunkBundle", "compressChunkBundle",
    "deterministicSetId", "deterministicBundleId", "chooseLargestFittingPrefix",
    "assertVerifiedChunk", "manifestReceipt", "loadVerifiedLocalMetadataBundleBytes",
    "decompressExportBytes", "verifyPrivacySafeBundle", "assertValidExportSetManifest",
    "computeWorkspaceLogicalRecordsSha256", "combinedSourcePlanCommitment",
  ].map((name) => [name, noop]));
  return applicationOwner.createLocalExportSetMaterialization({
    contract,
    workspace: {
      openExportWorkspace: noop,
      withExportWorkspaceLease: async (directory, callback) => {
        const deferred = onLease?.(directory, callback);
        return deferred === undefined ? callback() : deferred;
      },
    },
    destination: {
      enumerateOwnerOnlyExportDestinationEntries: noop,
      openOwnerOnlyExportDestination: async (value) => {
        onOpen?.(value);
        throw new Error("destination-opened");
      },
      projectOwnerOnlyExportArtifactPath: noop,
      readOwnerOnlyExportArtifactIfPresent: noop,
      recoverOwnerOnlyPairTransactionsForDestination: noop,
      writeOwnerOnlyPairNoClobberForDestination: noop,
    },
    identity: { deriveParticipantId: noop },
    resource: { createGuard: noop },
    constants: {
      EXPORT_SET_ORDERING_VERSION,
      EXPORT_SET_PACKING_VERSION,
      EXPORT_SET_MANIFEST_BASENAME,
      EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
      EXPORT_GZIP_PROFILE,
      EXPORT_SET_CONTRACT_VERSION,
      EXPORT_SET_MANIFEST_SCHEMA_SHA256,
      EXPORT_SET_MANIFEST_VERSION,
    },
  });
}

function lifecycleHarness({
  callLog = null,
  chunkVerificationError = null,
  closeError = null,
  constantOverrides = {},
  destinationStatus = "absent",
  durableError = null,
  enumerateError = null,
  finishError = null,
  gzipProfile = EXPORT_GZIP_PROFILE,
  leaseGate = null,
  manifestComparisonError = null,
  onSecret = null,
} = {}) {
  const calls = callLog ?? {};
  Object.assign(calls, { close: 0, finish: 0, lease: 0, open: 0, write: 0 });
  const artifacts = new Map();
  const digest = "d".repeat(64);
  const descriptor = {
    participantId: "participant",
    createdAt: "2026-07-30T00:00:00.000Z",
    coveredAt: {
      earliest: "2026-07-30T00:00:00.000Z",
      latest: "2026-07-30T00:00:00.000Z",
    },
    compatibility: {},
    sourceProviders: [],
    clientPlatform: "test",
    resourceLimits: DEFAULT_EXPORT_RESOURCE_LIMITS,
  };
  const stableJson = (value) => JSON.stringify(value);
  const fail = (code) => { throw new ExportSetError(code); };
  const emptyRecordCounts = () => ({
    usageEvents: 0,
    quotaSnapshots: 0,
    activityMarkers: 0,
  });
  const workspaceHandle = {
    isScanComplete: () => true,
    isPoisoned: () => false,
    getDescriptor: () => descriptor,
    beginInvocation: () => {},
    resourceUsage: () => ({}),
    status: async () => ({
      workspaceBytes: 0,
      recordCounts: emptyRecordCounts(),
      expandedRecordBytes: 0,
    }),
    scanDiagnostics: () => ({}),
    iterateRecords: () => [][Symbol.iterator](),
    recordChunk: () => {},
    storageBytes: async () => 0,
    markManifestComplete: () => {},
    finishInvocation: () => {
      calls.finish += 1;
      if (finishError !== null) throw finishError;
    },
    close: () => {
      calls.close += 1;
      if (closeError !== null) throw closeError;
    },
  };
  const guard = {
    limits: DEFAULT_EXPORT_RESOURCE_LIMITS,
    observeWorkspace: () => {},
    observeOutputTotals: () => {},
    observeChunkCount: () => {},
    observeCanonicalBundle: () => {},
    observeEncodedArtifact: () => {},
    observeExportSetBytes: () => {},
    observeManifest: () => {},
    durableSnapshot: () => {
      if (durableError !== null) throw durableError;
      return { policyVersion: "test" };
    },
    snapshot: () => ({ policyVersion: "test" }),
  };
  const contract = {
    sha256: () => digest,
    fail,
    stableJson,
    buildChunkBundle: ({ bundleId }) => {
      const bundle = { bundleId, recordCounts: emptyRecordCounts() };
      const bundleText = "{}";
      return { bundle, bundleText, bundleBytes: Buffer.byteLength(bundleText) };
    },
    compressChunkBundle: (selected) => ({
      ...selected,
      artifactContent: Buffer.from([1]),
      artifactBytes: 1,
    }),
    deterministicSetId: () => "set-id",
    deterministicBundleId: () => "bundle-id",
    chooseLargestFittingPrefix: () => fail("record_too_large"),
    assertVerifiedChunk: () => {},
    manifestReceipt: (manifestText) => ({
      schemaVersion: "usage-export-set-manifest-privacy-receipt-v0.2",
      manifestSha256: digest,
      manifestBytes: Buffer.byteLength(manifestText),
      transportReady: false,
    }),
    loadVerifiedLocalMetadataBundleBytes: () => {
      if (chunkVerificationError !== null) throw chunkVerificationError;
      return {};
    },
    decompressExportBytes: () => Buffer.from("{}"),
    verifyPrivacySafeBundle: () => ({ safe: true }),
    assertValidExportSetManifest: () => {},
    computeWorkspaceLogicalRecordsSha256: () => digest,
    combinedSourcePlanCommitment: () => ({
      sha256: digest,
      sourceFiles: 0,
      sourceBytes: 0,
    }),
  };
  const materializer = applicationOwner.createLocalExportSetMaterialization({
    contract,
    workspace: {
      openExportWorkspace: async () => workspaceHandle,
      withExportWorkspaceLease: async (directory, callback) => {
        calls.lease += 1;
        return leaseGate === null ? callback() : leaseGate(directory, callback);
      },
    },
    destination: {
      enumerateOwnerOnlyExportDestinationEntries: async () => {
        if (enumerateError !== null) throw enumerateError;
        return [];
      },
      openOwnerOnlyExportDestination: async () => {
        calls.open += 1;
        return {
          destination: Object.freeze({ kind: "test-destination" }),
          status: destinationStatus,
        };
      },
      projectOwnerOnlyExportArtifactPath: async (_destination, { basename }) =>
        `/opaque/${basename}`,
      readOwnerOnlyExportArtifactIfPresent: async (_destination, { basename }) => {
        if (manifestComparisonError !== null && basename === EXPORT_SET_MANIFEST_BASENAME) {
          return {
            status: "present",
            bytes: {
              toString() { throw manifestComparisonError; },
            },
          };
        }
        if (manifestComparisonError !== null
            && basename === EXPORT_SET_MANIFEST_RECEIPT_BASENAME) {
          return { status: "present", bytes: Buffer.from("{}") };
        }
        const bytes = artifacts.get(basename);
        return bytes === undefined ? { status: "absent" } : { status: "present", bytes };
      },
      recoverOwnerOnlyPairTransactionsForDestination: async () => {},
      writeOwnerOnlyPairNoClobberForDestination: async (_destination, request) => {
        calls.write += 1;
        artifacts.set(request.firstBasename, Buffer.from(request.firstContent));
        artifacts.set(request.secondBasename, Buffer.from(request.secondContent));
      },
    },
    identity: {
      deriveParticipantId: (secret) => {
        onSecret?.(secret);
        return "participant";
      },
    },
    resource: { createGuard: () => guard },
    constants: {
      EXPORT_SET_ORDERING_VERSION,
      EXPORT_SET_PACKING_VERSION,
      EXPORT_SET_MANIFEST_BASENAME,
      EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
      EXPORT_GZIP_PROFILE: gzipProfile,
      EXPORT_SET_CONTRACT_VERSION,
      EXPORT_SET_MANIFEST_SCHEMA_SHA256,
      EXPORT_SET_MANIFEST_VERSION,
      ...constantOverrides,
    },
  });
  return { calls, materializer };
}

const MATERIALIZE_OPTIONS = Object.freeze({
  workspaceDirectory: "workspace",
  outputDirectory: "output",
  secret: "secret",
});

test("materializer runtime exposes one operation and pure bindings stay export-owned", () => {
  assert.deepEqual(Object.keys(localExportSetMaterialization), ["materializeLocalExportSet"]);
  for (const name of FLAT.slice(0, -1)) {
    assert.equal(Object.hasOwn(exported, name), true, name);
  }
  assert.equal(application.createLocalExportSetMaterialization, applicationOwner.createLocalExportSetMaterialization);
  assert.equal(exported.createExportSetMaterializationContract, owner.createExportSetMaterializationContract);
});

test("materialization owners stay pure and application composes only reviewed ports", async () => {
  const pure = await readFile(resolve(ROOT, "src/export/set-materialization.js"), "utf8");
  const app = await readFile(resolve(ROOT, "src/application/local-export-set-materialization.js"), "utf8");
  assert.doesNotMatch(pure, /node:(?:fs|path)|\.\.\/(?:application|platform|storage|export-workspace)/u);
  assert.doesNotMatch(app, /\.\.\/(?:platform|export-set-materializer|storage)\.js/u);
});

test("workspace runtime rejects accessors and callable proxies without execution", () => {
  let touched = 0;
  const accessor = {};
  Object.defineProperty(accessor, "createStorage", { get() { touched += 1; return () => {}; } });
  assert.throws(() => application.createLocalExportWorkspaceRuntimeContext(accessor), /configuration/u);
  assert.equal(touched, 0);
  const callableProxy = new Proxy(() => {}, { get() { touched += 1; throw new Error("trap"); } });
  assert.throws(() => application.createLocalExportWorkspaceRuntimeContext({
    createStorage: callableProxy,
    createLease: platform.createOwnerOnlyExportWorkspaceLeaseContext,
    sha256Hex: platform.sha256Hex,
    platformName: () => "other",
  }), /configuration/u);
  assert.equal(touched, 0);
});

test("materialization contracts reject hostile configuration and preserve missing workspace compatibility", async () => {
  let touched = 0;
  const callable = new Proxy(() => {}, { get() { touched += 1; throw new Error("trap"); } });
  assert.throws(() => createExportSetMaterializationContract({
    deriveExportPseudonym: callable,
    verifyPrivacySafeBundle: () => {},
    loadVerifiedLocalMetadataBundleBytes: () => {},
  }), /configuration/u);
  assert.throws(() => summarizeExportSourcePlan(new Proxy({}, { get() { touched += 1; throw new Error("trap"); } })), /source_changed/u);
  assert.throws(() => createSupplementalSourcePlan(new Proxy({}, { get() { touched += 1; throw new Error("trap"); } })), /schema/u);
  await assert.rejects(localExportSetMaterialization.materializeLocalExportSet(), /Export workspace directory is required/u);
  assert.equal(touched, 0);
});

test("source-plan summary preserves omitted legacy lineage defaults without evaluating properties", () => {
  const source = {
    ordinal: 0,
    sourceKey: "source-key",
    prefixBytes: 23,
    prefixSha256: "a".repeat(64),
  };
  const explicit = {
    ...source,
    parentSourceKey: null,
    isFork: false,
    parentMissing: false,
  };
  const { planDigest } = createSourcePlanSummaryContract();
  const legacyPlan = { sources: [source], sourcePlanSha256: planDigest([source]) };
  const explicitPlan = { sources: [explicit], sourcePlanSha256: planDigest([explicit]) };
  assert.equal(legacyPlan.sourcePlanSha256, explicitPlan.sourcePlanSha256);
  assert.deepEqual(summarizeExportSourcePlan(legacyPlan), summarizeExportSourcePlan(explicitPlan));

  let touched = 0;
  Object.defineProperty(source, "isFork", { get() { touched += 1; return false; } });
  assert.throws(() => summarizeExportSourcePlan({
    sources: [source], sourcePlanSha256: legacyPlan.sourcePlanSha256,
  }), /source_changed/u);
  assert.equal(touched, 0);
});

test("source and supplemental plan snapshots reject nested traps without executing them", () => {
  const safeSource = {
    ordinal: 0,
    sourceKey: "source-key",
    prefixBytes: 7,
    prefixSha256: "b".repeat(64),
  };
  const { planDigest } = createSourcePlanSummaryContract();
  const digest = planDigest([safeSource]);
  let touched = 0;
  const sourceIndexAccessor = [];
  Object.defineProperty(sourceIndexAccessor, "0", {
    get() { touched += 1; return safeSource; }, enumerable: true,
  });
  sourceIndexAccessor.length = 1;
  assert.throws(() => summarizeExportSourcePlan({
    sources: sourceIndexAccessor, sourcePlanSha256: digest,
  }), /source_changed/u);
  const shadowedMap = [safeSource];
  Object.defineProperty(shadowedMap, "map", {
    get() { touched += 1; throw new Error("map trap"); }, enumerable: false,
  });
  assert.throws(() => summarizeExportSourcePlan({
    sources: shadowedMap, sourcePlanSha256: digest,
  }), /source_changed/u);

  const source = {
    ordinal: 0,
    sourceKey: "c".repeat(64),
    kind: "codex_collector_ledger",
    parserVersion: "codex-collector-ledger-v0.1",
    binding: new Proxy({}, { get() { touched += 1; throw new Error("binding trap"); } }),
    initialCursorJson: "{\n  \"batch\": 0\n}\n",
  };
  assert.throws(() => createSupplementalSourcePlan({ sources: [source] }), /schema/u);
  assert.equal(touched, 0);
});

test("materialization snapshots public options before the asynchronous lease", async () => {
  let leaseDirectory;
  let releaseLease;
  let opened;
  const materializer = deferredMaterializer({
    onLease(directory, callback) {
      leaseDirectory = directory;
      return new Promise((resolve) => { releaseLease = () => resolve(callback()); });
    },
    onOpen(value) { opened = value; },
  });
  const options = { workspaceDirectory: "workspace-before", outputDirectory: "output-before", secret: "secret-before" };
  const pending = materializer.materializeLocalExportSet(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leaseDirectory, "workspace-before");
  options.workspaceDirectory = "workspace-after";
  options.outputDirectory = "output-after";
  options.secret = "";
  releaseLease();
  await assert.rejects(pending, /destination-opened/u);
  assert.deepEqual(opened, { directory: "output-before" });
});

test("materialization retains legacy missing-secret failures after option snapshots", async () => {
  const materializer = deferredMaterializer();
  for (const options of [
    { workspaceDirectory: "workspace", outputDirectory: "output" },
    { workspaceDirectory: "workspace", outputDirectory: "output", secret: undefined },
    { workspaceDirectory: "workspace", outputDirectory: "output", secret: "" },
  ]) {
    await assert.rejects(
      materializer.materializeLocalExportSet(options),
      /A participant export secret is required/u,
    );
  }
});

test("materialization accepts only exact resource-limit errors without Proxy trap execution", async () => {
  const genuine = new ExportResourceLimitError("directory_entries");
  const genuineHarness = lifecycleHarness({
    destinationStatus: "present",
    enumerateError: genuine,
  });
  await assert.rejects(
    genuineHarness.materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
    (error) => error === genuine,
  );

  let touched = 0;
  const proxied = new Proxy(new ExportResourceLimitError("directory_entries"), {
    get() {
      touched += 1;
      throw new Error("PRIVATE_RESOURCE_GET_CANARY");
    },
    getPrototypeOf() {
      touched += 1;
      throw new Error("PRIVATE_RESOURCE_PROTOTYPE_CANARY");
    },
  });
  class ForgedResourceError extends ExportResourceLimitError {}
  const forged = Object.assign(new Error("private-forged-message"), {
    name: "ExportResourceLimitError",
    code: "export_resource_directory_entries",
  });
  for (const enumerateError of [
    proxied,
    new ForgedResourceError("directory_entries"),
    forged,
  ]) {
    const { materializer } = lifecycleHarness({
      destinationStatus: "present",
      enumerateError,
    });
    await assert.rejects(
      materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
      (error) => error instanceof ExportSetError
        && error.code === "export_set_artifact_read"
        && !error.message.includes("private"),
    );
  }
  assert.equal(touched, 0);
});

test("materialization cleanup normalizes standalone failures and always attempts close", async () => {
  const cleanupFailure = new Error("PRIVATE_CLEANUP_CANARY");
  for (const scenario of [
    { finishError: cleanupFailure, expectedFinish: 1 },
    { closeError: cleanupFailure, expectedFinish: 1 },
    { finishError: cleanupFailure, closeError: cleanupFailure, expectedFinish: 1 },
    { durableError: cleanupFailure, expectedFinish: 0 },
  ]) {
    const { calls, materializer } = lifecycleHarness(scenario);
    await assert.rejects(
      materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
      (error) => error instanceof ExportSetError
        && error.code === "export_set_workspace_incomplete"
        && !error.message.includes("PRIVATE_CLEANUP_CANARY"),
    );
    assert.equal(calls.finish, scenario.expectedFinish);
    assert.equal(calls.close, 1);
  }
});

test("materialization cleanup preserves primary thrown values, including primitives", async () => {
  const cleanupFailure = new Error("PRIVATE_CLEANUP_CANARY");
  const primaryValues = [
    new Error("PRIMARY_FAILURE"),
    null,
    undefined,
    false,
    0,
  ];
  for (const primary of primaryValues) {
    const { calls, materializer } = lifecycleHarness({
      finishError: cleanupFailure,
      closeError: cleanupFailure,
    });
    let observed = Symbol("not-thrown");
    try {
      await materializer.materializeLocalExportSet({
        ...MATERIALIZE_OPTIONS,
        failpoint: async (name) => {
          if (name === "after_chunk_plan") throw primary;
        },
      });
      assert.fail("materialization should reject");
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, primary);
    assert.equal(calls.finish, 1);
    assert.equal(calls.close, 1);
  }
});

test("materialization gzip constants reject nested accessors, proxies, and extra fields", () => {
  let touched = 0;
  const accessorProfile = { ...EXPORT_GZIP_PROFILE };
  Object.defineProperty(accessorProfile, "profile", {
    enumerable: true,
    get() {
      touched += 1;
      throw new Error("PRIVATE_GZIP_ACCESSOR_CANARY");
    },
  });
  const proxyProfile = new Proxy({ ...EXPORT_GZIP_PROFILE }, {
    get() {
      touched += 1;
      throw new Error("PRIVATE_GZIP_PROXY_CANARY");
    },
  });
  const extraProfile = { ...EXPORT_GZIP_PROFILE, privateField: "canary" };
  const hiddenExtraProfile = { ...EXPORT_GZIP_PROFILE };
  Object.defineProperty(hiddenExtraProfile, "privateField", { value: "canary" });
  const symbolProfile = { ...EXPORT_GZIP_PROFILE };
  symbolProfile[Symbol("private")] = "canary";
  for (const gzipProfile of [
    accessorProfile,
    proxyProfile,
    extraProfile,
    hiddenExtraProfile,
    symbolProfile,
  ]) {
    assert.throws(
      () => lifecycleHarness({ gzipProfile }),
      (error) => error instanceof TypeError
        && error.message === "Local export set materialization configuration is invalid",
    );
  }
  assert.equal(touched, 0);
});

test("materialization pins every representation constant before lease or publication", () => {
  const wrongProfiles = [
    { ...EXPORT_GZIP_PROFILE, contentEncoding: "identity" },
    { ...EXPORT_GZIP_PROFILE, profile: "gzip-level-9-v1" },
    { ...EXPORT_GZIP_PROFILE, level: EXPORT_GZIP_PROFILE.level + 1 },
    { ...EXPORT_GZIP_PROFILE, strategy: "filtered" },
  ];
  const wrongConstants = [
    { EXPORT_SET_ORDERING_VERSION: "wrong-order" },
    { EXPORT_SET_PACKING_VERSION: "wrong-packing" },
    { EXPORT_SET_MANIFEST_BASENAME: "wrong-manifest.json" },
    { EXPORT_SET_MANIFEST_RECEIPT_BASENAME: "wrong-receipt.json" },
    { EXPORT_SET_CONTRACT_VERSION: "wrong-contract" },
    { EXPORT_SET_MANIFEST_SCHEMA_SHA256: "0".repeat(64) },
    { EXPORT_SET_MANIFEST_VERSION: "wrong-manifest-version" },
  ];
  for (const input of [
    ...wrongProfiles.map((gzipProfile) => ({ gzipProfile })),
    ...wrongConstants.map((constantOverrides) => ({ constantOverrides })),
  ]) {
    const callLog = {};
    assert.throws(
      () => lifecycleHarness({ ...input, callLog }),
      (error) => error instanceof TypeError
        && error.message === "Local export set materialization configuration is invalid",
    );
    assert.deepEqual(callLog, { close: 0, finish: 0, lease: 0, open: 0, write: 0 });
  }
});

test("materialization copies binary secret material before the asynchronous lease", async () => {
  let speciesTouched = 0;
  class HostileUint8Array extends Uint8Array {
    static get [Symbol.species]() {
      speciesTouched += 1;
      throw new Error("PRIVATE_TYPED_ARRAY_SPECIES_CANARY");
    }
  }
  const sharedSecret = new Uint8Array(new SharedArrayBuffer(32));
  sharedSecret.fill(1);
  const hostileSecret = new HostileUint8Array(32);
  hostileSecret.fill(1);
  for (const secret of [
    Buffer.alloc(32, 1),
    new Uint8Array(32).fill(1),
    sharedSecret,
    hostileSecret,
  ]) {
    let releaseLease;
    let observedSecret;
    const { materializer } = lifecycleHarness({
      leaseGate: (_directory, callback) => new Promise((resolve) => {
        releaseLease = () => resolve(callback());
      }),
      onSecret: (value) => { observedSecret = Buffer.from(value); },
    });
    const pending = materializer.materializeLocalExportSet({
      ...MATERIALIZE_OPTIONS,
      secret,
    });
    await new Promise((resolve) => setImmediate(resolve));
    secret[0] = 9;
    releaseLease();
    await pending;
    assert.equal(observedSecret[0], 1);
    assert.notEqual(observedSecret, secret);
  }
  assert.equal(speciesTouched, 0);
});

test("chunk verification recognizes only exact canonical ExportSetError instances", async () => {
  const genuine = new ExportSetError("chunk_conflict");
  const genuineHarness = lifecycleHarness({ chunkVerificationError: genuine });
  await assert.rejects(
    genuineHarness.materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
    (error) => error === genuine,
  );

  let touched = 0;
  const proxied = new Proxy(new ExportSetError("chunk_conflict"), {
    get() {
      touched += 1;
      throw new Error("PRIVATE_CHUNK_GET_CANARY");
    },
    getPrototypeOf() {
      touched += 1;
      throw new Error("PRIVATE_CHUNK_PROTOTYPE_CANARY");
    },
  });
  class ForgedSetError extends ExportSetError {}
  const forged = Object.assign(new Error("private-forged-chunk"), {
    name: "ExportSetError",
    code: "export_set_chunk_conflict",
  });
  for (const chunkVerificationError of [
    proxied,
    new ForgedSetError("chunk_conflict"),
    forged,
  ]) {
    const { materializer } = lifecycleHarness({ chunkVerificationError });
    await assert.rejects(
      materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
      (error) => error instanceof ExportSetError
        && error.code === "export_set_chunk_conflict"
        && !error.message.includes("private"),
    );
  }
  assert.equal(touched, 0);
});

test("manifest comparison recognizes only exact canonical ExportSetError instances", async () => {
  const genuine = new ExportSetError("manifest_conflict");
  const genuineHarness = lifecycleHarness({ manifestComparisonError: genuine });
  await assert.rejects(
    genuineHarness.materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
    (error) => error === genuine,
  );

  let touched = 0;
  const proxied = new Proxy(new ExportSetError("manifest_conflict"), {
    get() {
      touched += 1;
      throw new Error("PRIVATE_MANIFEST_GET_CANARY");
    },
    getPrototypeOf() {
      touched += 1;
      throw new Error("PRIVATE_MANIFEST_PROTOTYPE_CANARY");
    },
  });
  class ForgedSetError extends ExportSetError {}
  const forged = Object.assign(new Error("private-forged-manifest"), {
    name: "ExportSetError",
    code: "export_set_manifest_conflict",
  });
  for (const manifestComparisonError of [
    proxied,
    new ForgedSetError("manifest_conflict"),
    forged,
  ]) {
    const { materializer } = lifecycleHarness({ manifestComparisonError });
    await assert.rejects(
      materializer.materializeLocalExportSet(MATERIALIZE_OPTIONS),
      (error) => error instanceof ExportSetError
        && error.code === "export_set_artifact_read"
        && !error.message.includes("private"),
    );
  }
  assert.equal(touched, 0);
});

test("supplemental plan snapshots reject nested arrays, sources, bindings, and plan accessors", () => {
  const binding = {
    kind: "file_prefix",
    device: 1,
    inode: 2,
    birthtimeMs: 3,
    prefixBytes: 4,
    prefixSha256: "e".repeat(64),
  };
  const source = {
    ordinal: 0,
    sourceKey: "f".repeat(64),
    kind: "codex_collector_ledger",
    parserVersion: "codex-collector-ledger-v0.1",
    binding,
    initialCursorJson: "{\n  \"batch\": 0\n}\n",
  };
  const plan = createSupplementalSourcePlan({ sources: [source] });
  let touched = 0;
  const sourceProxy = new Proxy(source, {
    get() {
      touched += 1;
      throw new Error("PRIVATE_SOURCE_PROXY_CANARY");
    },
  });
  const bindingAccessor = { ...binding };
  Object.defineProperty(bindingAccessor, "kind", {
    enumerable: true,
    get() {
      touched += 1;
      throw new Error("PRIVATE_BINDING_ACCESSOR_CANARY");
    },
  });
  const sourceAccessor = { ...source, binding: bindingAccessor };
  const indexAccessor = [];
  Object.defineProperty(indexAccessor, "0", {
    enumerable: true,
    get() {
      touched += 1;
      return source;
    },
  });
  indexAccessor.length = 1;
  const shadowedMap = [source];
  Object.defineProperty(shadowedMap, "map", {
    get() {
      touched += 1;
      throw new Error("PRIVATE_MAP_ACCESSOR_CANARY");
    },
  });
  const planAccessor = { ...plan };
  Object.defineProperty(planAccessor, "sources", {
    enumerable: true,
    get() {
      touched += 1;
      return [source];
    },
  });
  for (const operation of [
    () => createSupplementalSourcePlan({ sources: [sourceProxy] }),
    () => createSupplementalSourcePlan({ sources: [sourceAccessor] }),
    () => createSupplementalSourcePlan({ sources: indexAccessor }),
    () => createSupplementalSourcePlan({ sources: shadowedMap }),
    () => normalizeSupplementalSourcePlan(planAccessor),
  ]) {
    assert.throws(
      operation,
      (error) => error.code === "export_supplemental_source_schema"
        && !error.message.includes("PRIVATE_"),
    );
  }
  assert.equal(touched, 0);
});
