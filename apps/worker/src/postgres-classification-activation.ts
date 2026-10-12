// The classification proof that runs inside a domain activation transaction.
// It is kept apart from postgres-classification-links.ts on purpose: the
// analytics kernel's compute closure hashes every file the overlay readers
// import, so proof-only changes here no longer require a new kernel.
import { canonicalTelemetryV11Json, type TelemetryV11Record, type TelemetryV12Record } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { prepareAnalyticsReplayUsageCorrectionAssertion } from "./telemetry-usage-reconciliation";
import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import { telemetryV12AnalyticalProjection } from "./telemetry-v12-compatibility";
import {
  POSTGRES_CLASSIFICATION_CORRECTION_METHOD, preparePostgresClassificationCorrection, type PostgresClassificationFormat,
} from "./postgres-classification-correction";
import { readPostgresClassificationRecords, readPostgresClassificationHeaderProofs } from "./postgres-classification-records";
import { PAGE, HEX, fail, t, hex, number, readLinks, resolveLinks, type LinkRow } from "./postgres-classification-links";
// The occurrence reader's own retained v1.2 authorization scope. Importing it
// here leaves the kernel closure unchanged: no closure file imports this module.
import { v12RetainedAuthorizationScopeSql } from "./analytics-v2/owners";

const CLASSIFICATION_WORK_MEM = "64MB";

export interface PostgresClassificationActivation {
  readonly participantId: string; readonly deviceId: string; readonly format: 11 | 12;
  readonly previousGenerationId: string | null; readonly generationId: string;
  readonly predecessorTokenHash: string; readonly inputRevision: number;
  readonly manifestDigest: string;
  readonly days: readonly { readonly day: string; readonly manifestId: string; readonly manifestDigest?: string }[];
  readonly predecessorDays?: readonly { readonly day:string;readonly manifestId:string;readonly manifestDigest:string }[];
}

function candidateSql(s: string, format: 11 | 12): string {
  if(format===11) return `SELECT record.id,record.stream,record.occurrence_id,record.observed_at_ms,record.observed_day,
      record.canonical_digest,record.provider_id,usage.model_id,session.value AS session_id,$3::text AS source_device_id
    FROM ${t(s,"typed_telemetry_records")} record
    JOIN ${t(s,"typed_v11_record_admissions")} admission ON admission.typed_record_id=record.id
    JOIN candidate_days day ON day.manifest_id=admission.manifest_id
    JOIN ${t(s,"telemetry_v11_day_manifests")} manifest ON manifest.id=admission.manifest_id
    LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
    LEFT JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=usage.session_id
    WHERE record.format=11 AND manifest.participant_id=$2 AND manifest.device_id=$3 AND manifest.state='ready'
      AND manifest.chunk_day=day.day`;
  // The device's chunks are a small keyed set; joining a materialized copy
  // hashes them once instead of probing the chunk key per record (2026-10-11
  // production: 2.75M probes, 22 s of a 36 s statement).
  return `WITH candidate_chunks AS MATERIALIZED (SELECT id,device_id FROM ${t(s,"telemetry_v12_chunks")}
      WHERE participant_id=$2 AND device_id=$3)
    SELECT record.id,CASE record.stream WHEN 'usage' THEN 1 WHEN 'session' THEN 3 ELSE 2 END AS stream,
      record.occurrence_id,record.observed_at_ms,record.observed_day,record.canonical_digest,
      record.provider_id,usage.model_id,usage.session_id,chunk.device_id AS source_device_id
    FROM ${t(s,"telemetry_v12_typed_records")} record
    JOIN candidate_chunks chunk ON chunk.id=record.chunk_id
    JOIN candidate_days day ON day.manifest_id=record.manifest_id
    JOIN ${t(s,"telemetry_v12_day_manifests")} manifest ON manifest.id=record.manifest_id
    LEFT JOIN ${t(s,"telemetry_v12_typed_usage")} usage ON usage.record_id=record.id
    WHERE manifest.state='ready' AND manifest.chunk_day=day.day`;
}

