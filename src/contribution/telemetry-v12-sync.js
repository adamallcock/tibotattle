import {
  canonicalTelemetryV12Json,
  isTelemetryV12ConsentCurrent,
  parseTelemetryV12Chunk,
  parseTelemetryV12ChunkId,
  parseTelemetryV12DayManifest,
  parseTelemetryV12DomainManifest,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RecordAnchor,
  validateTelemetryV12Envelope,
  validateTelemetryV12DayUsageOrder,
  MAX_TELEMETRY_V12_DAY_CHUNKS,
  MAX_TELEMETRY_V12_DOMAIN_DAYS,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS as ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION as ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION as ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
} from "./accountless-transport-contract.js";

import { createTelemetrySyncProtocol } from "./telemetry-sync-protocol.js";

const protocol = createTelemetrySyncProtocol(Object.freeze({
  capabilitiesKind: "successor",
  envelopeSchemaVersion: TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  canonicalJson: canonicalTelemetryV12Json,
  isConsentCurrent: isTelemetryV12ConsentCurrent,
  parseChunkId: parseTelemetryV12ChunkId,
  parseChunk: parseTelemetryV12Chunk,
  parseDayManifest: parseTelemetryV12DayManifest,
  parseDomainManifest: parseTelemetryV12DomainManifest,
  dayManifestDigestInput: telemetryV12DayManifestDigestInput,
  domainManifestDigestInput: telemetryV12DomainManifestDigestInput,
  recordAnchor: telemetryV12RecordAnchor,
  validateEnvelope: validateTelemetryV12Envelope,
  validateUsageDay: validateTelemetryV12DayUsageOrder,
  maximumDayChunks: MAX_TELEMETRY_V12_DAY_CHUNKS,
  maximumDomainDays: MAX_TELEMETRY_V12_DOMAIN_DAYS,
  contributionSchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  domainManifestSchemaVersion: TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
  accountlessSchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  accountlessPolicyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  accountlessAuthorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  progressVersion: "telemetry-v12-sync-progress-v1",
  failureName: "TelemetryV12SyncFailure",
  capabilitiesVersion: "device-sync-capabilities-v1.2",
  predecessorVersion: "telemetry-domain-predecessor-v1.2",
  chunkReceiptVersion: "telemetry-chunk-receipt-v1.2",
  activationVersion: "telemetry-domain-activation-v1.2",
  capabilitiesPath: "/api/v1/device/sync-capabilities-v1.2",
  predecessorPath: "/api/v1/me/telemetry-v12/domain-predecessor",
  dayManifestsPath: "/api/v1/device/telemetry/v1.2/day-manifests",
  activationPath: "/api/v1/me/telemetry-v12/domain-activate",
  formats: Object.freeze({
    "telemetry-contribution-v0.1": 1, "telemetry-contribution-v0.2": 2,
    "telemetry-contribution-v1.0": 10, "telemetry-contribution-v1.1": 11,
    "telemetry-contribution-v1.2": 12,
  }),
}));

export const readTelemetryV12Capabilities = protocol.readCapabilities;
export const runTelemetryV12Sync = protocol.runSync;
