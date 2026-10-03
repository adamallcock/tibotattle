/**
 * analytics-v2 saved owner sets, read side (E-OWNERSET; engine v2 design
 * section 6.2-6.3; owner decisions round 2 "keep past contributions" and
 * round 7 "pre-switch owner sets: A, the participants at cutover").
 *
 * A published day d folds its saved owner set S(d) plus every computed owner
 * with non-empty daily values on d (compute-community.ts). This module reads,
 * in the run's read snapshot:
 * - readAnalyticsV2OwnerSetState: each queued day's S(d), every member with
 *   its current contribution's version, device count and values digest (not
 *   the values), and whether the day's frozen-window bootstrap receipt
 *   exists; and, only when some queued day without a recorded set lies in the
 *   frozen Cloudflare export's window (C-IPR, interim-public-read.ts), that
 *   export's per-day contributingParticipants, verified exactly as the route
 *   verifies the row before serving it;
 * - readAnalyticsV2SavedContributionValues: the stored values of exactly the
 *   contributions a fold needs (a member this run did not compute, or a
 *   computed member whose read for the day is empty), each checked against
 *   its stored digest.
 * The store (store-owner-sets.ts) is the only writer, and re-checks in its
 * write transaction that the sets it extends are the ones read here.
 *
 * Content-free: owner digests, days, versions, counts and digests only; the
 * values are the content-free daily projection values (the class of
 * analytics_v2_owner_day.daily). Failures are closed AnalyticsV2SourceError
 * codes (owners.ts), never a value.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  ANALYTICS_V2_SHA256_PATTERN,
  ANALYTICS_V2_TABLES,
  type AnalyticsV2ContributionKey,
  type AnalyticsV2Day,
  type AnalyticsV2FrozenParticipants,
  type AnalyticsV2OwnerDigest,
  type AnalyticsV2OwnerSetState,
  type AnalyticsV2SavedDay,
  type AnalyticsV2SavedMember,
} from "./contract";
import {
  INTERIM_PUBLIC_READ_ROW_ID,
  INTERIM_PUBLIC_READ_TABLE,
  INTERIM_PUBLIC_READ_WINDOW_DAYS,
  verifyInterimPublicReadRow,
  type FrozenCommunityDaily,
} from "./interim-public-read";
import {
  analyticsV2Statement,
  onReadSnapshot,
  quotedSchema,
  sourceFail,
  type AnalyticsV2SnapshotContext,
} from "./owners";

/** Version of the owner-set read and digest construction below. */
export const ANALYTICS_V2_OWNER_SET_METHOD = "analytics-v2-owner-sets-v1" as const;
/** Queued days one read accepts (the store's day bound). */
export const MAX_ANALYTICS_V2_OWNER_SET_DAYS = 4_096;
/** Saved members one read returns at most (the store's owner-day bound). */
export const MAX_ANALYTICS_V2_SAVED_MEMBERS = 4_000_000;
/** Contributions one values load accepts. */
export const MAX_ANALYTICS_V2_CONTRIBUTION_LOAD = 100_000;
/** The price identity a stable digest leaves out (V11DailyProjectionValues). */
export const ANALYTICS_V2_PRICE_IDENTITY_FIELDS = Object.freeze(["registrySha256", "pricingMethodVersion"] as const);

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;
const LOAD_CHUNK = 1_000;

function isDay(value: unknown): value is AnalyticsV2Day {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function addDays(day: AnalyticsV2Day, days: number): AnalyticsV2Day {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  return parsed;
}

/**
 * A contribution's two digests: values_sha256 over its canonical values, and
 * stable_values_sha256 without the price identity, so a reprice (K-REPRICE)
 * can tell a stamp-only change from a value change.
 */
export async function analyticsV2ContributionDigests(values: unknown): Promise<{
  readonly valuesSha256: string;
  readonly stableValuesSha256: string;
}> {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("ANALYTICS_V2_CONTRIBUTION_INVALID");
  }
  const stable: Record<string, unknown> = { ...(values as Record<string, unknown>) };
  for (const field of ANALYTICS_V2_PRICE_IDENTITY_FIELDS) delete stable[field];
  return Object.freeze({
    valuesSha256: await sha256Hex(canonicalJson(values)),
    stableValuesSha256: await sha256Hex(canonicalJson(stable)),
  });
}

/** The map key of one contribution (day, owner, version). */
export function analyticsV2ContributionKey(key: AnalyticsV2ContributionKey): string {
  return `${key.day}\u0001${key.ownerDigest}\u0001${key.version}`;
}

/**
 * The frozen export's per-day contributingParticipants over its window
 * (pure). `frozen` is a body verifyInterimPublicReadRow accepted.
 */
