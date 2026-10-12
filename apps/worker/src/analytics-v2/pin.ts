/**
 * analytics-v2 source pins (A-2): the V11SourcePin the vendored d43c8f92
 * shared reducers bind a scalar or model evaluation to.
 *
 * This mirrors d43c8f92 analytics-shared-input.ts `pinForDate` and
 * storage-effective-history.ts `effectiveHistoryPin`:
 * - source 'v1.1' and generationId `effective:<ownerDigest>`;
 * - participantId is the owner's pseudonymous participant id, as both
 *   production pins use it. The kernels derive their dataset and unknown
 *   account-track identities from it, so it must be the production value;
 * - fromDay/throughDay are modelHistoryWindow(day): the 101-day window;
 * - the fingerprint is a sha256 over the window's per-day evidence digests.
 *
 * The fingerprint is a private evaluation identity. The kernels embed it in
 * their scalar analysis and model composition objects; compute.ts never
 * persists the scalar analysis and strips it from stored model results, so it
 * reaches no analytics_v2 row and no public payload. inputRevision and
 * mutationEpoch fence resumable D1 checkpoints in production; a full
 * recompute has none, the shared reducers never read them, and they are fixed
 * here so the fingerprint alone carries the evidence identity.
 *
 * Pure apart from WebCrypto hashing. No I/O.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  modelHistoryWindow,
  type EffectiveTelemetryOccurrence,
  type V11SourcePin,
} from "../../vendor/analytics-d43c8f92/entry";
import { ANALYTICS_V2_CONTRACT_VERSION, type AnalyticsV2Day, type AnalyticsV2Owner } from "./contract";

/** Version of the day digest and fingerprint construction below. */
export const ANALYTICS_V2_PIN_METHOD = "analytics-v2-effective-pin-v1" as const;
/** Fixed: no resumable checkpoint exists for these fields to fence. */
export const ANALYTICS_V2_PIN_INPUT_REVISION = 1 as const;
export const ANALYTICS_V2_PIN_MUTATION_EPOCH = 1 as const;

const DAY_MS = 86_400_000;

/** One owner-day's effective occurrences, per stream, in reader order. */
export interface AnalyticsV2DayOccurrences {
  readonly usage: readonly EffectiveTelemetryOccurrence[];
  readonly quota: readonly EffectiveTelemetryOccurrence[];
  readonly session: readonly EffectiveTelemetryOccurrence[];
}

export const EMPTY_DAY_OCCURRENCES: AnalyticsV2DayOccurrences = Object.freeze({
  usage: Object.freeze([]),
  quota: Object.freeze([]),
  session: Object.freeze([]),
});

function evidence(rows: readonly EffectiveTelemetryOccurrence[]) {
  return rows.map((row) => [row.occurrenceId, row.status, row.eventTime, row.recordJson]);
}

/**
 * The evidence digest of one owner-day: every occurrence id, its status, its
 * event time and its canonical record JSON, per stream, in reader order. An
 * empty day has a digest too, so a later arrival on a once-empty day changes
 * every window that contains it.
 */
export async function analyticsV2DayDigest(day: AnalyticsV2Day,
  occurrences: AnalyticsV2DayOccurrences): Promise<string> {
  return sha256Hex(canonicalJson([ANALYTICS_V2_PIN_METHOD, day, {
    usage: evidence(occurrences.usage),
    quota: evidence(occurrences.quota),
    session: evidence(occurrences.session),
  }]));
}

/**
 * The digest that stands for an owner-day the backstop or the kernels refused
 * to prepare. Such a day is never serialized (its evidence may be larger than
 * one string can hold), and every window containing it is refused
 * (incomplete_window) before its pin is used, so this marker never identifies
 * a result. Its preimage cannot equal analyticsV2DayDigest's: the third
 * element is a string here and an object there.
 */
export async function analyticsV2RefusedDayDigest(day: AnalyticsV2Day): Promise<string> {
  return sha256Hex(canonicalJson([ANALYTICS_V2_PIN_METHOD, day, "refused"]));
}

/**
 * The pin for evaluating `day` (the scalar fit for today, or one model date)
 * over modelHistoryWindow(day). `dayDigests` must hold the digest of every
 * day of that window; a missing day is a caller defect and throws.
 */
export async function buildAnalyticsV2Pin(input: {
  owner: Pick<AnalyticsV2Owner, "participantId" | "ownerDigest">;
  day: AnalyticsV2Day;
  dayDigests: ReadonlyMap<AnalyticsV2Day, string>;
}): Promise<V11SourcePin> {
  const window = modelHistoryWindow(input.day);
  const selected: Array<[AnalyticsV2Day, string]> = [];
  for (let at = Date.parse(`${window.fromDay}T00:00:00.000Z`); at <= Date.parse(`${input.day}T00:00:00.000Z`);
    at += DAY_MS) {
    const label = new Date(at).toISOString().slice(0, 10), digest = input.dayDigests.get(label);
    if (digest === undefined) throw new Error("ANALYTICS_V2_PIN_DAY_MISSING");
    selected.push([label, digest]);
  }
  return {
    source: "v1.1",
    participantId: input.owner.participantId,
    generationId: `effective:${input.owner.ownerDigest}`,
    fromDay: window.fromDay,
    throughDay: input.day,
    inputRevision: ANALYTICS_V2_PIN_INPUT_REVISION,
    mutationEpoch: ANALYTICS_V2_PIN_MUTATION_EPOCH,
    fingerprint: await sha256Hex(canonicalJson([ANALYTICS_V2_PIN_METHOD, ANALYTICS_V2_CONTRACT_VERSION,
      input.owner.ownerDigest, selected])),
  };
}
