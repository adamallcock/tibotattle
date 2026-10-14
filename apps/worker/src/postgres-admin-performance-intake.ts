/**
 * GET /api/v1/admin/performance-intake over PostgreSQL (GCP origin): the
 * read-only owner view of the accountless model-performance intake and its
 * community publication (primary 0079_performance_telemetry.sql; owner
 * decisions 2026-10-10, docs/decisions/2026-10-10-community-model-speed.md;
 * orchestrator gate answers 2026-10-11, items 4 and 23).
 *
 * A separate admin route, so the 'admin-overview' contract keeps its version
 * and its deploy order. There is no activation control here (gate answer 23):
 * activation goes only through the owner-only run_maintenance task
 * (src/postgres-telemetry-runtime-activation.ts) and the runbook.
 *
 * READ RULES
 * - One REPEATABLE READ READ ONLY snapshot (withPostgresRead), 10 s statement
 *   and 5 s lock timeouts. Every statement reads the same snapshot.
 * - Every window derives from the caller's nowEpoch; nothing reads the
 *   database clock. The per-day series cover the 400 UTC days that end on
 *   the day of nowEpoch (`windows`), and each series reports how much
 *   evidence lies outside its window (`outsideWindow`) instead of being cut
 *   to a small cap.
 * - Counts only. The body carries no participant, device, enrollment or
 *   report id, no revision, digest, envelope hash, source generation, parser
 *   version or audit operation id. Provider, model and dictionary names are
 *   closed catalog labels.
 * - Strict coercers: every value is read as text and must match its closed
 *   shape. A malformed value, an absent runtime row (never read as 'staged'),
 *   a driver failure or invalid options all answer 503
 *   ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE with no detail.
 *
 * SEMANTICS (admin-performance-intake-v0.1)
 * - Heads mirror the capability fence (readPostgresTelemetryPerformanceCapability):
 *   the grant head is an enrollment's highest (capability_revision,
 *   authority_epoch) row; the capability head is a (participant, device)'s.
 *   A head is active when its state is active (grant) or accepted
 *   (capability) and expires_at > nowEpoch; expired when that state holds
 *   but expires_at <= nowEpoch; revoked when its state is revoked. The
 *   counts read the rows only: a grant behind a revoked enrollment stays
 *   active by row (the Worker leaves it inert, not revoked).
 * - grants.authorizedLast24Hours / authorizedLast7Days count grant rows
 *   (every revision) whose authorized_at lies in (nowEpoch - window, nowEpoch].
 * - reports.current / superseded count every report row by state, day
 *   tombstones (zero records) included; contributors and devices count the
 *   distinct owners and devices of current reports. latestReportDay is the
 *   newest current report day; latestAcceptedAt the newest receipt (the
 *   receipts' acceptance-instant index).
 * - byEvidenceDay groups reports by report_day inside the window; records
 *   sums the current reports' record counts. byArrivalDay groups receipts
 *   (one per admitted report: accepted or replaced) by the UTC day of their
 *   instant, inside [window start, nowEpoch].
 * - cohorts read the cohorts of current reports whose day lies inside the
 *   window. excludedFromPublicationTurns sums the turns whose speed mode the
 *   publication never shows (unknown, mixed, other); participant exclusions
 *   are a publication step and are not applied here.
 * - refusals.last24Hours sums the counter rows of the UTC days that overlap
 *   (nowEpoch - 24 h, nowEpoch]: the counters are per day, so it is an upper
 *   bound on the last 24 hours. byDay lists the rows inside the window.
 * - publication.slots lists the stored heads in slot order; lastRun is the
 *   newest complete analytics run whose publication carried a performance
 *   block, or null when none did.
 */
import { ApiError } from "./errors";
import type { PostgresClient, PostgresPool, PostgresSchemaOptions } from "./postgres-client";
import { createPostgresSchemaConfig, quotePostgresIdentifier, withPostgresRead } from "./postgres-client";
import { POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS } from "./postgres-performance-refusal-counts";
import { POSTGRES_TELEMETRY_PERFORMANCE_DICTIONARY_BASES } from "./postgres-telemetry-performance-policy";
import {
  ANALYTICS_V2_PERFORMANCE_PERIODS,
  ANALYTICS_V2_PERFORMANCE_SLOTS,
  ANALYTICS_V2_PERFORMANCE_SPEED_MODES,
  ANALYTICS_V2_PERFORMANCE_WITHHELD_CODES,
  analyticsV2PerformanceSlotKey,
} from "./analytics-v2/performance-publication-contract";