export function analyticsV2FrozenParticipants(frozen: FrozenCommunityDaily,
  exportSha256: string): AnalyticsV2FrozenParticipants {
  if (typeof exportSha256 !== "string" || !ANALYTICS_V2_SHA256_PATTERN.test(exportSha256)
      || !isDay(frozen.from) || !isDay(frozen.to) || frozen.from > frozen.to) {
    throw new TypeError("ANALYTICS_V2_FROZEN_EXPORT_INVALID");
  }
  const participants = new Map<AnalyticsV2Day, number>();
  for (const day of frozen.days) {
    const totals = (day.payload as { totals?: { contributingParticipants?: unknown } }).totals;
    const count = totals?.contributingParticipants;
    if (!isDay(day.day) || participants.has(day.day) || typeof count !== "number"
        || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("ANALYTICS_V2_FROZEN_EXPORT_INVALID");
    }
    participants.set(day.day, count);
  }
  return Object.freeze({ exportSha256, fromDay: frozen.from, throughDay: frozen.to, participants });
}

function validDays(days: unknown): AnalyticsV2Day[] {
  if (!Array.isArray(days) || days.length > MAX_ANALYTICS_V2_OWNER_SET_DAYS || !days.every(isDay)
      || new Set(days).size !== days.length) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  return [...days].sort();
}

/**
 * Every queued day's saved set and bootstrap state, and the frozen counts
 * when a queued day without a recorded set lies in the frozen window (see
 * the module comment). A set row without a contribution is refused
 * (ANALYTICS_V2_SOURCE_CONFLICT): the migration's commit-time check makes it
 * impossible. Missing tables refuse (ANALYTICS_V2_SOURCE_UNAVAILABLE): a run
 * never folds as if no day had a set.
 */