/** Every device's retained history of one format; a caller restricts it by source_device_id. */
function oldSql(s: string, format: PostgresClassificationFormat): string {
  // Both disjuncts below bind record.manifest_id to a head-day or predecessor
  // manifest, so this implied prefilter only lets the scan start from those
  // manifests instead of every retained v1.2 record; the predicate is unchanged.
  if(format===12) return `WITH retained_v12_manifests AS MATERIALIZED (
      SELECT day.manifest_id FROM ${t(s,"telemetry_v12_domain_heads")} head
        JOIN ${t(s,"telemetry_v12_domain_days")} day ON day.generation_id=head.generation_id WHERE head.participant_id=$2
      UNION SELECT bound.manifest_id FROM predecessor_days bound)
    SELECT record.id,CASE record.stream WHEN 'usage' THEN 1 WHEN 'session' THEN 3 ELSE 2 END AS stream,
      record.occurrence_id,record.observed_at_ms,record.observed_day,record.canonical_digest,record.provider_id,usage.model_id,usage.session_id,
      chunk.device_id AS source_device_id
    FROM ${t(s,"telemetry_v12_typed_records")} record
    JOIN ${t(s,"telemetry_v12_chunks")} chunk ON chunk.id=record.chunk_id
    JOIN ${t(s,"telemetry_v12_day_manifests")} retained_manifest ON retained_manifest.id=record.manifest_id
    LEFT JOIN ${t(s,"telemetry_v12_typed_usage")} usage ON usage.record_id=record.id
    WHERE record.manifest_id IN (SELECT manifest_id FROM retained_v12_manifests) AND chunk.participant_id=$2 AND (
      EXISTS (SELECT 1 FROM ${t(s,"telemetry_v12_domain_heads")} head
        JOIN ${t(s,"telemetry_v12_domain_days")} day ON day.generation_id=head.generation_id
        WHERE head.participant_id=$2 AND day.manifest_id=record.manifest_id)
      OR (chunk.device_id=$3 AND retained_manifest.participant_id=$2 AND retained_manifest.device_id=$3 AND retained_manifest.state='ready'
        AND EXISTS (SELECT 1 FROM predecessor_days bound WHERE bound.manifest_id=retained_manifest.id
          AND bound.manifest_digest=retained_manifest.manifest_digest AND bound.day=retained_manifest.chunk_day)))`;
  const parent=format===11
    ? `JOIN ${t(s,"typed_v11_record_admissions")} admission ON admission.typed_record_id=record.id
       JOIN ${t(s,"telemetry_v11_day_manifests")} retained_manifest ON retained_manifest.id=admission.manifest_id AND retained_manifest.state='ready'
       AND retained_manifest.participant_id=$2
`
    : `JOIN ${t(s,"typed_v1_record_admissions")} admission ON admission.typed_record_id=record.id
       JOIN ${t(s,"telemetry_v1_chunks")} retained_chunk ON retained_chunk.id=admission.chunk_id AND retained_chunk.participant_id=$2
       AND retained_chunk.superseded_at IS NULL AND retained_chunk.accepted_record_count=retained_chunk.record_count`;
  // Acceptance depends only on (manifest, device), so it is decided once per
  // accepted pair rather than per record, and each device id is decoded once
  // (2026-10-11 production: 2.1M per-record probes, 64 s of a 163 s statement).
  const accepted=format===11?`AND EXISTS (SELECT 1 FROM accepted_v11_sources accepted
       WHERE accepted.manifest_id=admission.manifest_id AND accepted.device_id=device.source_device_id)`:"";
  const acceptedCte=format===11?`,accepted_v11_sources AS MATERIALIZED (SELECT DISTINCT retained_day.manifest_id,receipt.device_id
      FROM ${t(s,"telemetry_v11_domain_days")} retained_day
      JOIN ${t(s,"storage_v11_event_sources")} receipt ON receipt.generation_id=retained_day.generation_id
       AND receipt.participant_id=$2)`:"";
  return `WITH decoded_devices AS MATERIALIZED (SELECT id,${t(s,"typed_legacy_admission_decode_id")}(original_id) AS source_device_id
      FROM ${t(s,"typed_telemetry_devices")})${acceptedCte}
    SELECT record.id,record.stream,record.occurrence_id,record.observed_at_ms,record.observed_day,
      record.canonical_digest,record.provider_id,usage.model_id,session.value AS session_id,device.source_device_id
    FROM ${t(s,"typed_telemetry_records")} record
    JOIN ${t(s,"typed_telemetry_owner_memberships")} membership ON membership.namespace_id=record.namespace_id
      AND membership.owner_id=record.owner_id AND membership.source_format=record.format AND membership.participant_id=$2
    JOIN decoded_devices device ON device.id=record.device_id
    LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
    LEFT JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=usage.session_id ${parent}
    WHERE record.format=${format} ${accepted}`;
}

function vector(input: PostgresClassificationActivation): string {
  return JSON.stringify({candidate:input.days.map(day=>({day:day.day,manifest_id:day.manifestId})),
    predecessor:(input.predecessorDays??[]).map(day=>({day:day.day,manifest_id:day.manifestId,manifest_digest:day.manifestDigest}))});
}
function predecessorCte():string{
  return `predecessor_days AS MATERIALIZED (SELECT day::date,manifest_id,manifest_digest
    FROM jsonb_to_recordset($1::jsonb->'predecessor') AS bound(day text,manifest_id text,manifest_digest text))`;
}

/** One activation's record and pair sets. Each is built once from the
 * candidateSql/oldSql text the per-page CTEs re-ran, then paged by index.
 * Session-private: dropped once the proof passes, and discarded with the
 * caller's rollback on any refusal or error (ON COMMIT DROP otherwise). */
type WorkSet = "candidate" | "rekey_twins" | "rekey_accepted" | `source_${PostgresClassificationFormat}`
  | `${"foreign" | "exact"}_${PostgresClassificationFormat}`;
function work(name: WorkSet): string { return `pg_temp.${quotePostgresIdentifier(`classification_${name}`)}`; }
const WORK_SETS: readonly WorkSet[] = ["candidate", "rekey_twins", "rekey_accepted", "source_10", "source_11", "source_12",
  "foreign_10", "foreign_11", "foreign_12", "exact_10", "exact_11", "exact_12"];
// Typed stream codes (STREAM_CODES of the effective readers) whose v1
// occurrence ids each successor format keeps. The clients' v1.1 records reuse
// the v1 usage eventId and session sessionUuid, and v1.2 projects the v1.1
// records unchanged; a v1 quota id ('q:<ms>:<limit>:<slot>') is replaced by
// design with a 'quota-occurrence:v1:' id that admission maps only through
// typed_v11_record_admissions.legacy_occurrence_id (assertTypedV1Transition).
const V1_STABLE_STREAMS = "1,3";
// Every set statement binds the same three values; the unused scope CTE only
// types them, so oldSql(10|11) may leave $3 unreferenced.
function workPrelude(): string {
  return `WITH candidate_days AS MATERIALIZED (SELECT day::date,manifest_id
    FROM jsonb_to_recordset($1::jsonb->'candidate') AS input(day text,manifest_id text)),${predecessorCte()},
    activation_scope AS (SELECT $2::text AS participant_id,$3::text AS device_id)`;
}