export const POSTGRES_ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION = "admin-performance-intake-v0.1" as const;
/** The per-day series window, in UTC days ending on the day of nowEpoch. */
export const POSTGRES_ADMIN_PERFORMANCE_INTAKE_WINDOW_DAYS = 400;
const STATEMENT_TIMEOUT_MILLISECONDS = 10_000;
const LOCK_TIMEOUT_MILLISECONDS = 5_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_EPOCH = Date.UTC(2000, 0, 1);
const MAX_EPOCH = Date.UTC(9999, 0, 1);
const ISO_MILLISECONDS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;
const DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const INSTANT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const DICTIONARY_PATTERN = /^telemetry-performance-registry-[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$/u;
const MODEL_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ROUTE_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const ROUTE_CLASS = /^[a-z][a-z0-9_-]{0,63}$/u;
const CONTRACT_STATE = /^[a-z][a-z_]{0,31}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_ROUTES = 64;
const MAX_DICTIONARIES = 64;

const BUCKET_SCHEMES = Object.freeze(["performance-histogram-v1", "performance-histogram-v2"] as const);
const RUNTIME_STATES = Object.freeze(["staged", "active"] as const);
const RUNTIME_SCHEMA_VERSION = "model-performance-daily-v1";
const RUNTIME_PRIVACY_CONTRACT_VERSION = "privacy-safe-model-performance-v1";
const RUNTIME_METHOD_VERSION = "performance-daily-histogram-v1";
/** Every cohort speed mode 0079 stores; the publication shows only standard, fast and ultrafast. */
const COHORT_SPEED_MODES = Object.freeze(["fast", "standard", "unknown", "other", "mixed", "ultrafast"] as const);
const UNPUBLISHED_SPEED_MODES = Object.freeze(["unknown", "mixed", "other"] as const);
const SLOT_KEYS: readonly string[] = Object.freeze(ANALYTICS_V2_PERFORMANCE_SLOTS.map(analyticsV2PerformanceSlotKey));
const RUN_PERFORMANCE_KEYS = "deferredEmpty,published,unchanged,withheld";

// ---------------------------------------------------------------------------
// DTO

export interface PostgresAdminPerformanceIntakeContractDictionary {
  readonly fieldDictionaryVersion: string;
  readonly state: string;
  readonly bucketSchemeVersion: string;
}

export interface PostgresAdminPerformanceIntakeOptions {
  readonly schema?: PostgresSchemaOptions;
  /** Epoch milliseconds of the request; every window derives from it. */
  readonly nowEpoch: number;
  /** Route id -> registry class, passed in as data by the composition root. */
  readonly routeClasses: Readonly<Record<string, string>>;
  /** The deployed image: DEPLOYMENT_SOURCE_COMMIT (or null) and postgresRuntimeMigrationHistorySha256. */
  readonly deployment: { readonly sourceCommit: string | null; readonly historySha256: string };
  /** The contract's PERFORMANCE_FIELD_DICTIONARIES. */
  readonly contractDictionaries: Readonly<Record<string, PostgresAdminPerformanceIntakeContractDictionary>>;
}

export interface PostgresAdminPerformanceIntake {
  readonly schemaVersion: typeof POSTGRES_ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly windows: {
    readonly days: number;
    readonly from: string;
    readonly through: string;
    readonly last24HoursFrom: string;
    readonly last7DaysFrom: string;
  };
  readonly routes: readonly { readonly routeId: string; readonly routeClass: string }[];
  readonly deployment: { readonly sourceCommit: string | null; readonly historySha256: string };
  readonly runtime: {
    readonly state: (typeof RUNTIME_STATES)[number];
    readonly policyRevision: number;
    readonly schemaVersion: string;
    readonly privacyContractVersion: string;
    readonly methodVersion: string;
    readonly updatedAt: string;
  };
  readonly dictionaries: readonly {
    readonly fieldDictionaryVersion: string;
    readonly bucketSchemeVersion: string;
    readonly contractState: string;
  }[];
  readonly grants: {
    readonly active: number;
    readonly expired: number;
    readonly revoked: number;
    readonly total: number;
    readonly authorizedLast24Hours: number;
    readonly authorizedLast7Days: number;
    readonly activeByDictionary: readonly {
      readonly fieldDictionaryVersion: string;
      readonly dictionaryBasis: string;
      readonly devices: number;
    }[];
  };
  readonly capabilities: { readonly active: number; readonly expired: number; readonly revoked: number };
  readonly reports: {
    readonly current: number;
    readonly superseded: number;
    readonly contributors: number;
    readonly devices: number;
    readonly latestReportDay: string | null;
    readonly latestAcceptedAt: string | null;
    readonly byEvidenceDay: readonly {
      readonly day: string; readonly current: number; readonly superseded: number; readonly records: number;
    }[];
    readonly byArrivalDay: readonly { readonly day: string; readonly accepted: number; readonly replaced: number }[];
    readonly byDictionary: readonly {
      readonly fieldDictionaryVersion: string; readonly current: number; readonly superseded: number;
      readonly records: number;
    }[];
    readonly outsideWindow: {
      readonly evidenceBefore: number;
      readonly evidenceAfter: number;
      readonly arrivalBefore: number;
      readonly arrivalAfter: number;
    };
  };
  readonly cohorts: {
    readonly bySpeedMode: readonly { readonly speedMode: string; readonly cohorts: number; readonly turns: number }[];
    readonly byModel: readonly {
      readonly provider: string; readonly modelId: string; readonly speedMode: string;
      readonly cohorts: number; readonly turns: number;
    }[];
    readonly excludedFromPublicationTurns: number;
  };
  readonly refusals: {
    readonly last24Hours: number;
    readonly byDay: readonly {
      readonly day: string; readonly routeId: string; readonly code: string; readonly status: number;
      readonly refusals: number;
    }[];
    readonly outsideWindow: { readonly before: number; readonly after: number };
  };
  readonly publication: {
    readonly slots: readonly {
      readonly period: string; readonly speedMode: string; readonly revision: number; readonly releasedAt: string;
      readonly end: string; readonly kernelId: number;
    }[];
    readonly lastRun: {
      readonly finishedAt: string;
      readonly published: readonly string[];
      readonly unchanged: readonly string[];
      readonly withheld: string | null;
      readonly deferredEmpty: boolean;
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Strict coercers. Any mismatch throws Malformed, which becomes the 503.

class Malformed extends Error {
  constructor() {
    super("ADMIN_PERFORMANCE_INTAKE_MALFORMED");
    this.name = "Malformed";
  }
}

function malformed(): never {
  throw new Malformed();
}

function unavailable(): ApiError {
  return new ApiError(503, "ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE");
}

function count(value: unknown, minimum = 0): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) malformed();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) malformed();
  return parsed;
}

function utcDay(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

function day(value: unknown): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) malformed();
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || utcDay(epoch) !== value) malformed();
  return value;
}

