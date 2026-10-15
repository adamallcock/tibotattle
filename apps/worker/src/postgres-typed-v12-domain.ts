import {
  preparePostgresClassificationActivation, PostgresClassificationActivationRefusalError,
} from "./postgres-classification-activation";
import { postgresClassificationLinkPredicate } from "./postgres-classification-links";
import { PostgresClassificationCorrectionError } from "./postgres-classification-correction";
import {
  canonicalTelemetryV12Json,
  MAX_TELEMETRY_V12_DOMAIN_DAYS,
  parseTelemetryV12DomainManifest,
  telemetryV12DomainManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { assertPostgresCollectionControl } from "./postgres-collection-controls";
import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  assertPostgresTypedV12WriteAllowed,
  type PostgresTypedV12Principal,
} from "./postgres-typed-v12-admission";
import {
  classifyPostgresTelemetryV12StorageError,
  postgresTelemetryV12StorageFailure,
} from "./postgres-telemetry-v12-storage-refusal";
import {
  markTelemetryActivationFailureStage, markTelemetryActivationRefusalPhase,
  type TelemetryActivationFailureStage, type TelemetryActivationRefusalPhase,
} from "./telemetry-activation-observation";
import type {
  TelemetryV12DomainActivation as TelemetryV12DomainActivationBase,
  TelemetryV12DomainPredecessor,
} from "./telemetry-v12-domain";

/** The v1.1-style activation receipt, including the optional 'unchanged'
 * acknowledgement the shipped client already accepts for v1.2. */
export interface TelemetryV12DomainActivation extends TelemetryV12DomainActivationBase {
  unchanged?: true;
  requestedManifestDigest?: string;
}

const DAY_MS = 86_400_000;
const PREDECESSOR_TTL_MS = 24 * 60 * 60 * 1_000;
// Must match the D1 V12_DOMAIN_METHOD_VERSION: both pin predecessor state only.
const DOMAIN_METHOD_VERSION = "v12-complete-domain-2";
// The classification proof reads the whole domain: 2026-10-10 production
// measured single statements of 10.6-15.4 s for 128- and 238-day domains, so
// the 10 s default refused every such activation. Same budget as v1.1.
const ACTIVATION_STATEMENT_TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

interface StateRow {
  input_revision: string | number;
  generation_id: string | null;
  manifest_digest: string | null;
}

interface ReadyManifestRow {
  id: string;
  chunk_day: string;
  manifest_digest: string;
}

interface ReadyManifestPairRow {
  chunk_day: string;
  earliest_id: string;
  earliest_digest: string;
  latest_id: string;
  latest_digest: string;
}

interface ActiveDomainRow {
  id: string;
  manifest_digest: string;
  from_day: string;
  through_day: string;
}

interface PredecessorRow {
  input_revision: string | number;
  from_day: string;
  through_day: string;
  previous_generation_id: string | null;
  legacy_fingerprint: string;
  days_json: string | null;
  expires_at: string | Date;
  consumed_at: string | Date | null;
}

export interface TelemetryV12DomainDayReference {
  readonly day: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
}

type DomainDayReference = TelemetryV12DomainDayReference;

export interface TelemetryV12OwnerRecoveryPredecessor {
  readonly predecessor: TelemetryV12DomainPredecessor;
  readonly candidateDays: readonly DomainDayReference[];
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function revision(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return parsed;
}

function utcDay(value: string): boolean {
  return DAY.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8_640_000_000_000_000) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return new Date(epoch).toISOString();
}

// A table constraint failure is the paced 503 TELEMETRY_STORAGE_CONSTRAINT,
// a concurrent writer or telemetry_v12 unique key is 409, and a lock or
// statement timeout is an unpaced 503, never a 500.
function preserveSafeError(error: unknown): Error | null {
  return classifyPostgresTelemetryV12StorageError(error);
}

function conflict(phase?: TelemetryActivationRefusalPhase): ApiError {
  const error = new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return phase ? markTelemetryActivationRefusalPhase(error, phase) : error;
}

/** Transaction lifecycle failures are already normalized to a safe operation
 * label. transaction_setup means BEGIN only; SET LOCAL timeout setup runs
 * before the callback and stays unattributed. Keep lifecycle failures separate
 * from proof-query failures. */
