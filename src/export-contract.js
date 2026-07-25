import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportRegistrySnapshot, TELEMETRY_V01_REGISTRY_VERSION } from "./export-registries.js";
import { stableJson } from "./storage.js";
import { EXPORT_CHECKPOINT_PARSER_VERSION } from "./export-checkpoint-state.js";
import { EXPORT_RESOURCE_POLICY_VERSION } from "./export-resource-policy.js";
import {
  CODEX_LOG_SCAN_VERSION,
  CODEX_CHECKPOINT_SCAN_VERSION,
  CODEX_METADATA_ADAPTER_VERSION,
  EXPORT_COMPATIBILITY_TUPLE_VERSION,
  EXPORTER_VERSION,
} from "./export-versions.js";

const SCHEMA_NAMES = Object.freeze([
  "activity-marker.schema.json",
  "bundle.schema.json",
  "compatibility.schema.json",
  "privacy-receipt.schema.json",
  "quota-snapshot.schema.json",
  "usage-event.schema.json",
]);

const FILES = Object.freeze({
  contractStatus: new URL("../contracts/telemetry-v0.1/contract-status.json", import.meta.url),
  consentStatus: new URL("../contracts/telemetry-v0.1/consent-status.json", import.meta.url),
  fieldContract: new URL("../generated/telemetry-v0.1-field-dictionary.json", import.meta.url),
  generatedCompatibility: new URL("../generated/telemetry-v0.1-compatibility.json", import.meta.url),
  package: new URL("../package.json", import.meta.url),
});

function readArtifact(url) {
  const bytes = readFileSync(fileURLToPath(url));
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildExportCompatibilityTuple() {
  const schemaMembers = SCHEMA_NAMES.map((name) => {
    const artifact = readArtifact(new URL(`../schemas/telemetry-v0.1/${name}`, import.meta.url));
    return { name, id: artifact.value.$id, sha256: sha256(artifact.bytes) };
  });
  const fieldContract = readArtifact(FILES.fieldContract);
  const packageMetadata = readArtifact(FILES.package).value;
  const consentStatus = readArtifact(FILES.consentStatus);
  const contractStatus = readArtifact(FILES.contractStatus);
  return {
    tupleVersion: EXPORT_COMPATIBILITY_TUPLE_VERSION,
    schemas: {
      setSha256: sha256(stableJson(schemaMembers)),
      members: schemaMembers,
    },
    fieldContract: {
      version: fieldContract.value.contractVersion,
      sha256: sha256(fieldContract.bytes),
    },
    implementation: {
      exporterVersion: EXPORTER_VERSION,
      resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
      checkpointParserVersion: EXPORT_CHECKPOINT_PARSER_VERSION,
      checkpointScanVersion: CODEX_CHECKPOINT_SCAN_VERSION,
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
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
            parserVersion: "codex-collector-quota-candidate-v0.1",
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
      sha256: sha256(stableJson(exportRegistrySnapshot())),
    },
    consent: {
      version: consentStatus.value.consentVersion,
      status: consentStatus.value.status,
      statusSha256: sha256(consentStatus.bytes),
    },
    contract: {
      family: contractStatus.value.contractFamily,
      status: contractStatus.value.status,
      transportReady: contractStatus.value.transportReady,
      externalParticipantsAuthorized: contractStatus.value.externalParticipantsAuthorized,
      backwardCompatibility: contractStatus.value.backwardCompatibility,
      statusSha256: sha256(contractStatus.bytes),
    },
  };
}

export function exportCompatibilityTuple() {
  const live = buildExportCompatibilityTuple();
  const generated = readArtifact(FILES.generatedCompatibility).value;
  if (stableJson(live) !== stableJson(generated)) {
    throw new Error("Generated export compatibility manifest is stale");
  }
  return live;
}

export { EXPORTER_VERSION } from "./export-versions.js";