function nullableDay(value: unknown): string | null {
  return value === null ? null : day(value);
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) malformed();
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) malformed();
  return value;
}

function nullableInstant(value: unknown): string | null {
  return value === null ? null : instant(value);
}

function token(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) malformed();
  return value;
}

function member<T extends string>(value: unknown, members: readonly T[]): T {
  if (typeof value !== "string" || !(members as readonly string[]).includes(value)) malformed();
  return value as T;
}

function exact(value: unknown, expected: string): string {
  if (value !== expected) malformed();
  return expected;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function rows(client: PostgresClient, text: string, values: unknown[]): Promise<readonly Record<string, unknown>[]> {
  const result = await client.query<Record<string, unknown>>(text, values);
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) malformed();
  return result.rows;
}

async function one(client: PostgresClient, text: string, values: unknown[]): Promise<Record<string, unknown>> {
  const found = await rows(client, text, values);
  if (found.length !== 1 || !plainRecord(found[0])) malformed();
  return found[0];
}

// ---------------------------------------------------------------------------
// Options

interface ReadPlan {
  readonly schema: string;
  readonly nowEpoch: number;
  readonly routes: PostgresAdminPerformanceIntake["routes"];
  readonly deployment: PostgresAdminPerformanceIntake["deployment"];
  readonly contract: ReadonlyMap<string, string>;
  readonly windows: PostgresAdminPerformanceIntake["windows"];
}

