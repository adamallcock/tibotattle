import {
  INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { ApiError } from "./errors";
import type { SessionMaterial } from "./session";
import type {
  DevicePairingMaterial,
  DevicePrincipal,
  DeviceTransportConsentVersion,
} from "./device-auth";
import {
  claimDevicePairing,
  createDevicePairing,
  createDeviceUploadAuthorization,
  type DeviceSource,
} from "./device-auth";
import { enroll as enrollParticipant } from "./repository";
import type { TelemetryAuthorityBackend } from "./telemetry-authority-backend";
import { createPostgresLifecycleStore } from "./postgres-storage-provider";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { participantDeletionDigest } from "./participant-erasure-ledger-contract";

/**
 * The source identity is application state, not a test fixture.  A primary
 * database that already contains a different source identity fails closed;
 * silently adopting it would splice two analytical universes together.
 */
export const POSTGRES_CANONICAL_SOURCE_ID = "canonical-v1-primary";
export const POSTGRES_CANONICAL_SOURCE_NAMESPACE = "telemetry-v1";

const HEX64 = /^[0-9a-f]{64}$/u;
const READINESS_PAGE_SIZE = 256;

type CollectionControl =
  | "enrollment"
  | "uploadRegistration"
  | "processing"
  | "publication";

export interface PostgresEnrollment {
  readonly participantId: string;
  readonly recoveryCode: string;
  readonly session: SessionMaterial;
  readonly pairing: DevicePairingMaterial | null;
  readonly invitation: {
    readonly state: "not_required";
    readonly redeemedAt: null;
    readonly expiresAt: null;
  };
}

export interface PostgresWorkerApplication {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  ownerDigest(participantId: string): Promise<string>;
  assertIdentityConfiguration(rawSecret: unknown, rawVersion: unknown): Promise<void>;
  hasIdentityCooldownDigest(digest: string, ledger: boolean): Promise<boolean>;
  assertCollectionControl(control: CollectionControl): Promise<void>;
  assertOwnerAdmission(participantId: string): Promise<void>;
  assertGlobalReadiness(): Promise<void>;
  deviceForUploadAuthorization(authorizationId: string): Promise<{
    readonly participantId: string;
    readonly deviceId: string;
  } | null>;
  assertTelemetryV1Consent(participantId: string, deviceId: string): Promise<void>;
  registerQuarantine(input: {
    readonly contributionId: string;
    readonly objectKey: string;
    readonly registeredAt: string;
  }): Promise<void>;
  clearQuarantine(input: { readonly contributionId: string; readonly objectKey: string }): Promise<void>;
  enroll(input: {
    readonly consentVersion: string;
    readonly deviceBootstrap: boolean;
    readonly identityLinkKey?: string | null;
    readonly identityCooldownDigest?: string | null;
    readonly nowEpoch?: number;
  }): Promise<PostgresEnrollment>;
  createPairing(input: {
    readonly participantId: string;
    readonly sessionId: string;
    readonly participantConsentVersion: string;
    readonly transportConsentVersion?: DeviceTransportConsentVersion;
    readonly nowEpoch?: number;
  }): Promise<{ readonly pairingCode: string; readonly expiresAt: string }>;
  claimPairing(input: {
    readonly authorizationHeader: string | null;
    readonly deviceId: string;
    readonly deviceSecretHashHex: string;
    readonly previousDeviceAuthorization?: string | null;
    readonly nowEpoch?: number;
  }): Promise<{
    readonly deviceId: string;
    readonly state: "active";
    readonly scope: "upload_registration";
    readonly expiresAt: string;
  }>;
  createUploadAuthorization(input: {
    readonly device: DevicePrincipal;
    readonly envelopeDigest: string;
    readonly bodyBytes: number;
    readonly nowEpoch?: number;
  }): Promise<{ readonly uploadAuthorization: string; readonly expiresAt: string }>;
}

function preserveApiError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function randomOpaqueDigest(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function controlColumn(control: CollectionControl): string {
  switch (control) {
    case "enrollment": return "enrollment_enabled";
    case "uploadRegistration": return "upload_registration_enabled";
    case "processing": return "processing_enabled";
    case "publication": return "publication_enabled";
  }
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

export function createPostgresWorkerApplication(
  primaryPool: PostgresPool,
  ledgerPool: PostgresPool,
  authority: TelemetryAuthorityBackend,
  schemaOptions: PostgresSchemaOptions = {},
): PostgresWorkerApplication {
  const schema = createPostgresSchemaConfig(schemaOptions);
  const primary = (name: string) => table(schema.primarySchema, name);
  const ledger = (name: string) => table(schema.ledgerSchema, name);
  // A fresh process must replay the bounded primary/ledger reconciliation even
  // when a restored primary retained an old completed marker. Progress is
  // stored in postgres_readiness_sweeps so the scan remains restartable and
  // does not turn a large owner set into a permanent outage.
  const processEpoch = randomOpaqueDigest();
  const lifecycle = createPostgresLifecycleStore({
    primaryPool,
    ledgerPool,
    schemaOptions,
  });

  async function ownerDigest(participantId: string): Promise<string> {
    if (typeof participantId !== "string" || participantId.length < 1 || participantId.length > 200) {
      throw new ApiError(400, "BODY_INVALID");
    }
    const result = await withPostgresRead(primaryPool, async (client) => client.query<{ owner_digest: string }>(
      `SELECT owner_digest FROM ${primary("storage_v11_owner_links")}
        WHERE participant_id=$1 AND state='active'`, [participantId]), {
      operation: "app.owner_digest",
      preserveSafeError: preserveApiError,
    });
    const digest = result.rows[0]?.owner_digest;
    if (typeof digest !== "string" || !HEX64.test(digest)) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    return digest;
  }

  async function assertIdentityConfiguration(rawSecret: unknown, rawVersion: unknown): Promise<void> {
    if (typeof rawSecret !== "string" || rawSecret.length < 32
        || typeof rawVersion !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(rawVersion)) {
      throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    }
    let fingerprint: string;
    try {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(rawSecret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC", key,
        new TextEncoder().encode("app-usagemonitor/identity-link-secret-fingerprint/v1\0"),
      );
      fingerprint = Array.from(new Uint8Array(signature), (value) => (
        value.toString(16).padStart(2, "0")
      )).join("");
    } catch {
      throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    }
    await withPostgresMutation(primaryPool, async (client) => {
      await client.query(
        `INSERT INTO ${primary("identity_link_secret_configuration")}
          (singleton,key_version,secret_fingerprint,recorded_at)
         VALUES(1,$1,$2,clock_timestamp()) ON CONFLICT(singleton) DO NOTHING`,
        [rawVersion, fingerprint],
      );
      const result = await client.query<{ key_version: string; secret_fingerprint: string }>(
        `SELECT key_version,secret_fingerprint
           FROM ${primary("identity_link_secret_configuration")}
          WHERE singleton=1`,
      );
      const row = result.rows[0];
      if (!row || row.key_version !== rawVersion || row.secret_fingerprint !== fingerprint) {
        throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
      }
    }, {
      operation: "app.identity_configuration",
      preserveSafeError: preserveApiError,
    });
  }

  async function hasIdentityCooldownDigest(digest: string, useLedger: boolean): Promise<boolean> {
    if (!HEX64.test(digest)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    const result = await withPostgresRead(useLedger ? ledgerPool : primaryPool, async (client) => client.query(
      useLedger
        ? `SELECT 1 FROM ${ledger("identity_reenrollment_cooldowns")}
            WHERE identity_cooldown_digest=$1 AND retain_until>clock_timestamp()`
        : `SELECT 1 FROM ${primary("identity_reenrollment_cooldowns")}
            WHERE identity_cooldown_digest=$1 AND expires_at>clock_timestamp()`,
      [digest],
    ), {
      operation: useLedger ? "app.identity_cooldown.ledger" : "app.identity_cooldown.primary",
      preserveSafeError: preserveApiError,
    });
    return result.rows.length === 1;
  }

  async function assertCollectionControl(control: CollectionControl): Promise<void> {
    const column = controlColumn(control);
    const result = await withPostgresRead(primaryPool, async (client) => client.query<{
      control_state: string;
      enabled: boolean;
    }>(`SELECT control_state, ${quotePostgresIdentifier(column)} AS enabled
          FROM ${primary("collection_controls")}
         WHERE singleton=1`, []), {
      operation: `app.control.${control}`,
      preserveSafeError: preserveApiError,
    });
    const row = result.rows[0];
    if (!row || typeof row.control_state !== "string" || typeof row.enabled !== "boolean") {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    if (!row.enabled || row.control_state === "contained") {
      const code = control === "enrollment"
        ? "COLLECTION_ENROLLMENT_DISABLED"
        : control === "processing"
          ? "PROCESSING_DISABLED"
          : control === "publication"
            ? "PUBLICATION_DISABLED"
            : "TELEMETRY_TRANSPORT_BLOCKED";
      throw new ApiError(503, code);
    }
  }

  async function assertOwnerAdmission(participantId: string): Promise<void> {
    const digest = await participantDeletionDigest(participantId);
    const now = new Date().toISOString();
    const result = await withPostgresRead(ledgerPool, async (client) => client.query(
      `SELECT 1 FROM ${ledger("deletion_tombstones")}
        WHERE participant_digest=$1 AND retain_until>$2
       UNION ALL
       SELECT 1 FROM ${ledger("storage_erasure_jobs")}
        WHERE participant_digest=$1 AND state='pending'
       LIMIT 1`, [digest, now]), {
      operation: "app.owner_admission",
      preserveSafeError: preserveApiError,
    });
    if (result.rows.length !== 0) throw new ApiError(401, "AUTH_INVALID");
  }

  async function assertGlobalReadiness(): Promise<void> {
    const runtime = await withPostgresRead(primaryPool, async (client) => client.query<{
      restore_replay_complete: boolean;
      quarantine_retention_complete: boolean;
      source_id: string;
      source_epoch: string | number;
    }>(`SELECT retention.restore_replay_complete,
               retention.quarantine_retention_complete,
               source.source_id,
               source.authority_epoch AS source_epoch
          FROM ${primary("retention_state")} retention
          CROSS JOIN ${primary("storage_source_state")} source
         WHERE retention.singleton=1 AND source.singleton=1`, []), {
      operation: "app.global_readiness.primary",
      preserveSafeError: preserveApiError,
    });
    const runtimeRow = runtime.rows[0];
    if (!runtimeRow
        || runtimeRow.restore_replay_complete !== true
        || runtimeRow.quarantine_retention_complete !== true
        || runtimeRow.source_id !== POSTGRES_CANONICAL_SOURCE_ID) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    const sourceEpoch = String(runtimeRow.source_epoch);
    const checkpoint = await withPostgresMutation(primaryPool, async (client) => {
      await client.query(
        `INSERT INTO ${primary("postgres_readiness_sweeps")}
          (singleton,process_epoch,source_id,source_epoch,state,checked_at)
         VALUES(1,$1,$2,$3,'pending',clock_timestamp())
         ON CONFLICT(singleton) DO NOTHING`,
        [processEpoch, POSTGRES_CANONICAL_SOURCE_ID, sourceEpoch],
      );
      const result = await client.query<{
        process_epoch: string;
        source_id: string;
        source_epoch: string | number;
        cursor_participant_id: string | null;
        state: "pending" | "complete";
      }>(
        `SELECT process_epoch,source_id,source_epoch,cursor_participant_id,state
           FROM ${primary("postgres_readiness_sweeps")}
          WHERE singleton=1 FOR UPDATE`,
      );
      const row = result.rows[0];
      if (!row) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      if (row.process_epoch !== processEpoch
          || row.source_id !== POSTGRES_CANONICAL_SOURCE_ID
          || String(row.source_epoch) !== sourceEpoch) {
        await client.query(
          `UPDATE ${primary("postgres_readiness_sweeps")}
              SET process_epoch=$1,source_id=$2,source_epoch=$3,
                  cursor_participant_id=NULL,state='pending',ledger_watermark=NULL,
                  checked_at=clock_timestamp()
            WHERE singleton=1`,
          [processEpoch, POSTGRES_CANONICAL_SOURCE_ID, sourceEpoch],
        );
        return { cursor: null as string | null, state: "pending" as const };
      }
      return { cursor: row.cursor_participant_id, state: row.state };
    }, {
      operation: "app.global_readiness.checkpoint",
      preserveSafeError: preserveApiError,
    });
    if (checkpoint.state === "complete") return;

    const owners = await withPostgresRead(primaryPool, async (client) => client.query<{
      participant_id: string;
      owner_digest: string;
      owner_state: string | null;
    }>(`SELECT participant.id AS participant_id,
               link.owner_digest,
               owner_state.state AS owner_state
          FROM ${primary("participants")} participant
          JOIN ${primary("storage_v11_owner_links")} link
            ON link.participant_id=participant.id
           AND link.state='active'
          LEFT JOIN ${primary("analytics_owner_state")} owner_state
            ON owner_state.source_id=$1
           AND owner_state.owner_digest=link.owner_digest
         WHERE participant.state='active'
           AND ($2::text IS NULL OR participant.id > $2)
         ORDER BY participant.id
         LIMIT ${READINESS_PAGE_SIZE + 1}`, [POSTGRES_CANONICAL_SOURCE_ID, checkpoint.cursor]), {
      operation: "app.global_readiness.primary_owners",
      preserveSafeError: preserveApiError,
    });
    const page = owners.rows.slice(0, READINESS_PAGE_SIZE);
    if (page.some((row) => (
      typeof row.participant_id !== "string"
      || !HEX64.test(row.owner_digest)
      || row.owner_state !== "active"
    ))) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    if (page.length !== 0) {
      const participantDigests = await Promise.all(
        page.map((row) => participantDeletionDigest(row.participant_id)),
      );
      const ownerDigests = page.map((row) => row.owner_digest);
      const ledgerCheck = await withPostgresRead(ledgerPool, async (client) => client.query(
        `SELECT 1
           FROM ${ledger("storage_erasure_jobs")}
          WHERE state IN ('pending','complete')
            AND (participant_digest = ANY($1::text[]) OR owner_digest = ANY($2::text[]))
          UNION ALL
         SELECT 1
           FROM ${ledger("deletion_tombstones")}
          WHERE retain_until > clock_timestamp()
            AND participant_digest = ANY($1::text[])
          LIMIT 1`, [participantDigests, ownerDigests]), {
          operation: "app.global_readiness.ledger_revalidate",
          preserveSafeError: preserveApiError,
        });
      if (ledgerCheck.rows.length !== 0) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }

    const nextCursor = page.at(-1)?.participant_id ?? null;
    const complete = owners.rows.length <= READINESS_PAGE_SIZE;
    await withPostgresMutation(primaryPool, async (client) => {
      const advanced = await client.query(
        `UPDATE ${primary("postgres_readiness_sweeps")}
            SET cursor_participant_id=$1,
                state=$2,
                ledger_watermark=CASE WHEN $2='complete' THEN clock_timestamp() ELSE ledger_watermark END,
                checked_at=clock_timestamp()
          WHERE singleton=1 AND process_epoch=$3 AND source_id=$4
            AND source_epoch=$5
            AND cursor_participant_id IS NOT DISTINCT FROM $6`,
        [nextCursor, complete ? "complete" : "pending", processEpoch,
          POSTGRES_CANONICAL_SOURCE_ID, sourceEpoch, checkpoint.cursor],
      );
      if (advanced.rowCount !== 1) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }, {
      operation: "app.global_readiness.advance",
      preserveSafeError: preserveApiError,
    });
    if (!complete) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }

  async function deviceForUploadAuthorization(authorizationId: string): Promise<{
    readonly participantId: string;
    readonly deviceId: string;
  } | null> {
    const row = await authority.devices.readUpload(authorizationId);
    return row === null ? null : {
      participantId: row.participantId,
      deviceId: row.issuedByDeviceId,
    };
  }

  async function assertTelemetryV1Consent(participantId: string, deviceId: string): Promise<void> {
    const result = await withPostgresRead(primaryPool, async (client) => client.query(
      `SELECT 1
         FROM ${primary("telemetry_v1_device_consents")} consent
         JOIN ${primary("telemetry_transport_formats")} format
           ON format.schema_version='telemetry-contribution-v1.0'
          AND format.lifecycle='accepted'
         LEFT JOIN ${primary("telemetry_transport_participant_floors")} participant_floor
           ON participant_floor.participant_id=consent.participant_id
         LEFT JOIN ${primary("telemetry_transport_device_floors")} device_floor
           ON device_floor.participant_id=consent.participant_id
          AND device_floor.device_id=consent.device_id
        WHERE consent.participant_id=$1 AND consent.device_id=$2
          AND consent.telemetry_schema_version='telemetry-contribution-v1.0'
          AND consent.field_dictionary_version='telemetry-v1.0-registry-2026-08-07.1'
          AND consent.privacy_contract_version='ongoing-privacy-safe-telemetry-v1.0'
          AND format.format_rank >= GREATEST(
            COALESCE(participant_floor.minimum_rank,1),
            COALESCE(device_floor.minimum_rank,1)
          )`,
      [participantId, deviceId],
    ), {
      operation: "app.telemetry_v1_consent",
      preserveSafeError: preserveApiError,
    });
    if (result.rows.length !== 1) throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }

  async function registerQuarantine(input: {
    readonly contributionId: string;
    readonly objectKey: string;
    readonly registeredAt: string;
  }): Promise<void> {
    await lifecycle.registerQuarantine({
      objectKind: "telemetry_v1",
      contributionId: input.contributionId,
      objectKey: input.objectKey,
      registeredAt: input.registeredAt,
    });
  }

  async function clearQuarantine(input: { readonly contributionId: string; readonly objectKey: string }): Promise<void> {
    await lifecycle.clearQuarantine({ objectKey: input.objectKey });
  }

  async function bootstrapOwner(participantId: string, now: string): Promise<string> {
    const candidateDigest = randomOpaqueDigest();
    const candidateNamespace = randomOpaqueDigest();
    await withPostgresMutation(primaryPool, async (client) => {
      const source = await client.query<{ source_id: string; authority_epoch: number }>(
        `INSERT INTO ${primary("storage_source_state")}(singleton,source_id,authority_epoch)
         VALUES(1,$1,1) ON CONFLICT(singleton) DO NOTHING
         RETURNING source_id,authority_epoch`, [POSTGRES_CANONICAL_SOURCE_ID]);
      const sourceRow = source.rows[0] ?? (await client.query<{ source_id: string; authority_epoch: number }>(
        `SELECT source_id,authority_epoch FROM ${primary("storage_source_state")} WHERE singleton=1`, [],
      )).rows[0];
      if (!sourceRow || sourceRow.source_id !== POSTGRES_CANONICAL_SOURCE_ID) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      const existingAttribution = await client.query<{ namespace: string }>(
        `SELECT namespace FROM ${primary("attribution_enrollments")}
          WHERE participant_id=$1`, [participantId]);
      const namespace = existingAttribution.rows[0]?.namespace ?? candidateNamespace;
      if (!HEX64.test(namespace)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const attribution = await client.query(
        `INSERT INTO ${primary("attribution_enrollments")}(participant_id,namespace,created_at)
         VALUES($1,$2,$3)
         ON CONFLICT(participant_id) DO NOTHING`,
        [participantId, namespace, now],
      );
      if (attribution.rowCount !== 1 && !existingAttribution.rows[0]) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      const existingLink = await client.query<{ owner_digest: string; state: string }>(
        `SELECT owner_digest,state FROM ${primary("storage_v11_owner_links")}
          WHERE participant_id=$1`, [participantId]);
      const digest = existingLink.rows[0]?.owner_digest ?? candidateDigest;
      if (!HEX64.test(digest) || (existingLink.rows[0] && existingLink.rows[0].state !== "active")) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      const link = await client.query(
        `INSERT INTO ${primary("storage_v11_owner_links")}
          (participant_id,owner_digest,state,generation_id,head_revision,object_digest,manifest_digest)
         VALUES($1,$2,'active','owner-bootstrap-1',0,$2,$2)
         ON CONFLICT(participant_id) DO NOTHING
         RETURNING participant_id`, [participantId, digest],
      );
      if (link.rowCount !== 1 && !existingLink.rows[0]) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const resolvedLink = existingLink.rows[0] ?? (await client.query<{ owner_digest: string }>(
        `SELECT owner_digest FROM ${primary("storage_v11_owner_links")} WHERE participant_id=$1`, [participantId],
      )).rows[0];
      if (!resolvedLink || !HEX64.test(resolvedLink.owner_digest)) {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      const owner = await client.query(
        `INSERT INTO ${primary("analytics_owner_state")}
          (source_id,owner_digest,revision,authority_epoch,state)
         VALUES($1,$2,0,$3,'active')
         ON CONFLICT(source_id,owner_digest) DO NOTHING`,
        [POSTGRES_CANONICAL_SOURCE_ID, resolvedLink.owner_digest, sourceRow.authority_epoch],
      );
      if (owner.rowCount !== 1) {
        const existingOwner = await client.query<{ state: string }>(
          `SELECT state FROM ${primary("analytics_owner_state")}
            WHERE source_id=$1 AND owner_digest=$2`,
          [POSTGRES_CANONICAL_SOURCE_ID, resolvedLink.owner_digest],
        );
        if (existingOwner.rows[0]?.state !== "active") {
          throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
      }
      await client.query(
        `INSERT INTO ${primary("telemetry_transport_participant_floors")}
          (participant_id,minimum_rank,revision,changed_at)
         VALUES($1,1,0,$2) ON CONFLICT(participant_id) DO NOTHING`, [participantId, now],
      );
      await client.query(
        `INSERT INTO ${primary("input_versions")}(participant_id,revision)
         VALUES($1,0) ON CONFLICT(participant_id) DO NOTHING`, [participantId],
      );
    }, {
      operation: "app.bootstrap_owner",
      preserveSafeError: preserveApiError,
    });
    return ownerDigest(participantId);
  }

  async function bootstrapDeviceTransport(
    participantId: string,
    deviceId: string,
    now: string,
  ): Promise<void> {
    await withPostgresMutation(primaryPool, async (client) => {
      const device = await client.query(
        `SELECT id,paired_via_pairing_id FROM ${primary("device_credentials")}
          WHERE id=$1 AND participant_id=$2 AND state='active'`, [deviceId, participantId],
      );
      if (device.rowCount !== 1) throw new ApiError(401, "PAIRING_AUTH_INVALID");
      const pairingId = device.rows[0]?.paired_via_pairing_id;
      if (typeof pairingId !== "string") throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const pairing = await authority.devices.readPairing(pairingId);
      if (!pairing || pairing.participantId !== participantId || pairing.state !== "consumed") {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      await client.query(
        `INSERT INTO ${primary("telemetry_transport_device_floors")}
          (participant_id,device_id,minimum_rank,revision,changed_at)
         VALUES($1,$2,1,0,$3) ON CONFLICT(participant_id,device_id) DO NOTHING`,
        [participantId, deviceId, now],
      );
      if (pairing.transportConsentVersion === ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION) {
        await client.query(
          `INSERT INTO ${primary("telemetry_v1_device_consents")}
            (participant_id,device_id,telemetry_schema_version,field_dictionary_version,
             privacy_contract_version,consented_at)
           VALUES($1,$2,'telemetry-contribution-v1.0',$3,'ongoing-privacy-safe-telemetry-v1.0',$4)
           ON CONFLICT(participant_id,device_id) DO NOTHING`,
          [participantId, deviceId, INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION, now],
        );
      }
    }, {
      operation: "app.bootstrap_device_transport",
      preserveSafeError: preserveApiError,
    });
  }

  async function enroll(input: {
    readonly consentVersion: string;
    readonly deviceBootstrap: boolean;
    readonly identityLinkKey?: string | null;
    readonly identityCooldownDigest?: string | null;
    readonly nowEpoch?: number;
  }): Promise<PostgresEnrollment> {
    const enrollment = await enrollParticipant(
      authority,
      input.consentVersion,
      null,
      {
        deviceBootstrap: input.deviceBootstrap,
        identityLinkKey: input.identityLinkKey,
        identityCooldownDigest: input.identityCooldownDigest,
        nowEpoch: input.nowEpoch,
        authorityBootstrap: {
          sourceId: POSTGRES_CANONICAL_SOURCE_ID,
          ownerDigest: randomOpaqueDigest(),
          attributionNamespace: randomOpaqueDigest(),
          now: new Date(input.nowEpoch ?? Date.now()).toISOString(),
        },
      },
    );
    return enrollment as PostgresEnrollment;
  }

  async function createPairing(input: {
    readonly participantId: string;
    readonly sessionId: string;
    readonly participantConsentVersion: string;
    readonly transportConsentVersion?: DeviceTransportConsentVersion;
    readonly nowEpoch?: number;
  }): Promise<{ readonly pairingCode: string; readonly expiresAt: string }> {
    return createDevicePairing(
      authority as DeviceSource,
      input.participantId,
      input.sessionId,
      input.participantConsentVersion,
      input.nowEpoch,
      {},
      input.transportConsentVersion,
    );
  }

  async function claimPairing(input: {
    readonly authorizationHeader: string | null;
    readonly deviceId: string;
    readonly deviceSecretHashHex: string;
    readonly previousDeviceAuthorization?: string | null;
    readonly nowEpoch?: number;
  }): Promise<{
    readonly deviceId: string;
    readonly state: "active";
    readonly scope: "upload_registration";
    readonly expiresAt: string;
  }> {
    const result = await claimDevicePairing(
      authority as DeviceSource,
      input.authorizationHeader,
      input.deviceId,
      input.deviceSecretHashHex,
      input.nowEpoch,
      {},
      input.previousDeviceAuthorization ?? null,
    );
    return result;
  }

  async function createUploadAuthorization(input: {
    readonly device: DevicePrincipal;
    readonly envelopeDigest: string;
    readonly bodyBytes: number;
    readonly nowEpoch?: number;
  }): Promise<{ readonly uploadAuthorization: string; readonly expiresAt: string }> {
    return createDeviceUploadAuthorization(
      authority as DeviceSource,
      input.device,
      input.envelopeDigest,
      input.bodyBytes,
      input.nowEpoch,
    );
  }

  return Object.freeze({
    sourceId: POSTGRES_CANONICAL_SOURCE_ID,
    sourceNamespace: POSTGRES_CANONICAL_SOURCE_NAMESPACE,
    ownerDigest,
    assertIdentityConfiguration,
    hasIdentityCooldownDigest,
    assertCollectionControl,
    assertOwnerAdmission,
    assertGlobalReadiness,
    deviceForUploadAuthorization,
    assertTelemetryV1Consent,
    registerQuarantine,
    clearQuarantine,
    enroll,
    createPairing,
    claimPairing,
    createUploadAuthorization,
  });
}