class ClassificationWork {
  private readonly built = new Set<WorkSet>();
  private sessionIndexed = false;
  constructor(private readonly client: PostgresClient, private readonly s: string,
    private readonly input: PostgresClassificationActivation) {}
  private async records(name: WorkSet, sql: string): Promise<number> {
    const created = await this.client.query(`CREATE TEMP TABLE ${work(name)} ON COMMIT DROP AS ${workPrelude()}
      SELECT * FROM (${sql}) records`, [vector(this.input), this.input.participantId, this.input.deviceId]);
    this.built.add(name);
    // Temporary tables have no autovacuum statistics; the pair joins need them.
    await this.client.query(`ANALYZE ${work(name)}`);
    return number(created.rowCount);
  }
  candidate(): Promise<number> { return this.records("candidate", candidateSql(this.s, this.input.format)); }
  async source(format: PostgresClassificationFormat): Promise<string> {
    if (!this.built.has(`source_${format}`)) await this.records(`source_${format}`, oldSql(this.s, format));
    return work(`source_${format}`);
  }
  private async setting(name: string): Promise<string> {
    const value = (await this.client.query<{setting:string}>("SELECT current_setting($1) AS setting", [name])).rows[0]?.setting;
    if (!value) fail();
    return value;
  }
  /** Whether activating would introduce a re-keyed twin of the participant's
   * accepted history: v1 for v1.1; v1, v1.1 and the other devices' v1.2 for
   * v1.2. The effective readers union legacy and v1.2 candidates per observed
   * day by occurrence id, so an event re-emitted under a new id counts twice.
   * Client ids are positional, so a rewritten rollout re-emits an event at the
   * same instant under a new id but keeps what the event is. A twin is a
   * candidate record that
   *  - shares (stream, day, instant) with a legacy record whose (stream,
   *    occurrence) the candidate lacks on that day, and is the same event:
   *    usage in the same session (null-safe), whatever its token quantities:
   *    a re-parse may change them (owner decision 2026-10-11, guard v5:
   *    production held 2,154 same-session, same-instant v1.1-to-v1.2 re-keys
   *    whose quantities differ), so a distinct event of a same-instant tie
   *    group replacing a dropped one is an accepted false positive; quota with
   *    the same limit and slot (an observation id hashes source position,
   *    limit and slot); a session record, whose id is its session, linked by a
   *    usage occurrence kept under its own id that names the dropped session
   *    in legacy and the twin in the candidate (the client's only session
   *    re-key is its stand-in to raw identity switch, which keeps every event
   *    id),
   *  - matches no legacy record by (stream, occurrence): a same-instant
   *    sibling kept under its own id is not a twin (nor is a re-keyed copy
   *    kept beside its original id, which has the same shape),
   *  - is not already in accepted history of the activating format that the
   *    readers read, so a twin an earlier proof accepted neither wedges a
   *    device nor counts as newly introduced. For v1.2 that is every accepted
   *    generation of this device and of the participant's other devices in
   *    the occurrence reader's retained authorization scope (the reader reads
   *    each of those generations whole), so a re-paired machine is not wedged
   *    by its old device's accepted twin. For v1.1 it is the participant's
   *    accepted v1.1 set, which the legacy reader reads for every device.
   *    Pinned predecessor days are not that history: they are each day's
   *    earliest READY manifest, which a refused activation leaves pinned.
   * Usage and session legacy is every device of the participant: a machine
   * re-paired under a new device id keeps its device salt, so its event and
   * session ids persist. Event ids are salted and a session id is the
   * machine's own (a random Codex session id or a salted stand-in), so a twin
   * across device ids is the same machine's. For v1.2 it also holds the usage
   * and session records of the participant's current head generation
   * (source_12) that belong to another retained device, so a re-paired
   * machine cannot re-key its old device's v1.2 history while that history
   * is the head. Older generations are not legacy; the exemption above still
   * reads them, so this subset only loses recall. Quota legacy stays this
   * device's v1.1: a quota record names no session, so another device's
   * observation at the same instant, limit and slot is no evidence of the
   * same one. v1 quota is excluded (V1_STABLE_STREAMS): its id change is
   * designed.
   *
   * The working sets have no indexes, so the statements over them (the twin
   * statement, the session link and the v1.1 history probe) run with nested
   * loops disabled transaction-locally, restored before returning: the
   * earlier single-statement v1-only form planned a nested-loop semi-join
   * that rescans the candidate per unmatched legacy row and exceeded the
   * 60 s budget (synthetic 2.75M candidate, 1M v1 rows). The quota detail
   * lookup and the v1.2 history probe look rows up by key in indexed tables
   * (the probe's accepted manifests in a keyed temporary table) and keep the
   * planner default. */
  async rekeyed(): Promise<boolean> {
    // Built here under the planner defaults: each is the v1.1 baseline or
    // legacy history the pair work reads next for either activation format
    // (source_12 is the v1.2 pair work's history).
    const v1 = await this.source(10), v11 = await this.source(11);
    const v12 = this.input.format === 12, columns = "id,stream,occurrence_id,observed_at_ms,observed_day,session_id";
    // The participant's other devices whose v1.2 generations the reader reads.
    const others = v12 ? (await this.client.query<{device_id:string}>(`SELECT DISTINCT retained.device_id
        FROM (${v12RetainedAuthorizationScopeSql(this.s, "now()", "reader")}) retained
       WHERE retained.participant_id=$1 AND retained.device_id<>$2 ORDER BY retained.device_id`,
      [this.input.participantId, this.input.deviceId])).rows.map(row => String(row.device_id)) : [];
    const legacy = [`SELECT ${columns} FROM ${v1} WHERE stream IN (${V1_STABLE_STREAMS})`];
    if (v12) {
      const v12Source = await this.source(12);
      legacy.push(`SELECT ${columns} FROM ${v11} WHERE stream IN (${V1_STABLE_STREAMS}) OR source_device_id=$1`,
        `SELECT ${columns} FROM ${v12Source} WHERE stream IN (1,3) AND source_device_id=ANY($2::text[])`);
    }
    const candidate = work("candidate"), pairs = work("rekey_twins");
    const nestloop = await this.setting("enable_nestloop");
    const planner = (value: string) => this.client.query("SELECT set_config('enable_nestloop',$1,true)", [value]);
    await planner("off");
    // Provisional twin pairs: same stream, day, instant and (for usage) session.
    // A usage row always has a session; a missing one compares as the empty
    // id, which no session id is (2 to 257 bytes), so the key stays hashable.
    // Quota pairs carry the dropped legacy record, session pairs its session.
    // A usage pair is final here: its token quantities are not compared.
    let remaining = number((await this.client.query(`CREATE TEMP TABLE ${pairs} ON COMMIT DROP AS
      WITH rekeyed_legacy AS NOT MATERIALIZED (${legacy.join(" UNION ALL ")}),
      dropped AS MATERIALIZED (SELECT DISTINCT legacy.stream,legacy.observed_day,legacy.observed_at_ms,
          COALESCE(legacy.session_id,''::bytea) AS session_key,CASE legacy.stream WHEN 2 THEN legacy.id END AS legacy_id,
          CASE legacy.stream WHEN 3 THEN legacy.occurrence_id END AS legacy_session
        FROM rekeyed_legacy legacy WHERE NOT EXISTS (SELECT 1 FROM ${candidate} kept WHERE kept.stream=legacy.stream
          AND kept.observed_day=legacy.observed_day AND kept.occurrence_id=legacy.occurrence_id))
      SELECT twin.id,twin.stream,twin.observed_day,twin.observed_at_ms,twin.occurrence_id,dropped.legacy_id,dropped.legacy_session
        FROM ${candidate} twin JOIN dropped ON dropped.stream=twin.stream AND dropped.observed_day=twin.observed_day
         AND dropped.observed_at_ms=twin.observed_at_ms AND dropped.session_key=COALESCE(twin.session_id,''::bytea)
       WHERE NOT EXISTS (SELECT 1 FROM rekeyed_legacy matched WHERE matched.stream=twin.stream
           AND matched.occurrence_id=twin.occurrence_id)`, v12 ? [this.input.deviceId, others] : [])).rowCount);
    this.built.add("rekey_twins");
    let introduced = 0;
    if (remaining > 0) {
      await this.client.query(`ANALYZE ${pairs}`);
      const streams = new Set((await this.client.query<{stream:number}>(`SELECT DISTINCT stream FROM ${pairs}`))
        .rows.map(row => Number(row.stream)));
      if (streams.has(3)) {
        // Only usage rows of the provisional sessions join, by occurrence id.
        const usage = [`SELECT occurrence_id,session_id FROM ${v1} WHERE stream=1`];
        if (v12) {
          usage.push(`SELECT occurrence_id,session_id FROM ${v11} WHERE stream=1`,
            `SELECT occurrence_id,session_id FROM ${work("source_12")} WHERE stream=1 AND source_device_id=ANY($1::text[])`);
        }
        remaining -= number((await this.client.query(`WITH linked AS MATERIALIZED (
            SELECT DISTINCT old_usage.session_id AS legacy_session,new_usage.session_id AS twin_session
              FROM (${usage.join(" UNION ALL ")}) old_usage
              JOIN ${candidate} new_usage ON new_usage.stream=1 AND new_usage.occurrence_id=old_usage.occurrence_id
             WHERE old_usage.session_id IN (SELECT legacy_session FROM ${pairs} WHERE stream=3)
               AND new_usage.session_id IN (SELECT occurrence_id FROM ${pairs} WHERE stream=3))
          DELETE FROM ${pairs} pair WHERE pair.stream=3 AND NOT EXISTS (SELECT 1 FROM linked
            WHERE linked.legacy_session=pair.legacy_session AND linked.twin_session=pair.occurrence_id)`,
        v12 ? [others] : [])).rowCount);
      }
      // The quota lookup and the v1.2 history probe probe primary keys: the
      // planner default from here. The v1.1 probe keeps nested loops off.
      if (v12) await planner(nestloop);
      if (streams.has(2)) {
        // Quota legacy is v1.1 only, so only a v1.2 activation has quota
        // pairs. Both share the v1.2 dictionary, so limit and slot ids
        // compare. A pair is dropped only when both detail rows exist and
        // differ; one missing a detail row stays a twin.
        remaining -= number((await this.client.query(`DELETE FROM ${pairs} pair
          USING ${t(this.s,"typed_telemetry_quota")} legacy_quota,${t(this.s,"telemetry_v12_typed_quota")} twin_quota
          WHERE pair.stream=2 AND legacy_quota.record_id=pair.legacy_id AND twin_quota.record_id=pair.id
            AND (legacy_quota.limit_id<>twin_quota.limit_id OR legacy_quota.slot_id<>twin_quota.slot_id)`)).rowCount);
      }
    }
    if (remaining > 0) {
      if (!v12) {
        // A hash anti-join over the participant's accepted v1.1 set.
        introduced = number((await this.client.query<{introduced:string}>(`SELECT count(*)::text AS introduced
          FROM ${pairs} twin WHERE NOT EXISTS (SELECT 1 FROM ${v11} accepted
            WHERE accepted.stream=twin.stream AND accepted.observed_day=twin.observed_day
              AND accepted.occurrence_id=twin.occurrence_id)`)).rows[0]?.introduced);
      } else {
        // The accepted manifests of the twins' days of this device and of the
        // other retained devices, keyed, so the anti-joins below look each one
        // up rather than rescanning a set.
        const accepted = work("rekey_accepted"), v12Records = t(this.s,"telemetry_v12_typed_records");
        await this.client.query(`CREATE TEMP TABLE ${accepted} ON COMMIT DROP AS
          SELECT DISTINCT (day.observed_day-DATE '1970-01-01')::integer AS observed_day,day.manifest_id
            FROM ${t(this.s,"telemetry_v12_domains")} generation
            JOIN ${t(this.s,"telemetry_v12_domain_days")} day ON day.generation_id=generation.id
            JOIN ${t(this.s,"telemetry_v12_day_manifests")} manifest ON manifest.id=day.manifest_id
             AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
             AND manifest.chunk_day=day.observed_day AND manifest.manifest_digest=day.manifest_digest AND manifest.state='ready'
            WHERE generation.participant_id=$1 AND generation.device_id=ANY($2::text[])
              AND (day.observed_day-DATE '1970-01-01')::integer IN (SELECT observed_day FROM ${pairs})`,
        [this.input.participantId, [this.input.deviceId, ...others]]);
        this.built.add("rekey_accepted");
        await this.client.query(`CREATE UNIQUE INDEX ON ${accepted} (observed_day,manifest_id)`);
        await this.client.query(`ANALYZE ${accepted}`);
        // Each NOT EXISTS correlates only in its WHERE clause, so it plans as
        // an anti-join (a per-twin index probe or one hashed inner set), never
        // a subplan rescanning the accepted set per twin. Usage and quota ids
        // encode their instant, so the (observed_day, stream, observed_at_ms,
        // occurrence_id) index finds every manifest holding a twin in one
        // probe. A session's first-event instant can move, so a session twin
        // (few per day) is looked up in each accepted manifest of its day by
        // the (manifest_id, stream, occurrence_id) unique key.
        introduced = number((await this.client.query<{introduced:string}>(`WITH twins AS MATERIALIZED (
            SELECT DISTINCT twin.stream,twin.observed_day,twin.observed_at_ms,twin.occurrence_id FROM ${pairs} twin)
          SELECT count(*)::text AS introduced FROM (
            SELECT 1 FROM twins twin WHERE twin.stream<>3 AND NOT EXISTS (SELECT 1 FROM ${v12Records} record
              JOIN ${accepted} accepted ON accepted.observed_day=record.observed_day AND accepted.manifest_id=record.manifest_id
             WHERE record.observed_day=twin.observed_day AND record.stream=CASE twin.stream WHEN 1 THEN 'usage' ELSE 'quota' END
               AND record.observed_at_ms=twin.observed_at_ms AND record.occurrence_id=twin.occurrence_id)
            UNION ALL SELECT 1 FROM twins twin WHERE twin.stream=3 AND NOT EXISTS (SELECT 1 FROM ${accepted} accepted
              JOIN ${v12Records} record ON record.manifest_id=accepted.manifest_id
             WHERE accepted.observed_day=twin.observed_day AND record.stream='session'
               AND record.occurrence_id=twin.occurrence_id)) introduced`)).rows[0]?.introduced);
      }
    }
    await planner(nestloop);
    return introduced > 0;
  }
  /** The exact pair multiset each original per-page statement joined. */
  async pairs(kind: "foreign" | "exact", format: PostgresClassificationFormat): Promise<void> {
    const old = await this.source(format);
    const join = kind === "foreign"
      ? `SELECT old_source.id AS before_id,candidate.id AS after_id
          FROM ${old} old_source JOIN ${work("candidate")} candidate
            ON candidate.stream=old_source.stream AND candidate.occurrence_id=old_source.occurrence_id
         WHERE old_source.source_device_id<>$1 AND old_source.stream IN (1,3)`
      // The original exact statement read only this device's history.
      : `SELECT old_source.id AS before_id,candidate.id AS after_id,old_source.stream
          FROM ${old} old_source JOIN ${work("candidate")} candidate
            ON candidate.stream=old_source.stream AND candidate.occurrence_id=old_source.occurrence_id
           AND candidate.observed_at_ms=old_source.observed_at_ms AND candidate.observed_day=old_source.observed_day
         WHERE old_source.source_device_id=$1 AND old_source.stream IN (1,3)
           AND (old_source.provider_id IS DISTINCT FROM candidate.provider_id
             OR (old_source.stream=1 AND old_source.model_id IS DISTINCT FROM candidate.model_id))`;
    await this.client.query(`CREATE TEMP TABLE ${work(`${kind}_${format}`)} ON COMMIT DROP AS ${join}`, [this.input.deviceId]);
    this.built.add(`${kind}_${format}`);
    await this.client.query(`CREATE INDEX ON ${work(`${kind}_${format}`)} (before_id,after_id)`);
  }
  /** Same keyset, order and 201-row page the per-page statements returned. */
  async page<T extends object>(kind: "foreign" | "exact", format: PostgresClassificationFormat, oldCursor: string,
    newCursor: string): Promise<readonly T[]> {
    // Qualified: a bare ORDER BY name would sort the text output columns.
    return (await this.client.query<T>(`SELECT pair.before_id::text AS before_id,pair.after_id::text AS after_id
      ${kind === "exact" ? ",pair.stream" : ""} FROM ${work(`${kind}_${format}`)} pair
      WHERE (pair.before_id,pair.after_id)>($1::bigint,$2::bigint) ORDER BY pair.before_id,pair.after_id LIMIT 201`,
    [oldCursor, newCursor])).rows;
  }
  /** The session closure's original-or-candidate usage rows for one session,
   * in numeric (format,id) order: the cursor compares bigint ids, so a bare
   * `ORDER BY id` over the text output column would skip rows past page one. */
  async session(sessionId: Uint8Array, formatCursor: number,
    recordCursor: string): Promise<readonly {format:PostgresClassificationFormat;id:string}[]> {
    const sources = [await this.source(10), await this.source(11), await this.source(12)];
    if (!this.sessionIndexed) {
      for (const name of ["candidate", "source_10", "source_11", "source_12"] as const) {
        await this.client.query(`CREATE INDEX ON ${work(name)} (session_id) WHERE stream=1`);
      }
      this.sessionIndexed = true;
    }
    return (await this.client.query<{format:PostgresClassificationFormat;id:string}>(`WITH
      original AS (
        SELECT 10 AS format,id,stream,session_id FROM ${sources[0]}
        UNION ALL SELECT 11,id,stream,session_id FROM ${sources[1]}
        UNION ALL SELECT 12,id,stream,session_id FROM ${sources[2]}),
      selected AS (SELECT format,id FROM original WHERE stream=1 AND session_id=$1
        UNION SELECT $2::integer,id FROM ${work("candidate")} WHERE stream=1 AND session_id=$1)
      SELECT selected.format,selected.id::text AS id FROM selected
       WHERE (selected.format,selected.id)>($3::integer,$4::bigint) ORDER BY selected.format,selected.id LIMIT 201`,
    [sessionId, this.input.format, formatCursor, recordCursor])).rows;
  }
  async drop(): Promise<void> {
    const names = WORK_SETS.filter(name => this.built.has(name));
    if (names.length) await this.client.query(`DROP TABLE ${names.map(work).join(",")}`);
    this.built.clear();
  }
}

