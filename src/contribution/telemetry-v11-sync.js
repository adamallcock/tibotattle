import {
  canonicalTelemetryV11Json,
  isTelemetryV11ConsentCurrent,
  parseTelemetryV11Chunk,
  parseTelemetryV11ChunkId,
  parseTelemetryV11DayManifest,
  parseTelemetryV11DomainManifest,
  telemetryV11DayManifestDigestInput,
  telemetryV11DomainManifestDigestInput,
  telemetryV11RecordAnchor,
  validateTelemetryV11Envelope,
  MAX_TELEMETRY_V11_DAY_CHUNKS,
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
} from "./accountless-transport-contract.js";

import { createTelemetrySyncProtocol } from "./telemetry-sync-protocol.js";

const protocol = createTelemetrySyncProtocol(Object.freeze({
  canonicalJson: canonicalTelemetryV11Json,
  isConsentCurrent: isTelemetryV11ConsentCurrent,
  parseChunkId: parseTelemetryV11ChunkId,
  parseChunk: parseTelemetryV11Chunk,
  parseDayManifest: parseTelemetryV11DayManifest,
  parseDomainManifest: parseTelemetryV11DomainManifest,
  dayManifestDigestInput: telemetryV11DayManifestDigestInput,
  domainManifestDigestInput: telemetryV11DomainManifestDigestInput,
  recordAnchor: telemetryV11RecordAnchor,
  validateEnvelope: validateTelemetryV11Envelope,
  maximumDayChunks: MAX_TELEMETRY_V11_DAY_CHUNKS,
  maximumDomainDays: MAX_TELEMETRY_V11_DOMAIN_DAYS,
  contributionSchemaVersion: TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  domainManifestSchemaVersion: TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION,
  accountlessSchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  accountlessPolicyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  accountlessAuthorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  progressVersion: "telemetry-v11-sync-progress-v1",
  failureName: "TelemetryV11SyncFailure",
  capabilitiesVersion: "device-sync-capabilities-v1.1",
  predecessorVersion: "telemetry-domain-predecessor-v1.1",
  chunkReceiptVersion: "telemetry-chunk-receipt-v1.1",
  activationVersion: "telemetry-domain-activation-v1.1",
  capabilitiesPath: "/api/v1/device/sync-capabilities",
  predecessorPath: "/api/v1/me/telemetry-v11/domain-predecessor",
  dayManifestsPath: "/api/v1/device/telemetry/v1.1/day-manifests",
  activationPath: "/api/v1/me/telemetry-v11/domain-activate",
  formats: Object.freeze({
    "telemetry-contribution-v0.1": 1, "telemetry-contribution-v0.2": 2,
    "telemetry-contribution-v1.0": 10, "telemetry-contribution-v1.1": 11,
  }),
}));

export const readTelemetryV11Capabilities = protocol.readCapabilities;
export const runTelemetryV11Sync = protocol.runSync;