function transactionFailureStage(error: unknown, operation: string):
  { readonly matched: false } | { readonly matched: true; readonly stage: TelemetryActivationFailureStage | null } {
  let storageError = false;
  try {
    storageError = error instanceof PostgresStorageError;
  } catch { return { matched: true, stage: null }; }
  if (!storageError) return { matched: false };
  try {
    const safeOperation = (error as PostgresStorageError).operation;
    switch (safeOperation) {
      case operation: return { matched: false };
      case `${operation}.connect`: return { matched: true, stage: null };
      case `${operation}.begin`: return { matched: true, stage: "transaction_setup" };
      case `${operation}.commit`: return { matched: true, stage: "transaction_finalization" };
      case `${operation}.rollback`: return { matched: true, stage: "transaction_rollback" };
      case `${operation}.release`: return { matched: true, stage: "transaction_release" };
      default: return { matched: true, stage: null };
    }
  } catch { return { matched: true, stage: null }; }
}

async function queryWithFailureStage<Row extends object>(
  client: PostgresClient,
  stage: TelemetryActivationFailureStage,
  onFailureStage: ((stage: TelemetryActivationFailureStage) => void) | undefined,
  text: string,
  values?: unknown[],
): Promise<PostgresQueryResult<Row>> {
  try {
    return await client.query<Row>(text, values);
  } catch (error) {
    try { onFailureStage?.(stage); } catch { /* diagnostics cannot change transaction behavior */ }
    throw error;
  }
}

function trackActivationQueryFailures(
  client: PostgresClient,
  currentStage: () => TelemetryActivationFailureStage,
  shouldTrack: () => boolean,
  onFailureStage: (stage: TelemetryActivationFailureStage) => void,
): PostgresClient {
  return {
    async query<Row extends object>(text: string, values?: unknown[]): Promise<PostgresQueryResult<Row>> {
      try {
        return await client.query<Row>(text, values);
      } catch (error) {
        if (shouldTrack()) {
          try { onFailureStage(currentStage()); } catch { /* diagnostics cannot change transaction behavior */ }
        }
        throw error;
      }
    },
    release: (discard?: boolean) => client.release(discard),
  };
}

/** A changed manifest on the same day may append records, but cannot erase or
 * change an occurrence already admitted by the predecessor. Compare the
 * immutable canonical digests in SQL; never load a day's records into JS. */