/** Prepare links within the caller's existing activation transaction. Nothing
 * can become visible if any later closure, head CAS or journal write refuses. */
export async function preparePostgresClassificationActivation(client: PostgresClient, s: string,
  input: PostgresClassificationActivation): Promise<void> {
  // A READY predecessor is an additional bound source, never a substitute
  // for corrupt accepted-head evidence. Recheck that head in this same CAS tx.
  for(const format of [11,12] as const){
    const prefix=format===11?"telemetry_v11":"telemetry_v12";
    const expected=format===11
      ? `bound_days AS MATERIALIZED (SELECT domain.id AS generation_id,entry.day,entry."manifestId",entry."manifestDigest"
          FROM ${t(s,`${prefix}_domain_heads`)} head JOIN ${t(s,`${prefix}_domains`)} domain ON domain.id=head.generation_id
          CROSS JOIN LATERAL jsonb_to_recordset(domain.days_json::jsonb) AS entry(day date,"manifestId" text,"manifestDigest" text)
          WHERE head.participant_id=$1)`
      : `bound_days AS MATERIALIZED (SELECT day.generation_id,day.observed_day AS day,day.manifest_id AS "manifestId",day.manifest_digest AS "manifestDigest"
          FROM ${t(s,`${prefix}_domain_heads`)} head JOIN ${t(s,`${prefix}_domain_days`)} day ON day.generation_id=head.generation_id
          WHERE head.participant_id=$1)`;
    const corrupt=(await client.query(`WITH ${expected}
      SELECT 1 FROM ${t(s,`${prefix}_domain_heads`)} head
      JOIN ${t(s,`${prefix}_domains`)} domain ON domain.id=head.generation_id
      JOIN ${t(s,`${prefix}_domain_days`)} day ON day.generation_id=head.generation_id
      LEFT JOIN bound_days bound ON bound.generation_id=head.generation_id AND bound.day=day.observed_day AND bound."manifestId"=day.manifest_id
      LEFT JOIN ${t(s,`${prefix}_day_manifests`)} manifest ON manifest.id=day.manifest_id
      WHERE head.participant_id=$1 AND (manifest.id IS NULL OR manifest.state<>'ready'
        OR manifest.participant_id<>head.participant_id OR manifest.device_id<>domain.device_id
        OR manifest.manifest_digest IS DISTINCT FROM bound."manifestDigest" OR manifest.chunk_day<>day.observed_day) LIMIT 1`,
      [input.participantId])).rows;
    if(corrupt.length) fail();
  }
  const ownership=(await client.query<{owner_digest:string;revision:string;authority_epoch:string}>(
    `SELECT link.owner_digest,owner.revision::text,owner.authority_epoch::text
       FROM ${t(s,"storage_v11_owner_links")} link
       JOIN ${t(s,"storage_source_state")} state ON state.singleton=1
       JOIN ${t(s,"analytics_owner_state")} owner ON owner.source_id=state.source_id AND owner.owner_digest=link.owner_digest
      WHERE link.participant_id=$1 AND link.state='active' AND owner.state='active'`,[input.participantId])).rows;
  // An ordinary owner without a journal bridge may still take the exact path.
  // A differing classification can never invent an owner link.
  const owner=ownership.length===1?ownership[0]!:null;
  if(ownership.length>1) fail();
  // Multi-million-row sets otherwise hash in 4 MB batches (2026-10-11
  // production: 63 s of spill in one statement). Transaction-local, restored
  // once the proof passes; any refusal rolls the whole transaction back.
  const workMem=(await client.query<{setting:string}>("SELECT current_setting('work_mem') AS setting")).rows[0]?.setting;
  if(!workMem) fail();
  await client.query("SELECT set_config('work_mem',$1,true)",[CLASSIFICATION_WORK_MEM]);
  const sets=new ClassificationWork(client,s,input);
  // Every pair joins a candidate row, so an empty candidate proves both pair
  // sets empty without reading history, as the per-page joins did. A
  // cross-format re-key refuses before any pair work, so it fails fast.
  if(await sets.candidate()>0){
    if(await sets.rekeyed()) fail();
    await prepareClassificationPairs(client,s,input,owner,sets);
  }
  await assertSessionClassificationClosure(client,s,input,sets);
  await sets.drop();
  await client.query("SELECT set_config('work_mem',$1,true)",[workMem]);
}

