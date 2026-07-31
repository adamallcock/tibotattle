import { isProxy, isUint8Array } from "node:util/types";

import {
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
  createExportSetMaterializationContract,
  createPrivacySafeBundleVerifier,
} from "../export/set-materialization-runtime.js";

const BUFFER_FROM = Buffer.from;
const REFLECT_APPLY = Reflect.apply;
const UINT8_ARRAY = Uint8Array;

function invalid() { throw new TypeError("Local export set materialization configuration is invalid"); }
function own(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
  return descriptor.value;
}
function callable(value) {
  if (typeof value !== "function" || isProxy(value)) invalid();
  return value;
}
function dataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  if (Object.getOwnPropertySymbols(value).length > 0) invalid();
  const copy = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) invalid();
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}
function snapshotSecret(value) {
  if (Buffer.isBuffer(value)) return REFLECT_APPLY(BUFFER_FROM, Buffer, [value]);
  if (!isUint8Array(value)) return value;
  try {
    return new UINT8_ARRAY(value);
  } catch {
    invalid();
  }
}
function exactError(error, Constructor, code) {
  if (!error || typeof error !== "object" || isProxy(error)
      || Object.getPrototypeOf(error) !== Constructor.prototype) return false;
  const name = Object.getOwnPropertyDescriptor(error, "name");
  const value = Object.getOwnPropertyDescriptor(error, "code");
  const message = Object.getOwnPropertyDescriptor(error, "message");
  return name?.value === Constructor.name && value?.value === code
    && message?.value === `Local export set failed (${code.replace("export_set_", "")})`;
}
function exactResourceLimitError(error, code) {
  if (!error || typeof error !== "object" || isProxy(error)
      || Object.getPrototypeOf(error) !== ExportResourceLimitError.prototype) return false;
  const name = Object.getOwnPropertyDescriptor(error, "name");
  const value = Object.getOwnPropertyDescriptor(error, "code");
  const message = Object.getOwnPropertyDescriptor(error, "message");
  return name?.value === "ExportResourceLimitError"
    && value?.value === `export_resource_${code}`
    && message?.value === `Local export stopped at the ${code} resource limit`;
}
function snapshotPorts(configuration, key, required) {
  const source = own(configuration, key);
  const ports = {};
  for (const name of required) ports[name] = callable(own(source, name));
  return Object.freeze(ports);
}
function snapshotOptions(options) {
  const selected = options === undefined ? {} : options;
  if (!selected || typeof selected !== "object" || Array.isArray(selected) || isProxy(selected)) invalid();
  const requiredWorkspace = Object.getOwnPropertyDescriptor(selected, "workspaceDirectory");
  if (!requiredWorkspace) throw new Error("Export workspace directory is required");
  if (!Object.hasOwn(requiredWorkspace, "value")) invalid();
  if (!requiredWorkspace.value) throw new Error("Export workspace directory is required");
  const result = {
    workspaceDirectory: requiredWorkspace.value,
    outputDirectory: undefined,
    secret: undefined,
  };
  for (const key of ["outputDirectory", "secret", "maximumRecordsPerChunk", "maximumCanonicalBundleBytes", "maximumEncodedArtifactBytes", "failpoint"]) {
    const descriptor = Object.getOwnPropertyDescriptor(selected, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) invalid();
    result[key] = key === "secret" ? snapshotSecret(descriptor.value) : descriptor.value;
  }
  if (Object.hasOwn(result, "failpoint")) callable(result.failpoint);
  return Object.freeze(result);
}
function addCounts(target, value) {
  for (const family of ["usageEvents", "quotaSnapshots", "activityMarkers"]) target[family] += value[family];
}

/**
 * Application orchestration over immutable content semantics, workspace
 * leases, identity derivation, and opaque owner-only artifact destinations.
 */