export async function readAnalyticsV2OwnerSetState(context: AnalyticsV2SnapshotContext,
  options: { readonly days: readonly AnalyticsV2Day[] }): Promise<AnalyticsV2OwnerSetState> {
  const s = quotedSchema(context.schema);
  const days = validDays(options?.days);
  const sets = `${s}."${ANALYTICS_V2_TABLES.dailyOwnerSets}"`;
  const contributions = `${s}."${ANALYTICS_V2_TABLES.dailyContributions}"`;
  const bootstrap = `${s}."${ANALYTICS_V2_TABLES.ownerSetBootstrap}"`;
  return onReadSnapshot(context, async (client) => {
    const present = await client.query<{ sets: unknown; frozen: unknown }>(analyticsV2Statement("owner_sets.read",
      `SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL AS sets,
              to_regclass($4) IS NOT NULL AS frozen`),
    [sets, contributions, bootstrap, `${s}."${INTERIM_PUBLIC_READ_TABLE}"`]);
    if (present.rows.length !== 1 || present.rows[0]?.sets !== true || typeof present.rows[0]?.frozen !== "boolean") {
      sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    }
    const byDay = new Map<AnalyticsV2Day, Map<AnalyticsV2OwnerDigest, AnalyticsV2SavedMember>>(
      days.map((day) => [day, new Map()]));
    const bootstrapped = new Set<AnalyticsV2Day>();
    if (days.length > 0) {
      const members = await client.query<Record<string, unknown>>(analyticsV2Statement("owner_sets.read",
        `SELECT to_char(member.day, 'YYYY-MM-DD') AS day, member.owner_digest,
                current.version, current.devices, current.values_sha256::text AS values_sha256
           FROM ${sets} member
           LEFT JOIN LATERAL (
             SELECT contribution.version, contribution.devices, contribution.values_sha256
               FROM ${contributions} contribution
              WHERE contribution.day = member.day AND contribution.owner_digest = member.owner_digest
              ORDER BY contribution.version DESC LIMIT 1) current ON true
          WHERE member.day = ANY($1::date[])
          ORDER BY member.day, member.owner_digest COLLATE "C"
          LIMIT $2`), [days, MAX_ANALYTICS_V2_SAVED_MEMBERS + 1]);
      if (members.rows.length > MAX_ANALYTICS_V2_SAVED_MEMBERS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
      for (const row of members.rows) {
        const day = row.day;
        const ownerDigest = row.owner_digest;
        const saved = isDay(day) ? byDay.get(day) : undefined;
        if (saved === undefined || typeof ownerDigest !== "string" || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(ownerDigest)
            || saved.has(ownerDigest) || row.version === null || row.version === undefined
            || typeof row.values_sha256 !== "string" || !ANALYTICS_V2_SHA256_PATTERN.test(row.values_sha256)) {
          sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        }
        saved.set(ownerDigest, Object.freeze({ version: positiveInteger(row.version),
          devices: positiveInteger(row.devices), valuesSha256: row.values_sha256 as string }));
      }
      const receipts = await client.query<{ day: unknown }>(analyticsV2Statement("owner_sets.read",
        `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM ${bootstrap} WHERE day = ANY($1::date[]) ORDER BY day`), [days]);
      for (const row of receipts.rows) {
        if (!isDay(row.day) || !byDay.has(row.day) || bootstrapped.has(row.day)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        bootstrapped.add(row.day);
      }
    }
    const state = new Map<AnalyticsV2Day, AnalyticsV2SavedDay>();
    for (const [day, members] of byDay) {
      state.set(day, Object.freeze({ members, bootstrapped: bootstrapped.has(day) }));
    }
    // A day is first recorded when it has no member and no receipt; the
    // frozen counts matter only for such a day inside the frozen window.
    const unrecorded = days.filter((day) => byDay.get(day)!.size === 0 && !bootstrapped.has(day));
    let frozen: AnalyticsV2FrozenParticipants | null = null;
    if (unrecorded.length > 0 && present.rows[0]!.frozen === true) {
      const table = `${s}."${INTERIM_PUBLIC_READ_TABLE}"`;
      const evidence = await client.query<{ evidence_date: unknown }>(analyticsV2Statement("owner_sets.frozen",
        `SELECT to_char(evidence_date, 'YYYY-MM-DD') AS evidence_date FROM ${table} WHERE id = $1`),
      [INTERIM_PUBLIC_READ_ROW_ID]);
      if (evidence.rows.length > 1) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
      const evidenceDate = evidence.rows[0]?.evidence_date;
      if (evidence.rows.length === 1) {
        if (!isDay(evidenceDate)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        const fromDay = addDays(evidenceDate, -(INTERIM_PUBLIC_READ_WINDOW_DAYS - 1));
        if (unrecorded.some((day) => day >= fromDay && day <= evidenceDate)) {
          const row = await client.query<Record<string, unknown>>(analyticsV2Statement("owner_sets.frozen",
            `SELECT payload_text::text AS payload_text, payload_sha256::text AS payload_sha256,
                    to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
                    source_commit::text AS source_commit, to_char(evidence_date, 'YYYY-MM-DD') AS evidence_date
               FROM ${table} WHERE id = $1`), [INTERIM_PUBLIC_READ_ROW_ID]);
          if (row.rows.length !== 1) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          try {
            const verified = await verifyInterimPublicReadRow(row.rows[0]);
            if (verified.frozen.to !== evidenceDate || verified.frozen.from !== fromDay) {
              sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
            }
            frozen = analyticsV2FrozenParticipants(verified.frozen, verified.record.payloadSha256);
          } catch (error) {
            if ((error as { name?: unknown })?.name === "AnalyticsV2SourceError") throw error;
            // An unverifiable frozen copy is never read as "no export": the
            // bootstrap would otherwise record unverified sets as published.
            sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          }
        }
      }
    }
    return Object.freeze({ days: state, frozen });
  });
}

/**
 * The stored values of `keys`, keyed by analyticsV2ContributionKey. Each must
 * exist and match its stored values digest, or the read refuses
 * (ANALYTICS_V2_SOURCE_CONFLICT): a fold never runs on a value it cannot
 * account for.
 */
export async function readAnalyticsV2SavedContributionValues(context: AnalyticsV2SnapshotContext,
  keys: readonly AnalyticsV2ContributionKey[]): Promise<Map<string, unknown>> {
  const s = quotedSchema(context.schema);
  if (!Array.isArray(keys) || keys.length > MAX_ANALYTICS_V2_CONTRIBUTION_LOAD) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  const wanted = new Map<string, AnalyticsV2ContributionKey>();
  for (const key of keys) {
    if (key === null || typeof key !== "object" || !isDay(key.day) || typeof key.ownerDigest !== "string"
        || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(key.ownerDigest) || !Number.isSafeInteger(key.version)
        || key.version < 1) {
      sourceFail("ANALYTICS_V2_SOURCE_INVALID");
    }
    wanted.set(analyticsV2ContributionKey(key), key);
  }
  const output = new Map<string, unknown>();
  if (wanted.size === 0) return output;
  const contributions = `${s}."${ANALYTICS_V2_TABLES.dailyContributions}"`;
  return onReadSnapshot(context, async (client) => {
    const list = [...wanted.values()];
    for (let index = 0; index < list.length; index += LOAD_CHUNK) {
      const chunk = list.slice(index, index + LOAD_CHUNK);
      const result = await client.query<Record<string, unknown>>(analyticsV2Statement("owner_sets.values",
        `SELECT to_char(contribution.day, 'YYYY-MM-DD') AS day, contribution.owner_digest, contribution.version,
                contribution.daily_values::text AS values_text, contribution.values_sha256::text AS values_sha256
           FROM unnest($1::date[], $2::text[], $3::integer[]) AS wanted(day, owner_digest, version)
           JOIN ${contributions} contribution
             ON contribution.day = wanted.day AND contribution.owner_digest = wanted.owner_digest
            AND contribution.version = wanted.version`),
      [chunk.map((key) => key.day), chunk.map((key) => key.ownerDigest), chunk.map((key) => key.version)]);
      for (const row of result.rows) {
        if (!isDay(row.day) || typeof row.owner_digest !== "string" || typeof row.values_text !== "string"
            || typeof row.values_sha256 !== "string") {
          sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        }
        const key = analyticsV2ContributionKey({ day: row.day, ownerDigest: row.owner_digest,
          version: positiveInteger(row.version) });
        if (!wanted.has(key) || output.has(key)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        let values: unknown;
        try {
          values = JSON.parse(row.values_text);
        } catch {
          sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        }
        if ((await analyticsV2ContributionDigests(values)).valuesSha256 !== row.values_sha256) {
          sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
        }
        output.set(key, values);
      }
    }
    if (output.size !== wanted.size) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    return output;
  });
}