async function prepareClassificationPairs(client: PostgresClient, s: string, input: PostgresClassificationActivation,
  owner: {owner_digest:string;revision:string;authority_epoch:string}|null, sets: ClassificationWork): Promise<void> {
  for(const beforeFormat of [10,11,12] as const){
    if(beforeFormat>input.format) continue;
    let foreignOldCursor="0",foreignNewCursor="0";
    await sets.pairs("foreign",beforeFormat);
    for(;;){
      const foreign=await sets.page<{before_id:string;after_id:string}>("foreign",beforeFormat,foreignOldCursor,foreignNewCursor);
      const page=foreign.slice(0,PAGE);if(!page.length) break;
      const before=await readPostgresClassificationRecords(client,s,beforeFormat,page.map(row=>row.before_id));
      const after=await readPostgresClassificationRecords(client,s,input.format,page.map(row=>row.after_id));
      const links:LinkRow[]=[];
      for(const stream of ["usage","session"] as const){
        const ids=[...new Set([...before.values()].filter(record=>record.stream===stream).map(record=>record.occurrenceId))];
        if(ids.length) links.push(...await readLinks(client,s,input.participantId,stream,ids,input.generationId));
      }
      for(const pair of page){
        const original=before.get(pair.before_id),candidate=after.get(pair.after_id);if(!original||!candidate) fail();
        const effective=JSON.parse(resolveLinks(original,links).recordJson) as {provider:unknown;modelId?:unknown};
        if(effective.provider!==candidate.record.provider
          ||(original.stream==="usage"&&effective.modelId!==candidate.record.modelId)) fail();
      }
      foreignOldCursor=page.at(-1)!.before_id;foreignNewCursor=page.at(-1)!.after_id;if(foreign.length<=PAGE) break;
    }
    let oldCursor="0",newCursor="0";
    await sets.pairs("exact",beforeFormat);
    for(;;){
      const rows=await sets.page<{before_id:string;after_id:string;stream:number}>("exact",beforeFormat,oldCursor,newCursor);
      const page=rows.slice(0,PAGE); if(!page.length) break;
      if(!owner || !HEX.test(owner.owner_digest)) fail();
      const before=await readPostgresClassificationRecords(client,s,beforeFormat,page.map(row=>row.before_id));
      const after=await readPostgresClassificationRecords(client,s,input.format,page.map(row=>row.after_id));

      const afterHeaders=await readPostgresClassificationHeaderProofs(client,s,[...after.values()],input.participantId,input.deviceId);
      for(const row of page){
        let oldRecord=before.get(row.before_id);const newRecord=after.get(row.after_id);
        if(!oldRecord||!newRecord||oldRecord.deviceId!==input.deviceId||newRecord.deviceId!==input.deviceId
          ||oldRecord.stream!==newRecord.stream||oldRecord.occurrenceId!==newRecord.occurrenceId
          ||oldRecord.observedAtMs!==newRecord.observedAtMs||oldRecord.stream==="quota") fail();
        const links=await readLinks(client,s,input.participantId,oldRecord.stream,[oldRecord.occurrenceId],input.generationId);
        const terminal=resolveLinks(oldRecord,links);
        if(terminal.recordId!==oldRecord.recordId||terminal.format!==oldRecord.format){
          oldRecord=(await readPostgresClassificationRecords(client,s,terminal.format,[terminal.recordId])).get(terminal.recordId)!;
          if(!oldRecord) fail();
        }
        if(oldRecord.stream==="quota") fail();
        const actualBeforeFormat=oldRecord.format;
        const proof=await preparePostgresClassificationCorrection({beforeFormat:actualBeforeFormat,afterFormat:input.format,stream:oldRecord.stream,
          beforeRecordJson:oldRecord.recordJson,afterRecordJson:newRecord.recordJson});
        if(!proof){
          let candidateJson=newRecord.recordJson;
          if(actualBeforeFormat<12&&input.format===12) candidateJson=telemetryV12AnalyticalProjection(oldRecord.stream,JSON.parse(candidateJson) as TelemetryV12Record);
          if(actualBeforeFormat===10&&input.format>10){const projection=telemetryV11LegacyProjection(oldRecord.stream,JSON.parse(candidateJson) as TelemetryV11Record);if(!projection) fail();candidateJson=projection.canonicalRecord;}
          if(candidateJson!==oldRecord.recordJson) fail();
          continue;
        }
        const oldHeader=(await readPostgresClassificationHeaderProofs(client,s,[oldRecord],input.participantId,input.deviceId)).get(`${actualBeforeFormat}:${oldRecord.recordId}`)!;
        const newHeader=afterHeaders.get(`${input.format}:${newRecord.recordId}`)!;
        const tuple=[POSTGRES_CLASSIFICATION_CORRECTION_METHOD,proof.kind,input.participantId,input.deviceId,owner.owner_digest,
          oldRecord.stream,oldRecord.occurrenceId,oldRecord.observedAtMs,actualBeforeFormat,input.format,
          oldRecord.sourceNamespace,newRecord.sourceNamespace,oldRecord.chunkId,newRecord.chunkId,
          oldRecord.manifestId,newRecord.manifestId,oldHeader.chunkDigest,newHeader.chunkDigest,oldHeader.manifestDigest,newHeader.manifestDigest,
          proof.beforeDigest,proof.afterDigest,proof.invariantDigest,number(owner.revision),number(owner.authority_epoch),
          input.predecessorTokenHash,input.previousGenerationId,input.inputRevision,input.generationId,input.manifestDigest];
        const linkDigest=await sha256Hex(canonicalTelemetryV11Json(tuple));
        const inserted=await client.query<{link_digest:Uint8Array}>(`INSERT INTO ${t(s,"telemetry_classification_correction_links")} (
          method_version,kind,participant_id,device_id,owner_digest,owner_revision,authority_epoch,stream,occurrence_id,observed_at_ms,
          before_format,after_format,before_record_id,after_record_id,before_namespace,after_namespace,before_chunk_id,after_chunk_id,
          before_manifest_id,after_manifest_id,before_chunk_digest,after_chunk_digest,before_manifest_digest,after_manifest_digest,
          before_digest,after_digest,invariant_digest,link_digest,before_record_json,after_record_json,
          predecessor_token_hash,previous_generation_id,input_revision,generation_id,activation_manifest_digest,created_at)
          VALUES ($1,$2,$3,$4,decode($5,'hex'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
            decode($25,'hex'),decode($26,'hex'),decode($27,'hex'),decode($28,'hex'),$29,$30,$31,$32,$33,$34,$35,clock_timestamp())
          ON CONFLICT (participant_id,device_id,stream,occurrence_id,before_format,before_namespace,before_digest) DO NOTHING RETURNING link_digest`,
          [POSTGRES_CLASSIFICATION_CORRECTION_METHOD,proof.kind,input.participantId,input.deviceId,owner.owner_digest,
            owner.revision,owner.authority_epoch,oldRecord.stream,encodeTypedTelemetryId(oldRecord.occurrenceId),oldRecord.observedAtMs,
            actualBeforeFormat,input.format,oldRecord.recordId,newRecord.recordId,oldRecord.sourceNamespace,newRecord.sourceNamespace,
            oldRecord.chunkId,newRecord.chunkId,oldRecord.manifestId,newRecord.manifestId,oldHeader.chunkDigest,newHeader.chunkDigest,
            oldHeader.manifestDigest,newHeader.manifestDigest,proof.beforeDigest,proof.afterDigest,proof.invariantDigest,linkDigest,
            proof.beforeRecordJson,proof.afterRecordJson,input.predecessorTokenHash,input.previousGenerationId,input.inputRevision,
            input.generationId,input.manifestDigest]);
        if(!inserted.rows.length){
          const prior=(await client.query<{link_digest:Uint8Array}>(`SELECT link_digest FROM ${t(s,"telemetry_classification_correction_links")}
            WHERE participant_id=$1 AND device_id=$2 AND stream=$3 AND occurrence_id=$4 AND before_format=$5
              AND before_namespace=$6 AND before_digest=decode($7,'hex')`,[input.participantId,input.deviceId,oldRecord.stream,
              encodeTypedTelemetryId(oldRecord.occurrenceId),actualBeforeFormat,oldRecord.sourceNamespace,proof.beforeDigest])).rows;
          if(prior.length!==1||hex(prior[0]!.link_digest)!==linkDigest) fail();
        }
      }
      oldCursor=page.at(-1)!.before_id;newCursor=page.at(-1)!.after_id;
      if(rows.length<=PAGE) break;
    }
  }
}