function plan(pool: unknown, options: unknown): ReadPlan {
  if (pool === null || typeof pool !== "object" || typeof Reflect.get(pool, "connect") !== "function") malformed();
  if (!plainRecord(options)) malformed();
  const schema = quotePostgresIdentifier(createPostgresSchemaConfig(
    (options.schema ?? {}) as PostgresSchemaOptions).primarySchema);
  const nowEpoch = options.nowEpoch;
  if (typeof nowEpoch !== "number" || !Number.isSafeInteger(nowEpoch) || nowEpoch < MIN_EPOCH || nowEpoch >= MAX_EPOCH) {
    malformed();
  }
  const routeClasses = options.routeClasses;
  if (!plainRecord(routeClasses)) malformed();
  const routeIds = Object.keys(routeClasses).sort();
  if (routeIds.length > MAX_ROUTES) malformed();
  const routes = Object.freeze(routeIds.map((routeId) => Object.freeze({
    routeId: token(routeId, ROUTE_ID),
    routeClass: token(routeClasses[routeId], ROUTE_CLASS),
  })));
  const deployment = options.deployment;
  if (!plainRecord(deployment) || Object.keys(deployment).sort().join(",") !== "historySha256,sourceCommit") malformed();
  const sourceCommit = deployment.sourceCommit === null ? null : token(deployment.sourceCommit, COMMIT);
  const historySha256 = token(deployment.historySha256, SHA256);
  const dictionaries = options.contractDictionaries;
  if (!plainRecord(dictionaries) || Object.keys(dictionaries).length > MAX_DICTIONARIES) malformed();
  const contract = new Map<string, string>();
  for (const [version, entry] of Object.entries(dictionaries)) {
    if (!plainRecord(entry) || entry.fieldDictionaryVersion !== version) malformed();
    token(version, DICTIONARY_PATTERN);
    member(entry.bucketSchemeVersion, BUCKET_SCHEMES);
    contract.set(version, token(entry.state, CONTRACT_STATE));
  }
  const throughEpoch = Date.parse(`${utcDay(nowEpoch)}T00:00:00.000Z`);
  const windows = Object.freeze({
    days: POSTGRES_ADMIN_PERFORMANCE_INTAKE_WINDOW_DAYS,
    from: utcDay(throughEpoch - (POSTGRES_ADMIN_PERFORMANCE_INTAKE_WINDOW_DAYS - 1) * DAY_MS),
    through: utcDay(throughEpoch),
    last24HoursFrom: new Date(nowEpoch - 24 * HOUR_MS).toISOString(),
    last7DaysFrom: new Date(nowEpoch - 7 * DAY_MS).toISOString(),
  });
  return Object.freeze({
    schema,
    nowEpoch,
    routes,
    deployment: Object.freeze({ sourceCommit, historySha256 }),
    contract,
    windows,
  });
}

// ---------------------------------------------------------------------------
// The snapshot

