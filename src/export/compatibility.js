import { stableJson } from "./canonical-json.js";
import {
  TELEMETRY_V01_REGISTRY_VERSION,
  exportRegistrySnapshot,
} from "./registries.js";
import { EXPORT_RESOURCE_POLICY_VERSION } from "./resource-policy.js";
import {
  CODEX_CHECKPOINT_SCAN_VERSION,
  CODEX_LOG_SCAN_VERSION,
  CODEX_METADATA_ADAPTER_VERSION,
  EXPORT_CHECKPOINT_PARSER_VERSION,
  EXPORT_COMPATIBILITY_TUPLE_VERSION,
  EXPORTER_VERSION,
} from "./versions.js";

export const EXPORT_COMPATIBILITY_SCHEMA_NAMES = Object.freeze([
  "activity-marker.schema.json",
  "bundle.schema.json",
  "compatibility.schema.json",
  "privacy-receipt.schema.json",
  "quota-snapshot.schema.json",
  "usage-event.schema.json",
]);

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const member of Object.values(value)) {
    deepFreezeJson(member);
  }
  return Object.freeze(value);
}

function snapshotArtifact(value, name, artifactName) {
  if (
    !value
    || typeof value !== "object"
    || !(value.bytes instanceof Uint8Array)
  ) {
    throw new TypeError(`${name} must be a byte artifact`);
  }
  const bytes = Uint8Array.from(value.bytes);
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    throw new TypeError(`${name}.bytes must contain UTF-8 JSON`, {
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${name}.bytes must contain a JSON object`);
  }
  return Object.freeze({
    ...(artifactName === undefined ? {} : { name: artifactName }),
    bytes,
    value: deepFreezeJson(parsed),
  });
}

function snapshotArtifactSet(artifacts) {
  if (!artifacts || typeof artifacts !== "object") {
    throw new TypeError("artifacts must be an object");
  }
  if (
    !Array.isArray(artifacts.schemas)
    || artifacts.schemas.length
      !== EXPORT_COMPATIBILITY_SCHEMA_NAMES.length
  ) {
    throw new TypeError("artifacts.schemas must contain the reviewed set");
  }
  for (
    let index = 0;
    index < EXPORT_COMPATIBILITY_SCHEMA_NAMES.length;
    index += 1
  ) {
    const expectedName = EXPORT_COMPATIBILITY_SCHEMA_NAMES[index];
    const schema = artifacts.schemas[index];
    if (schema?.name !== expectedName) {
      throw new TypeError("artifacts.schemas must use reviewed ordering");
    }
  }
  const schemas = artifacts.schemas.map((schema, index) =>
    snapshotArtifact(
      schema,
      `artifacts.schemas[${index}]`,
      EXPORT_COMPATIBILITY_SCHEMA_NAMES[index],
    ));
  const result = {
    schemas: Object.freeze(schemas),
  };
  for (const name of [
    "consentStatus",
    "contractStatus",
    "fieldContract",
    "generatedCompatibility",
    "packageMetadata",
  ]) {
    result[name] = snapshotArtifact(artifacts[name], `artifacts.${name}`);
  }
  return Object.freeze(result);
}

function requireRegistrySnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("registrySnapshot must return an object");
  }
  return value;
}

function buildTupleFromSnapshot({
  source,
  sha256Hex,
  registrySnapshot,
}) {
  const hash = requireFunction(sha256Hex, "sha256Hex");
  const readRegistrySnapshot = requireFunction(
    registrySnapshot,
    "registrySnapshot",
  );
  const reviewedRegistry = requireRegistrySnapshot(readRegistrySnapshot());
  const schemaMembers = source.schemas.map(({ name, bytes, value }) => ({
    name,
    id: value.$id,
    sha256: hash(bytes),
  }));
  return {
    tupleVersion: EXPORT_COMPATIBILITY_TUPLE_VERSION,
    schemas: {
      setSha256: hash(stableJson(schemaMembers)),
      members: schemaMembers,
    },
    fieldContract: {
      version: source.fieldContract.value.contractVersion,
      sha256: hash(source.fieldContract.bytes),
    },
    implementation: {
      exporterVersion: EXPORTER_VERSION,
      resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
      checkpointParserVersion: EXPORT_CHECKPOINT_PARSER_VERSION,
      checkpointScanVersion: CODEX_CHECKPOINT_SCAN_VERSION,
      packageName: source.packageMetadata.value.name,
      packageVersion: source.packageMetadata.value.version,
    },
    providerAdapters: {
      openaiCodex: {
        status: "implemented",
        capabilities: {
          usageEvents: "implemented",
          quotaSnapshots: {
            rollout: "implemented",
            collector: "implemented",
          },
        },
        sourceFormats: {
          rollout: {
            status: "implemented",
            sourceFormat: "codex-rollout-jsonl",
            parserVersion: CODEX_LOG_SCAN_VERSION,
            adapterVersion: CODEX_METADATA_ADAPTER_VERSION,
          },
          collectorQuota: {
            status: "implemented",
            sourceFormat: "codex-collector-jsonl-v0.3",
            parserVersion:
              "codex-collector-quota-candidate-v0.1",
            adapterVersion: "quota-candidate-normalizer-v0.1",
          },
        },
      },
      anthropicClaudeCode: {
        status: "partial",
        capabilities: {
          usageEvents: "implemented",
          quotaSnapshots: "implemented",
        },
        sourceFormats: {
          transcript: {
            status: "implemented",
            sourceFormat: "claude-code-transcript-jsonl",
            parserVersion: "claude-transcript-export-cursor-v0.2",
            adapterVersion: "claude-transcript-usage-candidate-v0.2",
          },
          statusLine: {
            status: "implemented",
            sourceFormat: "claude-statusline-snapshot-v0.2",
            parserVersion: "claude-statusline-v0.2",
            adapterVersion: "quota-candidate-normalizer-v0.1",
          },
        },
      },
    },
    registry: {
      version: TELEMETRY_V01_REGISTRY_VERSION,
      sha256: hash(stableJson(reviewedRegistry)),
    },
    consent: {
      version: source.consentStatus.value.consentVersion,
      status: source.consentStatus.value.status,
      statusSha256: hash(source.consentStatus.bytes),
    },
    contract: {
      family: source.contractStatus.value.contractFamily,
      status: source.contractStatus.value.status,
      transportReady: source.contractStatus.value.transportReady,
      externalParticipantsAuthorized:
        source.contractStatus.value.externalParticipantsAuthorized,
      backwardCompatibility:
        source.contractStatus.value.backwardCompatibility,
      statusSha256: hash(source.contractStatus.bytes),
    },
  };
}

export function buildExportCompatibilityTupleFromArtifacts({
  artifacts,
  sha256Hex,
  registrySnapshot = exportRegistrySnapshot,
} = {}) {
  return deepFreezeJson(buildTupleFromSnapshot({
    source: snapshotArtifactSet(artifacts),
    sha256Hex,
    registrySnapshot,
  }));
}

export function currentExportCompatibilityTupleFromArtifacts(options = {}) {
  const artifacts = snapshotArtifactSet(options.artifacts);
  const live = deepFreezeJson(buildTupleFromSnapshot({
    source: artifacts,
    sha256Hex: options.sha256Hex,
    registrySnapshot:
      options.registrySnapshot ?? exportRegistrySnapshot,
  }));
  if (
    stableJson(live)
    !== stableJson(artifacts.generatedCompatibility.value)
  ) {
    throw new Error("Generated export compatibility manifest is stale");
  }
  return live;
}