/** Archived method1 variants remain independent evidence. Consume only an
 * exact physical canonical variant; missing or differing source evidence is
 * incomplete for a session-provider amendment, never silently known. */
async function assertArchivedSessionProviders(client:PostgresClient,s:string,input:PostgresClassificationActivation,
 sessionId:string,providers:Set<string>):Promise<void>{
  const runtime=(await client.query<{state:string;source_state:string}>(`SELECT state,source_state
    FROM ${t(s,"telemetry_usage_correction_runtime")} WHERE id=1`)).rows;
  if(runtime.length!==1||runtime[0]!.state!=="staged"||!["staged","active"].includes(runtime[0]!.source_state)) fail();
  if(runtime[0]!.source_state!=="active") return;
  const columns=[
    ["source_format","format"],["namespace_id","namespace_id"],["owner_id","owner_id"],["device_id","device_id"],
    ["chunk_id","chunk_id"],["manifest_id","manifest_id"],["source_row_id","source_row_id"],
    ["occurrence_id","occurrence_id"],["event_time_ms","observed_at_ms"],["provider_id","provider_id"],
  ].map(([archive,record])=>[`h.${archive}`,`record.${record}`]);
  const usageColumns=["session_id","model_id","speed_mode_id","api_service_tier_id","surface_id","billing_surface_id",
    "reasoning_effort_id","agent_scope_id","outcome_id","attribution_id","total_input_context_tokens","input_uncached_tokens",
    "input_cache_read_tokens","input_cache_write_tokens","output_text_tokens","output_reasoning_tokens","output_combined_tokens"];
  for(const name of usageColumns) columns.push([`h.${name}`,`usage.${name}`]);
  let cursor="0";
  for(;;){
    const rows=(await client.query<{id:string;source_storage_row_id:string;record_digest:Uint8Array;base_digest:Uint8Array;
      source_chunk_digest:Uint8Array;exact:boolean}>(`SELECT h.id::text,h.source_storage_row_id::text,
      h.record_digest,h.base_digest,h.source_chunk_digest,
      (record.id IS NOT NULL AND record.stream=1 AND record.canonical_digest=h.record_digest
        AND ROW(${columns.map(pair=>pair[0]).join(",")}) IS NOT DISTINCT FROM ROW(${columns.map(pair=>pair[1]).join(",")})
        AND EXISTS (SELECT 1 FROM ${t(s,"typed_telemetry_owner_memberships")} membership
          WHERE membership.namespace_id=record.namespace_id AND membership.owner_id=record.owner_id
           AND membership.source_format=record.format AND membership.participant_id=h.participant_id)) AS exact
      FROM ${t(s,"telemetry_usage_correction_history")} h
      JOIN ${t(s,"telemetry_usage_correction_facts")} fact ON fact.history_id=h.id AND fact.method_version=1
      JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=h.session_id
      LEFT JOIN ${t(s,"typed_telemetry_records")} record ON record.id=h.source_storage_row_id AND record.format=h.source_format
      LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
      WHERE h.participant_id=$1 AND h.owner_digest=(SELECT decode(owner.owner_digest,'hex')
        FROM ${t(s,"storage_v11_owner_links")} owner WHERE owner.participant_id=$1 AND owner.state='active')
        AND session.value=$2 AND h.id>$3::bigint ORDER BY h.id LIMIT 201`,
      [input.participantId,encodeTypedTelemetryId(sessionId),cursor])).rows;
    const page=rows.slice(0,PAGE);if(!page.length) break;
    if(page.some(row=>row.exact!==true)) fail();
    const records=await readPostgresClassificationRecords(client,s,10,page.map(row=>row.source_storage_row_id));
    const links=await readLinks(client,s,input.participantId,"usage",[...new Set([...records.values()].map(record=>record.occurrenceId))],input.generationId);
    const headers=new Map<string,{readonly chunkDigest:string;readonly manifestDigest:string|null}>();
    for(const device of new Set([...records.values()].map(record=>record.deviceId))){
      for(const [key,value] of await readPostgresClassificationHeaderProofs(client,s,[...records.values()].filter(record=>record.deviceId===device),input.participantId,device)) headers.set(key,value);
    }
    for(const row of page){
      const record=records.get(row.source_storage_row_id);if(!record||record.stream!=="usage") fail();
      let assertion:Awaited<ReturnType<typeof prepareAnalyticsReplayUsageCorrectionAssertion>>;
      try{assertion=await prepareAnalyticsReplayUsageCorrectionAssertion({format:"v1",recordJson:record.recordJson});}catch{return fail();}
      if(assertion.recordDigest!==hex(row.record_digest)||assertion.baseDigest!==hex(row.base_digest)
        ||headers.get(`10:${record.recordId}`)?.chunkDigest!==hex(row.source_chunk_digest)) fail();
      const provider=(JSON.parse(resolveLinks(record,links).recordJson) as {provider?:unknown}).provider;
      if(provider!=="openai_codex") fail();providers.add(provider);
    }
    cursor=page.at(-1)!.id;if(rows.length<=PAGE) break;
  }
}