async function assertSameDaySuccessorClosure(
  client: PostgresClient,
  schema: string,
  principal: PostgresTypedV12Principal,
  previous: DomainDayReference,
  successor: DomainDayReference,
  activationDigest: string,
  onFailureStage?: (stage: TelemetryActivationFailureStage) => void,
): Promise<void> {
  for (const day of [previous, successor]) {
    const manifest = await queryWithFailureStage<{ expected_chunk_count: number }>(client, "same_day_manifest", onFailureStage,
      `SELECT expected_chunk_count
         FROM ${table(schema, "telemetry_v12_day_manifests")}
        WHERE id = $1 AND participant_id = $2 AND device_id = $3
          AND chunk_day = $4::date AND manifest_digest = $5 AND state = 'ready'
        FOR SHARE`,
      [day.manifestId, principal.participantId, principal.deviceId,
        day.day, day.manifestDigest],
    );
    if (manifest.rows.length !== 1) throw conflict("closure");
    const summary = await queryWithFailureStage<{
      chunks: string; records: string; typed_records: string; legacy_records: string;
    }>(client, "same_day_summary", onFailureStage,
      `SELECT
        (SELECT count(*)::text FROM ${table(schema, "telemetry_v12_chunks")}
          WHERE manifest_id = $1) AS chunks,
        (SELECT COALESCE(sum(record_count), 0)::text
           FROM ${table(schema, "telemetry_v12_chunks")}
          WHERE manifest_id = $1) AS records,
        (SELECT count(*)::text FROM ${table(schema, "telemetry_v12_typed_records")}
          WHERE manifest_id = $1) AS typed_records,
        (SELECT count(*)::text FROM ${table(schema, "telemetry_v12_records")}
          WHERE manifest_id = $1) AS legacy_records`,
      [day.manifestId],
    );
    const row = summary.rows[0];
    const expectedChunks = manifest.rows[0]!.expected_chunk_count;
    if (!row || !Number.isSafeInteger(expectedChunks)
        || Number(row.chunks) !== expectedChunks
        || Number(row.records) > expectedChunks * 200
        || row.records !== row.typed_records
        || row.legacy_records !== "0") {
      throw markTelemetryActivationRefusalPhase(new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE"), "closure");
    }
  }
  const missing = await queryWithFailureStage<Record<string, never>>(client, "same_day_occurrence", onFailureStage,
    `SELECT 1
       FROM ${table(schema, "telemetry_v12_typed_records")} old_record
      WHERE old_record.manifest_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM ${table(schema, "telemetry_v12_typed_records")} new_record
           WHERE new_record.manifest_id = $2
             AND new_record.stream = old_record.stream
             AND new_record.occurrence_id = old_record.occurrence_id
             AND (new_record.canonical_digest = old_record.canonical_digest
               OR ${postgresClassificationLinkPredicate(schema,"old_record.id","new_record.id",12,12,"$3::text")})
        )
      LIMIT 1`,
    [previous.manifestId, successor.manifestId,activationDigest],
  );
  if (missing.rows.length !== 0) throw conflict("closure");
}

async function stateRow(client: PostgresClient, schema: string, participantId: string): Promise<StateRow> {
  // Acquire the participant's serialization row before reading the head. A
  // joined SELECT ... FOR UPDATE can wait on v while retaining the statement's
  // earlier READ COMMITTED snapshot for h, so a later writer could otherwise
  // compare against a stale generation and overwrite the head.
  const version = await client.query<Pick<StateRow, "input_revision">>(
    `SELECT v.revision AS input_revision
       FROM ${table(schema, "participants")} p
       JOIN ${table(schema, "community_analytical_input_versions")} v
         ON v.participant_id = p.id
      WHERE p.id = $1 AND p.state = 'active'
      FOR UPDATE OF v`,
    [participantId],
  );
  const locked = version.rows[0];
  if (!locked || version.rows.length !== 1) throw conflict("state");

  // This separate statement obtains a fresh READ COMMITTED snapshot after the
  // serialization lock is held. Every predecessor issue and activation reads
  // the head only after any earlier participant mutation has committed.
  const head = await client.query<Pick<StateRow, "generation_id" | "manifest_digest">>(
    `SELECT h.generation_id, d.manifest_digest
       FROM ${table(schema, "participants")} p
       LEFT JOIN ${table(schema, "telemetry_v12_domain_heads")} h
         ON h.participant_id = p.id
       LEFT JOIN ${table(schema, "telemetry_v12_domains")} d ON d.id = h.generation_id
      WHERE p.id = $1 AND p.state = 'active'`,
    [participantId],
  );
  const current = head.rows[0];
  if (!current || head.rows.length !== 1) throw conflict("state");
  revision(locked.input_revision);
  return {
    input_revision: locked.input_revision,
    generation_id: current.generation_id,
    manifest_digest: current.manifest_digest,
  };
}

async function activeDomainByDigest(
  client: PostgresClient,
  schema: string,
  principal: PostgresTypedV12Principal,
  digest: string,
): Promise<ActiveDomainRow | null> {
  const result = await client.query<ActiveDomainRow>(
    `SELECT d.id, d.manifest_digest,
            to_char(d.from_day, 'YYYY-MM-DD') AS from_day,
            to_char(d.through_day, 'YYYY-MM-DD') AS through_day
       FROM ${table(schema, "telemetry_v12_domain_heads")} h
       JOIN ${table(schema, "telemetry_v12_domains")} d ON d.id = h.generation_id
      WHERE h.participant_id = $1 AND d.device_id = $2 AND d.manifest_digest = $3`,
    [principal.participantId, principal.deviceId, digest],
  );
  return result.rows[0] ?? null;
}

function activationResult(row: ActiveDomainRow, replay: boolean): TelemetryV12DomainActivation {
  return {
    schemaVersion: "telemetry-domain-activation-v1.2",
    generationId: row.id,
    manifestDigest: row.manifest_digest,
    fromDay: row.from_day,
    throughDay: row.through_day,
    replay,
  };
}

/** Current-main v1.2 day-domain operations on the same primary PostgreSQL schema. */
export function createPostgresTypedV12Domain(
  pool: PostgresPool,
  options: { readonly schema?: PostgresSchemaConfig } = {},
): {
  createPredecessor(
    principal: PostgresTypedV12Principal,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainPredecessor>;
  createOwnerRecoveryPredecessor(
    principal: PostgresTypedV12Principal,
    nowEpoch?: number,
  ): Promise<TelemetryV12OwnerRecoveryPredecessor>;
  activate(
    principal: PostgresTypedV12Principal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainActivation>;
  activateOwnerRecovery(
    principal: PostgresTypedV12Principal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainActivation>;
} {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  const schema = quotePostgresIdentifier(config.primarySchema);
  const authorityOptions = { schema: config };

  const issuePredecessor = async (
    principal: PostgresTypedV12Principal,
    nowEpoch: number,
    ownerRecovery: boolean,
  ): Promise<TelemetryV12DomainPredecessor | TelemetryV12OwnerRecoveryPredecessor> => {
      const now = iso(nowEpoch);
      const expiresAt = iso(nowEpoch + PREDECESSOR_TTL_MS);
      return withPostgresMutation(pool, async (client) => {
        if (ownerRecovery) {
          await assertPostgresCollectionControl(client, config.primarySchema, "processing", { forShare: true });
        }
        await assertPostgresTypedV12WriteAllowed(client, principal, nowEpoch, authorityOptions);
        const state = await stateRow(client, schema, principal.participantId);
        if (ownerRecovery && state.generation_id !== null) throw conflict("state");
        // One row per ready day: its earliest ready manifest, as D1 reads it.
        // A device keeps every earlier ready manifest of a day (new records or
        // a parser release re-digest the day, and 0035 retains ready rows), so
        // its ready rows grow while its days do not. The bound is on days; a
        // row bound would refuse a small domain with a 400 the client treats
        // as final. COLLATE "C" keeps SQLite's BINARY tie-break on id.
        let days: ReadyManifestRow[];
        let candidateDays: TelemetryV12DomainDayReference[] | null = null;
        if (ownerRecovery) {
          const paired = await client.query<ReadyManifestPairRow>(
            `SELECT to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day,
                    max(id) FILTER (WHERE earliest_version = 1) AS earliest_id,
                    max(manifest_digest) FILTER (WHERE earliest_version = 1) AS earliest_digest,
                    max(id) FILTER (WHERE latest_version = 1) AS latest_id,
                    max(manifest_digest) FILTER (WHERE latest_version = 1) AS latest_digest
               FROM (
                 SELECT id, chunk_day, manifest_digest,
                        row_number() OVER (
                          PARTITION BY chunk_day ORDER BY created_at, id COLLATE "C"
                        ) AS earliest_version,
                        row_number() OVER (
                          PARTITION BY chunk_day ORDER BY created_at DESC, id COLLATE "C" DESC
                        ) AS latest_version
                   FROM ${table(schema, "telemetry_v12_day_manifests")}
                  WHERE participant_id = $1 AND device_id = $2 AND state = 'ready'
               ) ranked
              GROUP BY chunk_day
              ORDER BY chunk_day LIMIT $3`,
            [principal.participantId, principal.deviceId, MAX_TELEMETRY_V12_DOMAIN_DAYS + 1],
          );
          if (paired.rows.length > MAX_TELEMETRY_V12_DOMAIN_DAYS) {
            throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
          }
          const earliestByDay = new Map<string, ReadyManifestRow>();
          const latestByDay = new Map<string, ReadyManifestRow>();
          for (const row of paired.rows) {
            if (!utcDay(row.chunk_day) || typeof row.earliest_id !== "string"
                || typeof row.latest_id !== "string" || !SHA256.test(row.earliest_digest)
                || !SHA256.test(row.latest_digest) || earliestByDay.has(row.chunk_day)
                || latestByDay.has(row.chunk_day)) {
              throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
            }
            earliestByDay.set(row.chunk_day, {
              id: row.earliest_id, chunk_day: row.chunk_day, manifest_digest: row.earliest_digest,
            });
            latestByDay.set(row.chunk_day, {
              id: row.latest_id, chunk_day: row.chunk_day, manifest_digest: row.latest_digest,
            });
          }
          days = [...earliestByDay.values()].sort((a, b) => a.chunk_day.localeCompare(b.chunk_day));
          candidateDays = [...latestByDay.values()].sort((a, b) => a.chunk_day.localeCompare(b.chunk_day))
            .map((row) => ({ day: row.chunk_day, manifestId: row.id, manifestDigest: row.manifest_digest }));
          if (days.length !== candidateDays.length || days.some((day, index) => day.chunk_day !== candidateDays![index]!.day)) {
            throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          }
          if (candidateDays.length === 0) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          const probe = {
            schemaVersion: "telemetry-domain-manifest-v1.2",
            fromDay: candidateDays[0]!.day,
            throughDay: candidateDays.at(-1)!.day,
            predecessor: { token: "00000000-0000-4000-8000-000000000000",
              previousGenerationId: null, legacyFingerprint: "0".repeat(64) },
            days: candidateDays,
            manifestDigest: "0".repeat(64),
          };
          try {
            parseTelemetryV12DomainManifest(probe);
          } catch {
            throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
          }
        } else {
          const result = await client.query<ReadyManifestRow>(
            `SELECT id, to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day, manifest_digest
               FROM (
                 SELECT id, chunk_day, manifest_digest,
                        row_number() OVER (
                          PARTITION BY chunk_day ORDER BY created_at, id COLLATE "C"
                        ) AS version
                   FROM ${table(schema, "telemetry_v12_day_manifests")}
                  WHERE participant_id = $1 AND device_id = $2 AND state = 'ready'
               ) m
              WHERE version = 1
              ORDER BY m.chunk_day LIMIT $3`,
            [principal.participantId, principal.deviceId, MAX_TELEMETRY_V12_DOMAIN_DAYS + 1],
          );
          if (result.rows.length > MAX_TELEMETRY_V12_DOMAIN_DAYS) {
            throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
          }
          // The query yields each day once; a repeated day is storage failure.
          const byDay = new Map<string, ReadyManifestRow>();
          for (const row of result.rows) {
            if (!utcDay(row.chunk_day) || !SHA256.test(row.manifest_digest)
                || byDay.has(row.chunk_day)) {
              throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
            }
            byDay.set(row.chunk_day, row);
          }
          days = [...byDay.values()].sort((a, b) => a.chunk_day.localeCompare(b.chunk_day));
        }
        // Same contract as the D1 predecessor: the shipped client asks for
        // this before it registers any day, so a device's first closure is
        // seeded with the current UTC day (v1.1 parity) instead of refused.
        // With ready manifests the range is exactly their days, as before.
        const fromDay = days[0]?.chunk_day ?? now.slice(0, 10);
        const throughDay = days.at(-1)?.chunk_day ?? fromDay;
        if ((Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1
            > MAX_TELEMETRY_V12_DOMAIN_DAYS) {
          throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
        }
        // Pin predecessor state only. The client re-reads the predecessor
        // after staging its own days and stops on a changed fingerprint, so
        // this run's newly ready manifests must not move it. days_json still
        // records the ready days for activation's same-day closure proof.
        const legacyFingerprint = await sha256Hex(canonicalJson({
          method: DOMAIN_METHOD_VERSION,
          participantId: principal.participantId,
          inputRevision: revision(state.input_revision),
          previousGenerationId: state.generation_id,
          previousManifestDigest: state.manifest_digest,
        }));
        const token = crypto.randomUUID();
        const tokenHash = await sha256Hex(token);
        const daysJson = canonicalTelemetryV12Json(days.map((item) => ({
          day: item.chunk_day,
          manifestId: item.id,
          manifestDigest: item.manifest_digest,
        })));
        // D1's rule (telemetry-v12-domain.ts): drop this device's unconsumed
        // predecessors that are expired or beyond the newest seven, unless a
        // domain references them. An 'unchanged' receipt consumes none, and
        // the client asks for two per pass, so without the newest-seven bound
        // repeated unchanged passes would reach the outstanding cap below.
        await client.query(
          `DELETE FROM ${table(schema, "telemetry_v12_domain_predecessors")} p
            WHERE p.participant_id = $1 AND p.device_id = $2
              AND p.consumed_at IS NULL
              AND (p.expires_at <= $3::timestamptz OR p.token_hash IN (
                SELECT x.token_hash
                  FROM ${table(schema, "telemetry_v12_domain_predecessors")} x
                 WHERE x.participant_id = $1 AND x.device_id = $2
                   AND x.consumed_at IS NULL
                 ORDER BY x.created_at DESC, x.token_hash
                 OFFSET 7
              ))
              AND NOT EXISTS (
                SELECT 1 FROM ${table(schema, "telemetry_v12_domains")} d
                 WHERE d.predecessor_token_hash = p.token_hash
              )`,
          [principal.participantId, principal.deviceId, now],
        );
        const outstanding = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM ${table(schema, "telemetry_v12_domain_predecessors")}
            WHERE participant_id = $1 AND device_id = $2
              AND consumed_at IS NULL AND expires_at > $3::timestamptz`,
          [principal.participantId, principal.deviceId, now],
        );
        if (Number(outstanding.rows[0]?.count) >= 8) throw conflict();
        await client.query(
          `INSERT INTO ${table(schema, "telemetry_v12_domain_predecessors")} (
            token_hash, participant_id, device_id, previous_generation_id,
            legacy_fingerprint, input_revision, from_day, through_day,
            days_json, created_at, expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11)`,
          [tokenHash, principal.participantId, principal.deviceId, state.generation_id,
            legacyFingerprint, revision(state.input_revision), fromDay, throughDay,
            daysJson, now, expiresAt],
        );
        const predecessor: TelemetryV12DomainPredecessor = {
          schemaVersion: "telemetry-domain-predecessor-v1.2" as const,
          token, previousGenerationId: state.generation_id,
          legacyFingerprint, fromDay, throughDay, expiresAt,
        };
        return ownerRecovery ? { predecessor, candidateDays: candidateDays! } : predecessor;
      }, {
        operation: ownerRecovery ? "telemetry.v12.owner_recovery.predecessor" : "telemetry.v12.domain.predecessor",
        preserveSafeError,
      }).catch((error) => {
        throw postgresTelemetryV12StorageFailure(error);
      });
    };

  const activateDomain = async (
    principal: PostgresTypedV12Principal,
    value: unknown,
    nowEpoch: number,
    ownerRecovery: boolean,
  ): Promise<TelemetryV12DomainActivation> => {
      let manifest: ReturnType<typeof parseTelemetryV12DomainManifest>;
      try {
        manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DomainManifest(value)));
      } catch {
        throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
      }
      if (await sha256Hex(telemetryV12DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) {
        throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
      }
      const tokenHash = await sha256Hex(manifest.predecessor.token);
      // Per-call state avoids any cross-talk between concurrent activations.
      let classificationFailureStage: TelemetryActivationFailureStage | null = null;
      let transactionQueryStage: TelemetryActivationFailureStage = "activation_preflight";
      let preciseQueryStageActive = false;
      const operation = ownerRecovery ? "telemetry.v12.owner_recovery.activate" : "telemetry.v12.domain.activate";
      return withPostgresMutation(pool, async (connection) => {
        const client = trackActivationQueryFailures(connection, () => transactionQueryStage,
          () => !preciseQueryStageActive, (stage) => { classificationFailureStage ??= stage; });
        if (ownerRecovery) {
          await assertPostgresCollectionControl(client, config.primarySchema, "processing", { forShare: true });
        }
        await assertPostgresTypedV12WriteAllowed(client, principal, nowEpoch, authorityOptions);
        const ownerState = ownerRecovery ? await stateRow(client, schema, principal.participantId) : null;
        if (ownerState && ownerState.generation_id !== null) throw conflict("state");
        const replay = await activeDomainByDigest(client, schema, principal, manifest.manifestDigest);
        if (replay) return activationResult(replay, true);
        const predecessorResult = await client.query<PredecessorRow>(
          `SELECT input_revision, to_char(from_day, 'YYYY-MM-DD') AS from_day,
                  to_char(through_day, 'YYYY-MM-DD') AS through_day,
                  previous_generation_id, legacy_fingerprint, days_json,
                  expires_at, consumed_at
             FROM ${table(schema, "telemetry_v12_domain_predecessors")}
            WHERE token_hash = $1 AND participant_id = $2 AND device_id = $3
            FOR UPDATE`,
          [tokenHash, principal.participantId, principal.deviceId],
        );
        const predecessor = predecessorResult.rows[0];
        const clock = await client.query<{ now: Date | string }>(
          "SELECT clock_timestamp() AS now",
        );
        const actualNow = new Date(clock.rows[0]?.now ?? NaN);
        if (!predecessor || predecessor.consumed_at !== null
            || !Number.isFinite(actualNow.getTime())
            || new Date(predecessor.expires_at).getTime() <= actualNow.getTime()
            || predecessor.previous_generation_id !== manifest.predecessor.previousGenerationId
            || predecessor.legacy_fingerprint !== manifest.predecessor.legacyFingerprint
            || predecessor.days_json === null) {
          throw conflict("state");
        }
        await assertPostgresTypedV12WriteAllowed(client, principal, actualNow.getTime(), authorityOptions);
        const state = ownerState ?? await stateRow(client, schema, principal.participantId);
        if (revision(state.input_revision) !== revision(predecessor.input_revision)
            || state.generation_id !== predecessor.previous_generation_id
            || (ownerRecovery && state.generation_id !== null)
            || manifest.fromDay > predecessor.from_day
            || manifest.throughDay < predecessor.through_day) {
          throw conflict("state");
        }
        const daysJson = canonicalTelemetryV12Json(manifest.days);
        // A fresh predecessor token does not make an unchanged day vector new
        // data. The admission, head and input-revision checks above already
        // passed under their locks; acknowledge only when this device's current
        // head has exactly the requested range and days at that revision, and
        // write nothing: no generation, head move or predecessor consumption.
        // The head is per participant, so a second device never matches here.
        if (predecessor.previous_generation_id !== null) {
          const unchanged = await client.query<ActiveDomainRow>(
            `SELECT d.id, d.manifest_digest,
                    to_char(d.from_day, 'YYYY-MM-DD') AS from_day,
                    to_char(d.through_day, 'YYYY-MM-DD') AS through_day
               FROM ${table(schema, "telemetry_v12_domain_heads")} h
               JOIN ${table(schema, "telemetry_v12_domains")} d
                 ON d.id = h.generation_id AND d.participant_id = h.participant_id
              WHERE h.participant_id = $1 AND h.generation_id = $2 AND d.device_id = $3
                AND d.input_revision = $4 AND d.from_day = $5::date AND d.through_day = $6::date
                AND d.days_json = $7
              FOR SHARE OF h, d`,
            [principal.participantId, predecessor.previous_generation_id, principal.deviceId,
              revision(predecessor.input_revision), manifest.fromDay, manifest.throughDay,
              daysJson],
          );
          const current = unchanged.rows[0];
          if (current) {
            return {
              ...activationResult(current, true),
              unchanged: true as const,
              requestedManifestDigest: manifest.manifestDigest,
            };
          }
        }
        const existingDays = JSON.parse(predecessor.days_json) as unknown;
        if (!Array.isArray(existingDays) || existingDays.some((item) =>
          !item || typeof item !== "object" || typeof item.day !== "string"
          || typeof item.manifestId !== "string" || typeof item.manifestDigest !== "string"
          || !manifest.days.some((day) => day.day === item.day))) {
          throw conflict("state");
        }
        const desiredIds = manifest.days.map((day) => day.manifestId);
        const ready = await client.query<ReadyManifestRow>(
          `SELECT id, to_char(chunk_day, 'YYYY-MM-DD') AS chunk_day, manifest_digest
             FROM ${table(schema, "telemetry_v12_day_manifests")}
            WHERE participant_id = $1 AND device_id = $2 AND state = 'ready'
              AND id = ANY($3::text[]) FOR SHARE`,
          [principal.participantId, principal.deviceId, desiredIds],
        );
        const readyById = new Map(ready.rows.map((row) => [row.id, row]));
        if (readyById.size !== manifest.days.length || manifest.days.some((day) => {
          const row = readyById.get(day.manifestId);
          return !row || row.chunk_day !== day.day || row.manifest_digest !== day.manifestDigest;
        })) {
          throw markTelemetryActivationRefusalPhase(new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE"), "state");
        }
        const generationId = crypto.randomUUID();
        preciseQueryStageActive = true;
        try {
          await preparePostgresClassificationActivation(client,schema,{
            participantId:principal.participantId,deviceId:principal.deviceId,format:12,
            previousGenerationId:predecessor.previous_generation_id,generationId,
            predecessorTokenHash:tokenHash,inputRevision:revision(predecessor.input_revision),
            manifestDigest:manifest.manifestDigest,days:manifest.days,predecessorDays:existingDays as DomainDayReference[],
          }, (stage) => { classificationFailureStage = stage; });
        } catch(error) {
          if(error instanceof PostgresClassificationActivationRefusalError) throw conflict(error.phase);
          if(error instanceof PostgresClassificationCorrectionError) throw conflict();
          throw error;
        } finally {
          preciseQueryStageActive = false;
        }
        for (const previous of existingDays as DomainDayReference[]) {
          const successor = manifest.days.find((day) => day.day === previous.day)!;
          if (previous.manifestId !== successor.manifestId
              || previous.manifestDigest !== successor.manifestDigest) {
            preciseQueryStageActive = true;
            try {
              await assertSameDaySuccessorClosure(client, schema, principal, previous, successor,manifest.manifestDigest,
                (stage) => { classificationFailureStage = stage; });
            } finally {
              preciseQueryStageActive = false;
            }
          }
        }
        transactionQueryStage = "activation_publish";
        const committedAt = actualNow.toISOString();
        await client.query(
          `INSERT INTO ${table(schema, "telemetry_v12_domains")} (
            id, participant_id, device_id, predecessor_token_hash,
            previous_generation_id, manifest_digest, legacy_fingerprint,
            input_revision, from_day, through_day, days_json, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12)`,
          [generationId, principal.participantId, principal.deviceId, tokenHash,
            manifest.predecessor.previousGenerationId, manifest.manifestDigest,
            manifest.predecessor.legacyFingerprint, revision(predecessor.input_revision),
            manifest.fromDay, manifest.throughDay, daysJson, committedAt],
        );
        await client.query(
          `INSERT INTO ${table(schema, "telemetry_v12_domain_days")} (
            generation_id, observed_day, manifest_id, manifest_digest
          ) SELECT $1, x.day::date, x.manifest_id, x.manifest_digest
              FROM jsonb_to_recordset($2::jsonb)
              AS x(day text, manifest_id text, manifest_digest text)`,
          [generationId, JSON.stringify(manifest.days.map((day) => ({
            day: day.day, manifest_id: day.manifestId,
            manifest_digest: day.manifestDigest,
          })))],
        );
        const head = await client.query<{ generation_id: string }>(
          `INSERT INTO ${table(schema, "telemetry_v12_domain_heads")} (
            participant_id, generation_id, revision, updated_at
          ) VALUES ($1,$2,1,$3)
          ON CONFLICT(participant_id) DO UPDATE SET
            generation_id = EXCLUDED.generation_id,
            revision = ${table(schema, "telemetry_v12_domain_heads")}.revision + 1,
            updated_at = EXCLUDED.updated_at
          RETURNING generation_id`,
          [principal.participantId, generationId, committedAt],
        );
        if (head.rows[0]?.generation_id !== generationId) throw conflict("state");
        const consumed = await client.query(
          `UPDATE ${table(schema, "telemetry_v12_domain_predecessors")}
              SET consumed_at = $1
            WHERE token_hash = $2 AND participant_id = $3 AND device_id = $4
              AND consumed_at IS NULL AND expires_at > $1::timestamptz`,
          [committedAt, tokenHash, principal.participantId, principal.deviceId],
        );
        if (consumed.rowCount !== 1) throw conflict("state");
        return activationResult({
          id: generationId,
          manifest_digest: manifest.manifestDigest,
          from_day: manifest.fromDay,
          through_day: manifest.throughDay,
        }, false);
      }, {
        operation,
        statementTimeoutMilliseconds: ACTIVATION_STATEMENT_TIMEOUT_MS,
        preserveSafeError,
      }).catch(async (error) => {
        // A concurrent replay can commit while this transaction waits on the
        // predecessor lock. Prove the active head after rollback, without
        // treating any other storage failure as a successful activation.
        const replay = await withPostgresRead(pool,
          (client) => activeDomainByDigest(client, schema, principal, manifest.manifestDigest),
          { operation: "telemetry.v12.domain.replay" }).catch(() => null);
        if (replay) return activationResult(replay, true);
        const lifecycle = transactionFailureStage(error, operation);
        const failureStage = lifecycle.matched ? lifecycle.stage : classificationFailureStage;
        const safeError = postgresTelemetryV12StorageFailure(error);
        throw failureStage === null ? safeError : markTelemetryActivationFailureStage(safeError, failureStage);
      });
    };

  return Object.freeze({
    createPredecessor(principal, nowEpoch = Date.now()) {
      return issuePredecessor(principal, nowEpoch, false) as Promise<TelemetryV12DomainPredecessor>;
    },
    createOwnerRecoveryPredecessor(principal, nowEpoch = Date.now()) {
      return issuePredecessor(principal, nowEpoch, true) as Promise<TelemetryV12OwnerRecoveryPredecessor>;
    },
    activate(principal, value, nowEpoch = Date.now()) {
      return activateDomain(principal, value, nowEpoch, false);
    },
    activateOwnerRecovery(principal, value, nowEpoch = Date.now()) {
      return activateDomain(principal, value, nowEpoch, true);
    },
  });
}