async function readSnapshot(client: PostgresClient, readPlan: ReadPlan): Promise<PostgresAdminPerformanceIntake> {
  const s = readPlan.schema;
  const t = (name: string) => `${s}."${name}"`;
  const now = new Date(readPlan.nowEpoch).toISOString();
  const { from, through, last24HoursFrom, last7DaysFrom } = readPlan.windows;
  const fromInstant = `${from}T00:00:00.000Z`;

  // Runtime: an absent row is a 503, never 'staged'.
  const runtimeRows = await rows(client, `SELECT state, policy_revision::text AS policy_revision, schema_version,
      privacy_contract_version, method_version,
      to_char(updated_at AT TIME ZONE 'UTC', ${ISO_MILLISECONDS}) AS updated_at
    FROM ${t("telemetry_performance_runtime")} WHERE id = 1`, []);
  if (runtimeRows.length !== 1) malformed();
  const runtimeRow = runtimeRows[0] ?? malformed();
  const runtime = Object.freeze({
    state: member(runtimeRow.state, RUNTIME_STATES),
    policyRevision: count(runtimeRow.policy_revision, 1),
    schemaVersion: exact(runtimeRow.schema_version, RUNTIME_SCHEMA_VERSION),
    privacyContractVersion: exact(runtimeRow.privacy_contract_version, RUNTIME_PRIVACY_CONTRACT_VERSION),
    methodVersion: exact(runtimeRow.method_version, RUNTIME_METHOD_VERSION),
    updatedAt: instant(runtimeRow.updated_at),
  });

  const dictionaryRows = await rows(client, `SELECT field_dictionary_version, bucket_scheme_version
    FROM ${t("telemetry_performance_field_dictionaries")} ORDER BY field_dictionary_version`, []);
  const dictionaries = Object.freeze(dictionaryRows.map((row) => {
    const fieldDictionaryVersion = token(row.field_dictionary_version, DICTIONARY_PATTERN);
    return Object.freeze({
      fieldDictionaryVersion,
      bucketSchemeVersion: member(row.bucket_scheme_version, BUCKET_SCHEMES),
      contractState: readPlan.contract.get(fieldDictionaryVersion) ?? "absent",
    });
  }));
  const knownDictionaries = dictionaries.map((row) => row.fieldDictionaryVersion);

  // Grant heads per enrollment (the PK orders the DISTINCT ON).
  const grantHeads = `SELECT DISTINCT ON (enrollment_device_id) state, expires_at, field_dictionary_version,
        dictionary_basis
      FROM ${t("accountless_telemetry_performance_authorizations")}
     ORDER BY enrollment_device_id, capability_revision DESC, authority_epoch DESC`;
  const grantRow = await one(client, `WITH heads AS (${grantHeads})
    SELECT count(*) FILTER (WHERE state = 'active' AND expires_at > $1::timestamptz)::text AS active,
           count(*) FILTER (WHERE state = 'active' AND expires_at <= $1::timestamptz)::text AS expired,
           count(*) FILTER (WHERE state = 'revoked')::text AS revoked,
           count(*)::text AS total,
           (SELECT count(*) FROM ${t("accountless_telemetry_performance_authorizations")}
             WHERE authorized_at > $2::timestamptz AND authorized_at <= $1::timestamptz)::text AS last_24_hours,
           (SELECT count(*) FROM ${t("accountless_telemetry_performance_authorizations")}
             WHERE authorized_at > $3::timestamptz AND authorized_at <= $1::timestamptz)::text AS last_7_days
      FROM heads`, [now, last24HoursFrom, last7DaysFrom]);
  const activeByDictionaryRows = await rows(client, `WITH heads AS (${grantHeads})
    SELECT field_dictionary_version, dictionary_basis, count(*)::text AS devices
      FROM heads WHERE state = 'active' AND expires_at > $1::timestamptz
     GROUP BY field_dictionary_version, dictionary_basis
     ORDER BY field_dictionary_version, dictionary_basis`, [now]);
  const grants = Object.freeze({
    active: count(grantRow.active),
    expired: count(grantRow.expired),
    revoked: count(grantRow.revoked),
    total: count(grantRow.total),
    authorizedLast24Hours: count(grantRow.last_24_hours),
    authorizedLast7Days: count(grantRow.last_7_days),
    activeByDictionary: Object.freeze(activeByDictionaryRows.map((row) => Object.freeze({
      fieldDictionaryVersion: member(row.field_dictionary_version, knownDictionaries),
      dictionaryBasis: member(row.dictionary_basis, POSTGRES_TELEMETRY_PERFORMANCE_DICTIONARY_BASES),
      devices: count(row.devices, 1),
    }))),
  });
  if (grants.active + grants.expired + grants.revoked !== grants.total) malformed();

  const capabilityRow = await one(client, `WITH heads AS (
      SELECT DISTINCT ON (participant_id, device_id) state, expires_at
        FROM ${t("telemetry_performance_device_capabilities")}
       ORDER BY participant_id, device_id, capability_revision DESC, authority_epoch DESC)
    SELECT count(*) FILTER (WHERE state = 'accepted' AND expires_at > $1::timestamptz)::text AS active,
           count(*) FILTER (WHERE state = 'accepted' AND expires_at <= $1::timestamptz)::text AS expired,
           count(*) FILTER (WHERE state = 'revoked')::text AS revoked,
           count(*)::text AS total
      FROM heads`, [now]);
  const capabilities = Object.freeze({
    active: count(capabilityRow.active),
    expired: count(capabilityRow.expired),
    revoked: count(capabilityRow.revoked),
  });
  if (capabilities.active + capabilities.expired + capabilities.revoked !== count(capabilityRow.total)) malformed();

  const reportRow = await one(client, `SELECT
      count(*) FILTER (WHERE state = 'current')::text AS current,
      count(*) FILTER (WHERE state = 'superseded')::text AS superseded,
      count(DISTINCT participant_id) FILTER (WHERE state = 'current')::text AS contributors,
      (SELECT count(*) FROM (SELECT DISTINCT participant_id, device_id FROM ${t("telemetry_performance_reports")}
         WHERE state = 'current') owners)::text AS devices,
      (SELECT to_char(max(report_day), 'YYYY-MM-DD') FROM ${t("telemetry_performance_reports")}
         WHERE state = 'current') AS latest_report_day,
      (SELECT to_char(max(created_at) AT TIME ZONE 'UTC', ${ISO_MILLISECONDS})
         FROM ${t("telemetry_performance_receipts")}) AS latest_accepted_at,
      count(*) FILTER (WHERE report_day < $1::date)::text AS evidence_before,
      count(*) FILTER (WHERE report_day > $2::date)::text AS evidence_after,
      (SELECT count(*) FROM ${t("telemetry_performance_receipts")}
         WHERE created_at < $3::timestamptz)::text AS arrival_before,
      (SELECT count(*) FROM ${t("telemetry_performance_receipts")}
         WHERE created_at > $4::timestamptz)::text AS arrival_after
    FROM ${t("telemetry_performance_reports")}`, [from, through, fromInstant, now]);
  const evidenceRows = await rows(client, `SELECT to_char(report_day, 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE state = 'current')::text AS current,
      count(*) FILTER (WHERE state = 'superseded')::text AS superseded,
      COALESCE(sum(record_count) FILTER (WHERE state = 'current'), 0)::text AS records
    FROM ${t("telemetry_performance_reports")}
   WHERE report_day BETWEEN $1::date AND $2::date
   GROUP BY report_day ORDER BY report_day`, [from, through]);
  const arrivalRows = await rows(client, `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE outcome = 'accepted')::text AS accepted,
      count(*) FILTER (WHERE outcome = 'replaced')::text AS replaced
    FROM ${t("telemetry_performance_receipts")}
   WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
   GROUP BY 1 ORDER BY 1`, [fromInstant, now]);
  const reportDictionaryRows = await rows(client, `SELECT field_dictionary_version,
      count(*) FILTER (WHERE state = 'current')::text AS current,
      count(*) FILTER (WHERE state = 'superseded')::text AS superseded,
      COALESCE(sum(record_count) FILTER (WHERE state = 'current'), 0)::text AS records
    FROM ${t("telemetry_performance_reports")}
   GROUP BY field_dictionary_version ORDER BY field_dictionary_version`, []);
  const reports = Object.freeze({
    current: count(reportRow.current),
    superseded: count(reportRow.superseded),
    contributors: count(reportRow.contributors),
    devices: count(reportRow.devices),
    latestReportDay: nullableDay(reportRow.latest_report_day),
    latestAcceptedAt: nullableInstant(reportRow.latest_accepted_at),
    byEvidenceDay: Object.freeze(evidenceRows.map((row) => Object.freeze({
      day: day(row.day),
      current: count(row.current),
      superseded: count(row.superseded),
      records: count(row.records),
    }))),
    byArrivalDay: Object.freeze(arrivalRows.map((row) => Object.freeze({
      day: day(row.day),
      accepted: count(row.accepted),
      replaced: count(row.replaced),
    }))),
    byDictionary: Object.freeze(reportDictionaryRows.map((row) => Object.freeze({
      fieldDictionaryVersion: member(row.field_dictionary_version, knownDictionaries),
      current: count(row.current),
      superseded: count(row.superseded),
      records: count(row.records),
    }))),
    outsideWindow: Object.freeze({
      evidenceBefore: count(reportRow.evidence_before),
      evidenceAfter: count(reportRow.evidence_after),
      arrivalBefore: count(reportRow.arrival_before),
      arrivalAfter: count(reportRow.arrival_after),
    }),
  });
  if (reports.devices < reports.contributors || reports.current < reports.devices) malformed();

  // Cohorts of current reports inside the window (the community_day partial
  // index, then the cohorts' primary key).
  const windowCohorts = `FROM ${t("telemetry_performance_reports")} r
      JOIN ${t("telemetry_performance_cohorts")} c ON c.report_id = r.id
     WHERE r.state = 'current' AND r.report_day BETWEEN $1::date AND $2::date`;
  const speedModeRows = await rows(client, `SELECT c.speed_mode, count(*)::text AS cohorts, sum(c.turns)::text AS turns
    ${windowCohorts} GROUP BY c.speed_mode ORDER BY c.speed_mode`, [from, through]);
  const modelRows = await rows(client, `SELECT c.provider, c.model_id, c.speed_mode, count(*)::text AS cohorts,
      sum(c.turns)::text AS turns
    ${windowCohorts} GROUP BY c.provider, c.model_id, c.speed_mode
    ORDER BY c.provider, c.model_id, c.speed_mode`, [from, through]);
  const excludedRow = await one(client, `SELECT COALESCE(sum(c.turns), 0)::text AS turns
    ${windowCohorts} AND c.speed_mode = ANY($3::text[])`, [from, through, [...UNPUBLISHED_SPEED_MODES]]);
  const cohorts = Object.freeze({
    bySpeedMode: Object.freeze(speedModeRows.map((row) => Object.freeze({
      speedMode: member(row.speed_mode, COHORT_SPEED_MODES),
      cohorts: count(row.cohorts, 1),
      turns: count(row.turns, 1),
    }))),
    byModel: Object.freeze(modelRows.map((row) => Object.freeze({
      provider: token(row.provider, MODEL_TOKEN),
      modelId: token(row.model_id, MODEL_TOKEN),
      speedMode: member(row.speed_mode, COHORT_SPEED_MODES),
      cohorts: count(row.cohorts, 1),
      turns: count(row.turns, 1),
    }))),
    excludedFromPublicationTurns: count(excludedRow.turns),
  });

  const last24HoursFromDay = utcDay(readPlan.nowEpoch - 24 * HOUR_MS);
  const refusalTotals = await one(client, `SELECT
      COALESCE(sum(refusals) FILTER (WHERE day BETWEEN $1::date AND $2::date), 0)::text AS last_24_hours,
      COALESCE(sum(refusals) FILTER (WHERE day < $3::date), 0)::text AS before_window,
      COALESCE(sum(refusals) FILTER (WHERE day > $2::date), 0)::text AS after_window
    FROM ${t("telemetry_performance_refusal_counts")}`, [last24HoursFromDay, through, from]);
  const refusalRows = await rows(client, `SELECT to_char(day, 'YYYY-MM-DD') AS day, route_id, code,
      status::text AS status, refusals::text AS refusals
    FROM ${t("telemetry_performance_refusal_counts")}
   WHERE day BETWEEN $1::date AND $2::date
   ORDER BY day, route_id, code, status`, [from, through]);
  const refusals = Object.freeze({
    last24Hours: count(refusalTotals.last_24_hours),
    byDay: Object.freeze(refusalRows.map((row) => {
      const status = count(row.status);
      if (status < 400 || status > 599) malformed();
      return Object.freeze({
        day: day(row.day),
        routeId: member(row.route_id, POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS),
        code: token(row.code, REFUSAL_CODE),
        status,
        refusals: count(row.refusals, 1),
      });
    })),
    outsideWindow: Object.freeze({
      before: count(refusalTotals.before_window),
      after: count(refusalTotals.after_window),
    }),
  });

  const slotRows = await rows(client, `SELECT period, speed_mode, revision::text AS revision,
      to_char(released_at AT TIME ZONE 'UTC', ${ISO_MILLISECONDS}) AS released_at,
      CASE WHEN jsonb_typeof(payload -> 'end') = 'string' THEN payload ->> 'end' END AS window_end,
      kernel_id::text AS kernel_id
    FROM ${t("analytics_v2_published_performance")}
   ORDER BY array_position($1::text[], period), array_position($2::text[], speed_mode)`,
  [[...ANALYTICS_V2_PERFORMANCE_PERIODS], [...ANALYTICS_V2_PERFORMANCE_SPEED_MODES]]);
  const slots = Object.freeze(slotRows.map((row) => Object.freeze({
    period: member(row.period, ANALYTICS_V2_PERFORMANCE_PERIODS),
    speedMode: member(row.speed_mode, ANALYTICS_V2_PERFORMANCE_SPEED_MODES),
    revision: count(row.revision, 1),
    releasedAt: instant(row.released_at),
    end: day(row.window_end),
    kernelId: count(row.kernel_id, 1),
  })));
  const slotOrder = slots.map((slot) => SLOT_KEYS.indexOf(analyticsV2PerformanceSlotKey(slot)));
  if (slotOrder.some((index, at) => index < 0 || (at > 0 && index <= (slotOrder[at - 1] ?? -1)))) malformed();

  const runRows = await rows(client, `SELECT to_char(finished_at AT TIME ZONE 'UTC', ${ISO_MILLISECONDS}) AS finished_at,
      (publication -> 'performance')::text AS performance
    FROM ${t("analytics_v2_runs")}
   WHERE state = 'complete' AND publication -> 'performance' IS NOT NULL
   ORDER BY finished_at DESC, started_at DESC, run_id DESC
   LIMIT 1`, []);
  const runRow = runRows[0];
  const lastRun = runRow === undefined ? null : runPerformance(runRow);

  return Object.freeze({
    schemaVersion: POSTGRES_ADMIN_PERFORMANCE_INTAKE_SCHEMA_VERSION,
    generatedAt: now,
    windows: readPlan.windows,
    routes: readPlan.routes,
    deployment: readPlan.deployment,
    runtime,
    dictionaries,
    grants,
    capabilities,
    reports,
    cohorts,
    refusals,
    publication: Object.freeze({ slots, lastRun }),
  });
}

function slotKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) malformed();
  const keys = value.map((key) => member(key, SLOT_KEYS));
  if (new Set(keys).size !== keys.length) malformed();
  return Object.freeze(keys);
}

function runPerformance(row: Record<string, unknown>): NonNullable<PostgresAdminPerformanceIntake["publication"]["lastRun"]> {
  const finishedAt = instant(row.finished_at);
  if (typeof row.performance !== "string") malformed();
  let block: unknown;
  try {
    block = JSON.parse(row.performance);
  } catch {
    malformed();
  }
  if (!plainRecord(block) || Object.keys(block).sort().join(",") !== RUN_PERFORMANCE_KEYS) malformed();
  if (typeof block.deferredEmpty !== "boolean") malformed();
  const published = slotKeys(block.published);
  const unchanged = slotKeys(block.unchanged);
  if (published.some((key) => unchanged.includes(key))) malformed();
  return Object.freeze({
    finishedAt,
    published,
    unchanged,
    withheld: block.withheld === null ? null : member(block.withheld, ANALYTICS_V2_PERFORMANCE_WITHHELD_CODES),
    deferredEmpty: block.deferredEmpty,
  });
}

/**
 * The 'admin-performance-intake-v0.1' DTO from one read-only snapshot. Any
 * failure, including invalid options, is 503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE.
 */
export async function readPostgresAdminPerformanceIntake(
  pool: PostgresPool,
  options: PostgresAdminPerformanceIntakeOptions,
): Promise<PostgresAdminPerformanceIntake> {
  try {
    const readPlan = plan(pool, options);
    return await withPostgresRead(pool, (client) => readSnapshot(client, readPlan), {
      operation: "admin_performance_intake.read",
      isolationLevel: "repeatable_read",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
      preserveSafeError: () => unavailable(),
    });
  } catch {
    throw unavailable();
  }
}
