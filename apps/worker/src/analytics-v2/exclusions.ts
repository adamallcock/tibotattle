/**
 * analytics-v2 community aggregate exclusions (N-EXCL; owner decision round 5:
 * "Port them: add the PostgreSQL table, the import, and their use in GCP
 * analytics").
 *
 * The read contract (D-PT4X, docs/receipts/2026-10-02-gcp-d-pt4x.md "K-CORE-A
 * (exclusion read contract)"; primary 0066 community_aggregate_exclusions): an
 * owner is excluded from the community aggregates for analysis day D when a
 * row of its participant has scope 'community_weekly', state 'active',
 * effective_at before the end of D and expires_at NULL or after the start of
 * D. That is d43c8f92's weekly predicate (community-snapshots.ts
 * buildCommunityWeeklySnapshot, the table's only reader there) applied per
 * day. Revoked rows are history: they apply to no day.
 *
 * The community aggregates of day D (compute-community.ts) are:
 *   - the public daily of D: the owner's values and devices are left out of
 *     D's fold, as if it had no evidence that day;
 *   - the allowance preview's day D: its band (combined and by plan) leaves
 *     out the owner's fits, and its model composition for date D leaves out
 *     the owner's result (evaluated or refused). The preview's coverage
 *     counts are those of its last day (today).
 * The owner's own rows (owner-day, cache bands, fits, model dates) are
 * computed and stored as before: an exclusion removes an owner from what the
 * community sees, never from its own evidence. The community cache-retention
 * series (folded from the owners' cache bands when served) is not one of the
 * aggregates the contract names, and is unchanged.
 *
 * At d43c8f92 only the v0.3 weekly builder read the table, and GCP does not
 * compute that snapshot, so applying the exclusions here is a declared
 * difference from the oracle whenever production holds an active row.
 *
 * Instants are microseconds since the epoch (PostgreSQL timestamptz's own
 * resolution), so the per-day predicate here is exactly the SQL one. Pure; no
 * I/O.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";

/** The only exclusion scope d43c8f92 (D1 0023) and primary 0066 define. */
export const ANALYTICS_V2_EXCLUSION_SCOPE = "community_weekly" as const;
export const ANALYTICS_V2_EXCLUSION_STATES = Object.freeze(["active", "revoked"] as const);
/** Version of the exclusion digest below. */
export const ANALYTICS_V2_EXCLUSIONS_METHOD = "analytics-v2-exclusions-v1" as const;
/**
 * analyticsV2ExclusionsSha256 of no rows. A run row written before the
 * run-stamps migration applied no exclusion, so it stands for this digest
 * (the analytics-v2 unit check pins the literal).
 */
export const ANALYTICS_V2_NO_EXCLUSIONS_SHA256 = "881387e9ebd61f0993e6e10b6c5cdb6f8fd807432640bbfeca0c0fe15e460118";
const DAY_MICROSECONDS = 86_400_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** One active exclusion of an owner: [effectiveAtUs, expiresAtUs or null), in microseconds. */
export interface AnalyticsV2ExclusionInterval {
  readonly effectiveAtUs: number;
  readonly expiresAtUs: number | null;
}

/** One community_aggregate_exclusions row as the digest reads it. */
export interface AnalyticsV2ExclusionRow {
  readonly exclusionId: string;
  readonly participantId: string;
  readonly scope: string;
  readonly state: string;
  readonly effectiveAtUs: number;
  readonly expiresAtUs: number | null;
}

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

function microsecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A validated, frozen interval list (non-empty, each expiry after its start). */
export function validAnalyticsV2ExclusionIntervals(value: unknown): readonly AnalyticsV2ExclusionInterval[] {
  if (!Array.isArray(value) || value.length === 0) return invalid("exclusions");
  return Object.freeze(value.map((interval) => {
    const entry = interval as Record<string, unknown> | null;
    if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "effectiveAtUs,expiresAtUs"
        || !microsecond(entry.effectiveAtUs)
        || (entry.expiresAtUs !== null && (!microsecond(entry.expiresAtUs) || entry.expiresAtUs <= entry.effectiveAtUs))) {
      return invalid("exclusions");
    }
    return Object.freeze({ effectiveAtUs: entry.effectiveAtUs, expiresAtUs: entry.expiresAtUs as number | null });
  }));
}

/** The [start, end) of a UTC day in microseconds. */
function dayBounds(day: string): readonly [number, number] {
  const ms = DAY.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return invalid("exclusions.day");
  return [ms * 1_000, ms * 1_000 + DAY_MICROSECONDS];
}

/** Whether one of `intervals` excludes its owner from the community aggregates of `day`. */
export function analyticsV2ExcludedOn(intervals: readonly AnalyticsV2ExclusionInterval[] | undefined,
  day: string): boolean {
  if (intervals === undefined) return false;
  const [start, end] = dayBounds(day);
  return intervals.some((interval) => interval.effectiveAtUs < end
    && (interval.expiresAtUs === null || interval.expiresAtUs > start));
}

/** The intervals of `intervals` that cover `day`, in their order (F(o,d)'s exclusion input). */
export function analyticsV2ExclusionsOn<T extends AnalyticsV2ExclusionInterval>(intervals: readonly T[], day: string): T[] {
  const [start, end] = dayBounds(day);
  return intervals.filter((interval) => interval.effectiveAtUs < end
    && (interval.expiresAtUs === null || interval.expiresAtUs > start));
}

/**
 * The identity of the whole table as one run read it: a sha256 over every
 * row, active or revoked, in exclusion-id order. A new row, a revocation or
 * an edit changes it; the run row records it (exclusions_sha256), and a run
 * that reads a different digest republishes every published day. Stored in
 * the run row only, never in a receipt or a log.
 */
export async function analyticsV2ExclusionsSha256(rows: readonly AnalyticsV2ExclusionRow[]): Promise<string> {
  return sha256Hex(canonicalJson([ANALYTICS_V2_EXCLUSIONS_METHOD, rows.map((row) => [row.exclusionId,
    row.participantId, row.scope, row.state, row.effectiveAtUs, row.expiresAtUs])]));
}