export function createLocalExportSetMaterialization(configuration = {}) {
  const contract = snapshotPorts(configuration, "contract", [
    "sha256", "fail", "stableJson", "buildChunkBundle", "compressChunkBundle", "deterministicSetId",
    "deterministicBundleId", "chooseLargestFittingPrefix", "assertVerifiedChunk", "manifestReceipt",
    "loadVerifiedLocalMetadataBundleBytes", "decompressExportBytes", "verifyPrivacySafeBundle",
    "assertValidExportSetManifest", "computeWorkspaceLogicalRecordsSha256", "combinedSourcePlanCommitment",
  ]);
  const workspace = snapshotPorts(configuration, "workspace", ["openExportWorkspace", "withExportWorkspaceLease"]);
  const destination = snapshotPorts(configuration, "destination", [
    "enumerateOwnerOnlyExportDestinationEntries", "openOwnerOnlyExportDestination",
    "projectOwnerOnlyExportArtifactPath", "readOwnerOnlyExportArtifactIfPresent",
    "recoverOwnerOnlyPairTransactionsForDestination", "writeOwnerOnlyPairNoClobberForDestination",
  ]);
  const identity = snapshotPorts(configuration, "identity", ["deriveParticipantId"]);
  const resource = snapshotPorts(configuration, "resource", ["createGuard"]);
  const constants = own(configuration, "constants");
  const orderingVersion = own(constants, "EXPORT_SET_ORDERING_VERSION");
  const packingVersion = own(constants, "EXPORT_SET_PACKING_VERSION");
  const manifestBasename = own(constants, "EXPORT_SET_MANIFEST_BASENAME");
  const manifestReceiptBasename = own(constants, "EXPORT_SET_MANIFEST_RECEIPT_BASENAME");
  const gzipProfile = dataObject(own(constants, "EXPORT_GZIP_PROFILE"));
  const contractVersion = own(constants, "EXPORT_SET_CONTRACT_VERSION");
  const schemaSha256 = own(constants, "EXPORT_SET_MANIFEST_SCHEMA_SHA256");
  const manifestVersion = own(constants, "EXPORT_SET_MANIFEST_VERSION");
  if (orderingVersion !== EXPORT_SET_ORDERING_VERSION
    || packingVersion !== EXPORT_SET_PACKING_VERSION
    || manifestBasename !== EXPORT_SET_MANIFEST_BASENAME
    || manifestReceiptBasename !== EXPORT_SET_MANIFEST_RECEIPT_BASENAME
    || contractVersion !== EXPORT_SET_CONTRACT_VERSION
    || schemaSha256 !== EXPORT_SET_MANIFEST_SCHEMA_SHA256
    || manifestVersion !== EXPORT_SET_MANIFEST_VERSION
    || Object.keys(gzipProfile).length !== 4
    || !Object.hasOwn(gzipProfile, "contentEncoding") || !Object.hasOwn(gzipProfile, "profile")
    || !Object.hasOwn(gzipProfile, "level") || !Object.hasOwn(gzipProfile, "strategy")
    || gzipProfile.contentEncoding !== EXPORT_GZIP_PROFILE.contentEncoding
    || gzipProfile.profile !== EXPORT_GZIP_PROFILE.profile
    || gzipProfile.strategy !== EXPORT_GZIP_PROFILE.strategy
    || gzipProfile.level !== EXPORT_GZIP_PROFILE.level) invalid();

  async function materializeUnlocked(options = {}) {
    const selected = options === undefined ? {} : options;
    if (!selected || typeof selected !== "object" || Array.isArray(selected) || isProxy(selected)) {
      throw new TypeError("Local export set materialization options are invalid");
    }
    const workspaceDirectory = own(selected, "workspaceDirectory");
    const outputDirectory = own(selected, "outputDirectory");
    const secret = own(selected, "secret");
    const maximumRecordsPerChunk = Object.hasOwn(selected, "maximumRecordsPerChunk")
      ? own(selected, "maximumRecordsPerChunk") : DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords;
    const maximumCanonicalBundleBytes = Object.hasOwn(selected, "maximumCanonicalBundleBytes")
      ? own(selected, "maximumCanonicalBundleBytes") : DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes;
    const maximumEncodedArtifactBytes = Object.hasOwn(selected, "maximumEncodedArtifactBytes")
      ? own(selected, "maximumEncodedArtifactBytes") : DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes;
    const failpoint = Object.hasOwn(selected, "failpoint") ? callable(own(selected, "failpoint")) : async () => {};
    if (!secret) throw new Error("A participant export secret is required");
    if (!Number.isSafeInteger(maximumRecordsPerChunk) || maximumRecordsPerChunk < 1
        || maximumRecordsPerChunk > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords) {
      throw new TypeError("maximumRecordsPerChunk exceeds the resource policy");
    }
    if (!Number.isSafeInteger(maximumCanonicalBundleBytes) || maximumCanonicalBundleBytes < 1
        || maximumCanonicalBundleBytes > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes) {
      throw new TypeError("maximumCanonicalBundleBytes exceeds the resource policy");
    }
    if (!Number.isSafeInteger(maximumEncodedArtifactBytes) || maximumEncodedArtifactBytes < 1
        || maximumEncodedArtifactBytes > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes) {
      throw new TypeError("maximumEncodedArtifactBytes exceeds the resource policy");
    }
    const opened = await destination.openOwnerOnlyExportDestination({ directory: outputDirectory });
    const destinationCapability = own(opened, "destination");
    const destinationStatus = own(opened, "status");
    const localWorkspace = await workspace.openExportWorkspace({ directory: workspaceDirectory });
    let resourceGuard = null;
    let bodyFailed = false;
    try {
      if (!localWorkspace.isScanComplete() || localWorkspace.isPoisoned()) contract.fail("workspace_incomplete");
      const descriptor = localWorkspace.getDescriptor();
      if (descriptor.participantId !== identity.deriveParticipantId(secret)) contract.fail("workspace_incomplete");
      if (maximumRecordsPerChunk > descriptor.resourceLimits.maximumOutputRecords
          || maximumCanonicalBundleBytes > descriptor.resourceLimits.maximumCanonicalBundleBytes
          || maximumEncodedArtifactBytes > descriptor.resourceLimits.maximumEncodedArtifactBytes) {
        throw new TypeError("Materialization limits exceed the workspace resource policy");
      }
      if (destinationStatus === "present") {
        await destination.recoverOwnerOnlyPairTransactionsForDestination(destinationCapability);
        let entries;
        try { entries = await destination.enumerateOwnerOnlyExportDestinationEntries(destinationCapability); }
        catch (error) {
          if (exactResourceLimitError(error, "directory_entries")) throw error;
          contract.fail("artifact_read");
        }
        if (entries.length > descriptor.resourceLimits.maximumDirectoryEntries) {
          throw new ExportResourceLimitError("directory_entries");
        }
        if (entries.some((name) => /^chunk-\d{6}\.bundle\.json$/.test(name))) contract.fail("mixed_representation");
      }
      localWorkspace.beginInvocation();
      resourceGuard = resource.createGuard({
        scope: "export_set", limits: descriptor.resourceLimits, initialUsage: localWorkspace.resourceUsage(),
      });
      const workspaceStatus = await localWorkspace.status();
      resourceGuard.observeWorkspace(workspaceStatus.workspaceBytes);
      resourceGuard.observeOutputTotals(Object.values(workspaceStatus.recordCounts).reduce((sum, count) => sum + count, 0), workspaceStatus.expandedRecordBytes);
      const logicalDigest = contract.computeWorkspaceLogicalRecordsSha256(localWorkspace, resourceGuard);
      const combinedSourcePlan = contract.combinedSourcePlanCommitment(descriptor);
      const chunking = { orderingVersion, packingVersion, maximumRecordsPerChunk, maximumCanonicalBundleBytes, maximumEncodedArtifactBytes };
      const exportSetId = contract.deterministicSetId(secret, descriptor, logicalDigest, chunking);
      const diagnostics = localWorkspace.scanDiagnostics();
      const iterator = localWorkspace.iterateRecords(); let next = iterator.next(); let carry = []; let carryBytes = 0;
      let recordOffset = 0; let chunkIndex = 0; const chunks = [];
      const totals = { recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 }, logicalRecordsSha256: logicalDigest, decodedBundleBytes: 0, encodedArtifactBytes: 0, receiptBytes: 0 };
      const emptySet = next.done;
      while (!next.done || carry.length > 0 || (emptySet && chunkIndex === 0)) {
        resourceGuard.observeChunkCount(chunkIndex + 1);
        while (!next.done && carry.length < maximumRecordsPerChunk && carryBytes <= maximumCanonicalBundleBytes) { carry.push(next.value); carryBytes += next.value.recordBytes; next = iterator.next(); }
        const bundleId = contract.deterministicBundleId(secret, exportSetId, chunkIndex);
        let selected;
        if (emptySet && carry.length === 0) {
          const emptyBundle = contract.buildChunkBundle({ rows: [], descriptor, diagnostics, bundleId });
          resourceGuard.observeCanonicalBundle(emptyBundle.bundleBytes); selected = contract.compressChunkBundle(emptyBundle, maximumEncodedArtifactBytes);
        } else {
          selected = contract.chooseLargestFittingPrefix({ pool: carry, descriptor, diagnostics, bundleId, maximumBytes: maximumCanonicalBundleBytes, resourceGuard });
          resourceGuard.observeCanonicalBundle(selected.bundleBytes); selected = contract.compressChunkBundle(selected, maximumEncodedArtifactBytes);
        }
        resourceGuard.observeEncodedArtifact(selected.artifactBytes);
        resourceGuard.observeExportSetBytes(totals.decodedBundleBytes + selected.bundleBytes, totals.encodedArtifactBytes + selected.artifactBytes);
        const selectedCount = emptySet && carry.length === 0 ? 0 : selected.count;
        const receipt = contract.verifyPrivacySafeBundle(selected.bundle, { createdAt: descriptor.createdAt });
        const receiptText = contract.stableJson(receipt);
        const metadata = { index: chunkIndex, bundleId, participantId: descriptor.participantId, createdAt: descriptor.createdAt, coveredAt: structuredClone(descriptor.coveredAt), bundleSha256: contract.sha256(selected.bundleText), bundleBytes: selected.bundleBytes, contentEncoding: gzipProfile.contentEncoding, compressionProfile: gzipProfile.profile, artifactSha256: contract.sha256(selected.artifactContent), artifactBytes: selected.artifactBytes, receiptSha256: contract.sha256(receiptText), receiptBytes: Buffer.byteLength(receiptText), recordStart: recordOffset, recordEndExclusive: recordOffset + selectedCount, recordCounts: structuredClone(selected.bundle.recordCounts) };
        localWorkspace.recordChunk(chunkIndex, "planned", metadata); resourceGuard.observeWorkspace(await localWorkspace.storageBytes()); await failpoint("after_chunk_plan", chunkIndex);
        const bundleBasename = `chunk-${String(chunkIndex).padStart(6, "0")}.bundle.json.gz`;
        const receiptBasename = `chunk-${String(chunkIndex).padStart(6, "0")}.receipt.json`;
        const currentBundle = await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: bundleBasename, maximumBytes: metadata.artifactBytes });
        const currentReceipt = await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: receiptBasename, maximumBytes: metadata.receiptBytes });
        if ((currentBundle.status === "present") !== (currentReceipt.status === "present")) contract.fail("chunk_conflict");
        if (currentBundle.status === "absent") { await destination.writeOwnerOnlyPairNoClobberForDestination(destinationCapability, { firstBasename: bundleBasename, firstContent: selected.artifactContent, secondBasename: receiptBasename, secondContent: receiptText }); await failpoint("after_chunk_publish", chunkIndex); }
        const artifact = (await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: bundleBasename, maximumBytes: metadata.artifactBytes })).bytes;
        const receiptBytes = (await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: receiptBasename, maximumBytes: metadata.receiptBytes })).bytes;
        if (!artifact || !receiptBytes || artifact.length !== metadata.artifactBytes || contract.sha256(artifact) !== metadata.artifactSha256 || receiptBytes.length !== metadata.receiptBytes || contract.sha256(receiptBytes) !== metadata.receiptSha256) contract.fail("chunk_conflict");
        try {
          const bundleBytes = contract.decompressExportBytes(artifact, { maximumEncodedBytes: metadata.artifactBytes, maximumDecodedBytes: metadata.bundleBytes });
          if (bundleBytes.length !== metadata.bundleBytes || contract.sha256(bundleBytes) !== metadata.bundleSha256) contract.fail("chunk_conflict");
          contract.assertVerifiedChunk(contract.loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes }), metadata);
        } catch (error) {
          if (exactError(error, ExportSetError, "export_set_chunk_conflict")) throw error;
          contract.fail("chunk_conflict");
        }
        localWorkspace.recordChunk(chunkIndex, "verified", metadata); resourceGuard.observeWorkspace(await localWorkspace.storageBytes()); await failpoint("after_chunk_verify", chunkIndex);
        chunks.push({ index: metadata.index, bundleId: metadata.bundleId, bundleSha256: metadata.bundleSha256,
          bundleBytes: metadata.bundleBytes, contentEncoding: metadata.contentEncoding,
          compressionProfile: metadata.compressionProfile, artifactSha256: metadata.artifactSha256,
          artifactBytes: metadata.artifactBytes, receiptSha256: metadata.receiptSha256,
          receiptBytes: metadata.receiptBytes, recordStart: metadata.recordStart,
          recordEndExclusive: metadata.recordEndExclusive, recordCounts: metadata.recordCounts });
        addCounts(totals.recordCounts, metadata.recordCounts); totals.decodedBundleBytes += metadata.bundleBytes; totals.encodedArtifactBytes += metadata.artifactBytes; totals.receiptBytes += metadata.receiptBytes; recordOffset += selectedCount; carry = carry.slice(selectedCount); carryBytes = carry.reduce((sum, row) => sum + row.recordBytes, 0); chunkIndex += 1; if (emptySet) break;
      }
      const manifest = { schemaVersion: manifestVersion, manifestContract: { version: contractVersion, schemaSha256 }, compatibility: structuredClone(descriptor.compatibility), exportSetId, participantId: descriptor.participantId, createdAt: descriptor.createdAt, coveredAt: structuredClone(descriptor.coveredAt), sourceProviders: [...descriptor.sourceProviders], clientPlatform: descriptor.clientPlatform, transportReady: false, completionStatus: "complete", compressionRuntime: { nodeVersion: process.versions.node, zlibVersion: process.versions.zlib }, sourcePlan: { sha256: combinedSourcePlan.sha256, sourceFiles: combinedSourcePlan.sourceFiles, sourceBytes: combinedSourcePlan.sourceBytes }, chunking, totals, chunks };
      contract.assertValidExportSetManifest(manifest); const manifestText = contract.stableJson(manifest); resourceGuard.observeManifest(Buffer.byteLength(manifestText)); const manifestReceipt = contract.manifestReceipt(manifestText);
      const existingManifest = await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: manifestBasename, maximumBytes: resourceGuard.limits.maximumManifestBytes });
      const existingReceipt = await destination.readOwnerOnlyExportArtifactIfPresent(destinationCapability, { basename: manifestReceiptBasename, maximumBytes: 1024 * 1024 });
      if ((existingManifest.status === "present") !== (existingReceipt.status === "present")) contract.fail("manifest_conflict");
      if (existingManifest.status === "present") {
        try { if (existingManifest.bytes.toString("utf8") !== manifestText || contract.stableJson(JSON.parse(existingReceipt.bytes.toString("utf8"))) !== contract.stableJson(manifestReceipt)) contract.fail("manifest_conflict"); }
        catch (error) {
          if (exactError(error, ExportSetError, "export_set_manifest_conflict")) throw error;
          contract.fail("artifact_read");
        }
      } else { await destination.writeOwnerOnlyPairNoClobberForDestination(destinationCapability, { firstBasename: manifestBasename, firstContent: manifestText, secondBasename: manifestReceiptBasename, secondContent: contract.stableJson(manifestReceipt) }); await failpoint("after_manifest_publish", null); }
      localWorkspace.markManifestComplete({ exportSetId, manifestSha256: manifestReceipt.manifestSha256, manifestBytes: manifestReceipt.manifestBytes, chunkCount: chunks.length }); resourceGuard.observeWorkspace(await localWorkspace.storageBytes());
      return { manifest, manifestReceipt, manifestFile: await destination.projectOwnerOnlyExportArtifactPath(destinationCapability, { basename: manifestBasename, maximumBytes: resourceGuard.limits.maximumManifestBytes }), manifestReceiptFile: await destination.projectOwnerOnlyExportArtifactPath(destinationCapability, { basename: manifestReceiptBasename, maximumBytes: 1024 * 1024 }), resourceUsage: resourceGuard.snapshot() };
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      let cleanupFailed = false;
      let durableUsage = null;
      if (resourceGuard) {
        try {
          durableUsage = resourceGuard.durableSnapshot();
        } catch {
          // Leave the invocation marker intact. A later resume will reserve
          // crash time instead of accepting an incomplete usage snapshot.
          cleanupFailed = true;
        }
        if (!cleanupFailed) {
          try {
            localWorkspace.finishInvocation({ resourceUsage: durableUsage });
          } catch {
            cleanupFailed = true;
          }
        }
      }
      try {
        localWorkspace.close();
      } catch {
        cleanupFailed = true;
      }
      if (!bodyFailed && cleanupFailed) contract.fail("workspace_incomplete");
    }
  }
  return Object.freeze({
    materializeLocalExportSet: async (options = {}) => {
      const snapshot = snapshotOptions(options);
      return workspace.withExportWorkspaceLease(
        snapshot.workspaceDirectory,
        () => materializeUnlocked(snapshot),
      );
    },
  });
}

/** Reviewed command composition helper; callers supply only application/platform ports. */
export function createLocalExportSetMaterializationContext(configuration = {}) {
  const workspace = own(configuration, "workspace");
  const destination = own(configuration, "destination");
  const identity = own(configuration, "identity");
  const resource = own(configuration, "resource");
  const bundleVerification = own(configuration, "bundleVerification");
  const compatibilityTuple = callable(own(configuration, "compatibilityTuple"));
  const deriveExportPseudonym = callable(own(identity, "deriveExportPseudonym"));
  const sha256Hex = callable(own(configuration, "sha256Hex"));
  const loadVerifiedLocalMetadataBundleBytes = callable(own(bundleVerification, "loadVerifiedLocalMetadataBundleBytes"));
  return createLocalExportSetMaterialization({
    contract: createExportSetMaterializationContract({
      deriveExportPseudonym,
      verifyPrivacySafeBundle: createPrivacySafeBundleVerifier({ sha256Hex, compatibilityTuple }),
      loadVerifiedLocalMetadataBundleBytes,
    }),
    workspace,
    destination,
    identity,
    resource,
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