/** Unknown sessions stay pending. An attempted known session must prove the
 * complete current/candidate usage set across every day at final activation. */
async function assertSessionClassificationClosure(client: PostgresClient,s:string,input:PostgresClassificationActivation,
 sets:ClassificationWork):Promise<void>{
  let sessionCursor="0";
  for(;;){
    const sessions=(await client.query<{id:string}>(`SELECT DISTINCT after_record_id AS id
      FROM ${t(s,"telemetry_classification_correction_links")}
      WHERE participant_id=$1 AND device_id=$2 AND generation_id=$3 AND stream='session'
        AND after_record_id>$4::bigint ORDER BY id LIMIT 201`,
      [input.participantId,input.deviceId,input.generationId,sessionCursor])).rows;
    const sessionPage=sessions.slice(0,PAGE);if(!sessionPage.length) break;
    const after=await readPostgresClassificationRecords(client,s,input.format,sessionPage.map(row=>row.id));
    for(const session of after.values()){
      let formatCursor=0,recordCursor="0";const providers=new Set<string>();
      for(;;){
        const rows=await sets.session(encodeTypedTelemetryId(session.occurrenceId),formatCursor,recordCursor);
        const page=rows.slice(0,PAGE);if(!page.length) break;
        for(const format of [10,11,12] as const){
          const ids=page.filter(row=>row.format===format).map(row=>row.id);if(!ids.length) continue;
          const records=await readPostgresClassificationRecords(client,s,format,ids);
          const links=await readLinks(client,s,input.participantId,"usage",[...new Set([...records.values()].map(row=>row.occurrenceId))],input.generationId);
          for(const record of records.values()){
            const effective=resolveLinks(record,links);
            const provider=(JSON.parse(effective.recordJson) as {provider?:unknown}).provider;
            if(typeof provider!=="string") fail();providers.add(provider);
            if(provider!=="openai_codex"||providers.size>1) fail();
          }
        }
        formatCursor=page.at(-1)!.format;recordCursor=page.at(-1)!.id;if(rows.length<=PAGE) break;
      }
      await assertArchivedSessionProviders(client,s,input,session.occurrenceId,providers);
      if(providers.size!==1) fail();
    }
    sessionCursor=sessionPage.at(-1)!.id;if(sessions.length<=PAGE) break;
  }
}
