import { preparePostgresClassificationActivation, postgresClassificationLinkPredicate } from "./postgres-classification-links";
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
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
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

interface DomainDayReference {
  day: string;
  manifestId: string;
  manifestDigest: string;
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

function conflict(): ApiError {
  return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
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
): Promise<void> {
  for (const day of [previous, successor]) {
    const manifest = await client.query<{ expected_chunk_count: number }>(
      `SELECT expected_chunk_count
         FROM ${table(schema, "telemetry_v12_day_manifests")}
        WHERE id = $1 AND participant_id = $2 AND device_id = $3
          AND chunk_day = $4::date AND manifest_digest = $5 AND state = 'ready'
        FOR SHARE`,
      [day.manifestId, principal.participantId, principal.deviceId,
        day.day, day.manifestDigest],
    );
    if (manifest.rows.length !== 1) throw conflict();
    const summary = await client.query<{
      chunks: string; records: string; typed_records: string; legacy_records: string;
    }>(
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
      throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
    }
  }
  const missing = await client.query(
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
  if (missing.rows.length !== 0) throw conflict();
}

async function stateRow(client: PostgresClient, schema: string, participantId: string): Promise<StateRow> {
  const result = await client.query<StateRow>(
    `SELECT v.revision AS input_revision, h.generation_id, d.manifest_digest
       FROM ${table(schema, "participants")} p
       JOIN ${table(schema, "community_analytical_input_versions")} v
         ON v.participant_id = p.id
       LEFT JOIN ${table(schema, "telemetry_v12_domain_heads")} h
         ON h.participant_id = p.id
       LEFT JOIN ${table(schema, "telemetry_v12_domains")} d ON d.id = h.generation_id
      WHERE p.id = $1 AND p.state = 'active'
      FOR UPDATE OF v`,
    [participantId],
  );
  const state = result.rows[0];
  if (!state || result.rows.length !== 1) throw conflict();
  revision(state.input_revision);
  return state;
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
  activate(
    principal: PostgresTypedV12Principal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainActivation>;
} {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  const schema = quotePostgresIdentifier(config.primarySchema);
  const authorityOptions = { schema: config };

  return Object.freeze({
    async createPredecessor(principal: PostgresTypedV12Principal, nowEpoch = Date.now()) {
      const now = iso(nowEpoch);
      const expiresAt = iso(nowEpoch + PREDECESSOR_TTL_MS);
      return withPostgresMutation(pool, async (client) => {
        await assertPostgresTypedV12WriteAllowed(client, principal, nowEpoch, authorityOptions);
        const state = await stateRow(client, schema, principal.participantId);
        // One row per ready day: its earliest ready manifest, as D1 reads it.
        // A device keeps every earlier ready manifest of a day (new records or
        // a parser release re-digest the day, and 0035 retains ready rows), so
        // its ready rows grow while its days do not. The bound is on days; a
        // row bound would refuse a small domain with a 400 the client treats
        // as final. COLLATE "C" keeps SQLite's BINARY tie-break on id.
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
        const days = [...byDay.values()].sort((a, b) => a.chunk_day.localeCompare(b.chunk_day));
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
        return {
          schemaVersion: "telemetry-domain-predecessor-v1.2" as const,
          token, previousGenerationId: state.generation_id,
          legacyFingerprint, fromDay, throughDay, expiresAt,
        };
      }, { operation: "telemetry.v12.domain.predecessor", preserveSafeError }).catch((error) => {
        throw postgresTelemetryV12StorageFailure(error);
      });
    },

    async activate(principal: PostgresTypedV12Principal, value: unknown, nowEpoch = Date.now()) {
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
      return withPostgresMutation(pool, async (client) => {
        await assertPostgresTypedV12WriteAllowed(client, principal, nowEpoch, authorityOptions);
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
          throw conflict();
        }
        await assertPostgresTypedV12WriteAllowed(client, principal, actualNow.getTime(), authorityOptions);
        const state = await stateRow(client, schema, principal.participantId);
        if (revision(state.input_revision) !== revision(predecessor.input_revision)
            || state.generation_id !== predecessor.previous_generation_id
            || manifest.fromDay > predecessor.from_day
            || manifest.throughDay < predecessor.through_day) {
          throw conflict();
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
          throw conflict();
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
          throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
        }
        const generationId = crypto.randomUUID();
        try {
          await preparePostgresClassificationActivation(client,schema,{
            participantId:principal.participantId,deviceId:principal.deviceId,format:12,
            previousGenerationId:predecessor.previous_generation_id,generationId,
            predecessorTokenHash:tokenHash,inputRevision:revision(predecessor.input_revision),
            manifestDigest:manifest.manifestDigest,days:manifest.days,predecessorDays:existingDays as DomainDayReference[],
          });
        } catch(error) {
          if(error instanceof PostgresClassificationCorrectionError) throw conflict();
          throw error;
        }
        for (const previous of existingDays as DomainDayReference[]) {
          const successor = manifest.days.find((day) => day.day === previous.day)!;
          if (previous.manifestId !== successor.manifestId
              || previous.manifestDigest !== successor.manifestDigest) {
            await assertSameDaySuccessorClosure(client, schema, principal, previous, successor,manifest.manifestDigest);
          }
        }
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
        if (head.rows[0]?.generation_id !== generationId) throw conflict();
        const consumed = await client.query(
          `UPDATE ${table(schema, "telemetry_v12_domain_predecessors")}
              SET consumed_at = $1
            WHERE token_hash = $2 AND participant_id = $3 AND device_id = $4
              AND consumed_at IS NULL AND expires_at > $1::timestamptz`,
          [committedAt, tokenHash, principal.participantId, principal.deviceId],
        );
        if (consumed.rowCount !== 1) throw conflict();
        return activationResult({
          id: generationId,
          manifest_digest: manifest.manifestDigest,
          from_day: manifest.fromDay,
          through_day: manifest.throughDay,
        }, false);
      }, { operation: "telemetry.v12.domain.activate", preserveSafeError }).catch(async (error) => {
        // A concurrent replay can commit while this transaction waits on the
        // predecessor lock. Prove the active head after rollback, without
        // treating any other storage failure as a successful activation.
        const replay = await withPostgresRead(pool,
          (client) => activeDomainByDigest(client, schema, principal, manifest.manifestDigest),
          { operation: "telemetry.v12.domain.replay" }).catch(() => null);
        if (replay) return activationResult(replay, true);
        throw postgresTelemetryV12StorageFailure(error);
      });
    },
  });
}
