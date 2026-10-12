import {
  isValidQuotaWindowDuration,
  SUPPORTED_QUOTA_WINDOW_DURATIONS,
} from "./quota-windows.js";

const SLOT_VALUES = new Set([
  "primary",
  "secondary",
  "five_hour",
  "seven_day",
  "other",
  "unknown",
]);
const PRICING_STATUSES = new Set(["fully_priced", "partially_priced", "unpriced"]);
const SAFE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const OPAQUE_ID = /^[a-z][a-z0-9_-]{0,31}:v[0-9]+:[a-f0-9]{64}$/u;
const MAX_RECEIPT_LAG_MS = 5 * 60_000;
const MAX_COST_NANOUSD = 90_000_000_000_000;
// Integer used_percent readings jitter by a point or two between observations
// (measured: 21 of 25 refused resets in real dense data had a max backward step
// of only 1-2pp, all under 5). That is measurement noise, not a mid-window quota
// reset — a genuine reset drops the reading ~100pp toward zero. Tolerate
// sub-threshold dips so a clean 0->100% climb is not discarded over a 1pp
// wobble; a single drop larger than this still refuses, so a window that spans
// an actual reset boundary is never fit as one cycle.
const MAX_BACKWARD_NOISE_PP = 5;

const DATASET_KEYS = ["datasetId", "complete"];
const QUOTA_KEYS = [
  "snapshotId",
  "datasetId",
  "accountTrackId",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "slot",
  "windowDurationMinutes",
  "resetsAt",
  "observedAt",
  "receivedAt",
  "usedPercent",
  "displayPrecision",
  "policyEpoch",
];
const USAGE_KEYS = [
  "eventId",
  "datasetId",
  "accountTrackId",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "observedAt",
  "costNanousd",
  "pricingStatus",
  "policyEpoch",
];

const REFUSAL_ORDER = [
  "unattributed_account",
  "incomplete_dataset",
  "mixed_track_fields",
  "ambiguous_quota_observation",
  "simultaneous_slot_conflict",
  "stale_quota_observation",
  "backward_quota_observation",
  "incomplete_server_pricing",
  "no_priced_usage",
  "insufficient_quota_observations",
];

function invalidInput() {
  throw new TypeError("quota_tracks_invalid_input");
}

function plainExact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalidInput();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalidInput();
  }
}

function validInstant(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}

function validateDataset(row) {
  plainExact(row, DATASET_KEYS);
  if (!OPAQUE_ID.test(row.datasetId) || typeof row.complete !== "boolean") invalidInput();
  return { datasetId: row.datasetId, complete: row.complete };
}

function validateQuota(row) {
  plainExact(row, QUOTA_KEYS);
  if (!OPAQUE_ID.test(row.snapshotId)
      || !OPAQUE_ID.test(row.datasetId)
      || !(row.accountTrackId === "unattributed" || OPAQUE_ID.test(row.accountTrackId))
      || !validToken(row.provider)
      || !validToken(row.planType)
      || !validToken(row.planVariant)
      || !validToken(row.limitId)
      || !SLOT_VALUES.has(row.slot)
      || !isValidQuotaWindowDuration(row.windowDurationMinutes)
      || !validInstant(row.resetsAt)
      || !validInstant(row.observedAt)
      || !validInstant(row.receivedAt)
      || !Number.isFinite(row.usedPercent)
      || row.usedPercent < 0
      || row.usedPercent > 100
      || !Number.isSafeInteger(row.displayPrecision)
      || row.displayPrecision < 0
      || row.displayPrecision > 6
      || !validToken(row.policyEpoch)
      || Date.parse(row.resetsAt) <= Date.parse(row.observedAt)) {
    invalidInput();
  }
  return { ...row };
}

function validateUsage(row) {
  plainExact(row, USAGE_KEYS);
  if (!OPAQUE_ID.test(row.eventId)
      || !OPAQUE_ID.test(row.datasetId)
      || !(row.accountTrackId === "unattributed" || OPAQUE_ID.test(row.accountTrackId))
      || !validToken(row.provider)
      || !validToken(row.planType)
      || !validToken(row.planVariant)
      || !validToken(row.limitId)
      || !validInstant(row.observedAt)
      || !Number.isSafeInteger(row.costNanousd)
      || row.costNanousd < 0
      || row.costNanousd > MAX_COST_NANOUSD
      || !PRICING_STATUSES.has(row.pricingStatus)
      || !validToken(row.policyEpoch)) {
    invalidInput();
  }
  return { ...row };
}

function stableRow(row, keys) {
  return JSON.stringify(keys.map((key) => row[key]));
}

function deduplicate(rows, idField, keys) {
  const byId = new Map();
  for (const row of rows) {
    const existing = byId.get(row[idField]);
    if (existing && stableRow(existing, keys) !== stableRow(row, keys)) invalidInput();
    if (!existing) byId.set(row[idField], row);
  }
  return [...byId.values()];
}

function keyParts(row) {
  return [
    row.accountTrackId,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.windowDurationMinutes,
    row.policyEpoch,
  ];
}

export function continuityKey(row) {
  return JSON.stringify(keyParts(row));
}

export function resetKey(row) {
  return JSON.stringify([...keyParts(row), row.resetsAt]);
}

function usageMatchesTrack(row, first) {
  return row.accountTrackId === first.accountTrackId
    && row.provider === first.provider
    && row.planType === first.planType
    && row.planVariant === first.planVariant
    && row.limitId === first.limitId
    && row.policyEpoch === first.policyEpoch;
}

function quotaObservationKey(row) {
  return JSON.stringify([row.observedAt, row.slot, row.usedPercent, row.receivedAt]);
}

function slotConflict(rows) {
  const ranges = new Map();
  for (const row of rows) {
    const timestamp = Date.parse(row.observedAt);
    const range = ranges.get(row.slot) ?? { minimum: timestamp, maximum: timestamp };
    range.minimum = Math.min(range.minimum, timestamp);
    range.maximum = Math.max(range.maximum, timestamp);
    ranges.set(row.slot, range);
  }
  const values = [...ranges.values()];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (Math.max(values[left].minimum, values[right].minimum)
          <= Math.min(values[left].maximum, values[right].maximum)) return true;
    }
  }
  return false;
}

function cumulativeCostAt(usage, firstObservedMs, timestampMs) {
  return usage.reduce((sum, row) => {
    const observedMs = Date.parse(row.observedAt);
    return observedMs > firstObservedMs && observedMs <= timestampMs
      ? sum + row.costNanousd
      : sum;
  }, 0);
}

function orderedRefusals(values) {
  const unique = new Set(values);
  return REFUSAL_ORDER.filter((code) => unique.has(code));
}

/** Collapse an instant a source reported more than once.
 *
 * A rollout that inherits history replays its ancestor's records carrying the
 * ancestor's OLD rate-limit reading (see `log-normalization.js`). A parallel
 * fan-out emits several of those at one instant with several stale values, and
 * the reading that is NOT stale is the highest: used percent only climbs within
 * a window. Measured in the production corpus, the busiest single millisecond
 * carried 524 occurrences at one slot with five distinct used percents.
 *
 * Taking the max is the same rule `runningMaxPercent` applies to the climb, and
 * the same one `contradicts()` encodes when it treats the LOWER reading as the
 * stale one. It is safe because grouping by `resetKey` has already separated
 * pools: a replayed reading high enough to beat the true one would have to come
 * from a DIFFERENT pool, and a different pool carries a different `resets_at`,
 * so it lands in another group and never reaches here. Refusing the whole reset cycle instead — which is what
 * `ambiguous_quota_observation` used to do here — discarded a cycle over a
 * disagreement typically smaller than the jitter `MAX_BACKWARD_NOISE_PP`
 * tolerates everywhere else. */
function collapseDuplicateInstants(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.observedAt, row.slot]);
    const previous = best.get(key);
    if (!previous || row.usedPercent > previous.usedPercent
        || (row.usedPercent === previous.usedPercent
          && row.snapshotId.localeCompare(previous.snapshotId) < 0)) best.set(key, row);
  }
  return [...best.values()];
}

/** Split one `resetsAt` group into the cycles actually inside it.
 *
 * The provider re-reports the same `resets_at` across a pool refresh, so
 * `resetKey` does not separate consecutive cycles: a group can hold a climb to
 * 90%, a refresh, and a fresh climb from 2%. The fall between them is a real
 * boundary, not noise — measured over the production corpus, 90 of 110 falls
 * above the noise tolerance are followed by a series that climbs on from the
 * low rather than bouncing back.
 *
 * Refusing the group, which is what `backward_quota_observation` used to do,
 * discarded both cycles. Splitting keeps both, each fitted from its own origin.
 * The threshold is unchanged: below it the population is measurement jitter
 * (falls of 1pp outnumber 2pp tenfold and are spent by 4pp), and raising it
 * would merge genuine restarts and overstate capacity. */
function splitAtCycleRestarts(ordered) {
  const segments = [[]];
  // Compared WITHIN a slot, never across. `slot` is absent from `keyParts`, so
  // one reset group holds both the primary and the secondary series; the
  // adjacent row in observation order is frequently the other slot at a quite
  // different used percent, and treating that as a fall would split a healthy
  // group on every interleave. A cycle restarts per slot, so the previous
  // reading of the SAME slot is the only meaningful comparison.
  let previousBySlot = new Map();
  for (const row of ordered) {
    const previous = previousBySlot.get(row.slot);
    if (previous && previous.usedPercent - row.usedPercent > MAX_BACKWARD_NOISE_PP) {
      segments.push([]);
      previousBySlot = new Map();
    }
    segments.at(-1).push(row);
    previousBySlot.set(row.slot, row);
  }
  return segments.filter((segment) => segment.length > 0);
}

function orderQuotaRows(rows) {
  return collapseDuplicateInstants(
    [...new Map(rows.map((row) => [quotaObservationKey(row), row])).values()],
  ).sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.slot.localeCompare(right.slot)
    || left.snapshotId.localeCompare(right.snapshotId)
  ));
}

function buildOneReset(ordered, allUsage, datasetStatus) {
  const first = ordered[0];
  const firstObservedMs = Date.parse(first.observedAt);
  const lastObservedMs = Date.parse(ordered.at(-1).observedAt);
  const matchedUsage = allUsage.filter((row) => (
    usageMatchesTrack(row, first)
    && Date.parse(row.observedAt) >= firstObservedMs
    && Date.parse(row.observedAt) <= lastObservedMs
  )).sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.eventId.localeCompare(right.eventId)
  ));
  const refusals = [];
  if (first.accountTrackId === "unattributed") refusals.push("unattributed_account");

  const referencedDatasets = new Set([
    ...ordered.map((row) => row.datasetId),
    ...matchedUsage.map((row) => row.datasetId),
  ]);
  if ([...referencedDatasets].some((id) => datasetStatus.get(id) !== true)) {
    refusals.push("incomplete_dataset");
  }
  if (ordered.some((row) => continuityKey(row) !== continuityKey(first)
      || row.resetsAt !== first.resetsAt)) {
    refusals.push("mixed_track_fields");
  }

  // `collapseDuplicateInstants` has already settled each (observedAt, slot) to
  // one row, so this can no longer fire. It stays as a fail-closed guard: a
  // future caller that bypasses the collapse must still refuse rather than fit
  // two contradictory readings of one instant.
  const byTimestampAndSlot = new Map();
  for (const row of ordered) {
    const key = `${row.observedAt}\0${row.slot}`;
    const prior = byTimestampAndSlot.get(key);
    if (prior && (prior.usedPercent !== row.usedPercent || prior.receivedAt !== row.receivedAt)) {
      refusals.push("ambiguous_quota_observation");
    }
    byTimestampAndSlot.set(key, row);
  }
  if (slotConflict(ordered)) refusals.push("simultaneous_slot_conflict");
  if (ordered.some((row) => {
    const lag = Date.parse(row.receivedAt) - Date.parse(row.observedAt);
    return lag < 0 || lag > MAX_RECEIPT_LAG_MS;
  })) refusals.push("stale_quota_observation");
  // `splitAtCycleRestarts` has already cut the series at every fall this size,
  // so this can no longer fire, and for the same reason it is kept: a segment
  // that still contains one is not a single cycle and must not be fitted as one.
  //
  // It compares within a slot for exactly the reason the splitter does. A group
  // carries both slots, so a cross-slot comparison refused any group whose two
  // pools sat at different levels — which the splitter deliberately does not
  // split, so leaving this cross-slot would refuse what the splitter just
  // declared healthy.
  const previousInSlot = new Map();
  if (ordered.some((row) => {
    const previous = previousInSlot.get(row.slot);
    previousInSlot.set(row.slot, row);
    return previous && previous.usedPercent - row.usedPercent > MAX_BACKWARD_NOISE_PP;
  })) refusals.push("backward_quota_observation");
  if (matchedUsage.some((row) => row.pricingStatus !== "fully_priced")) {
    refusals.push("incomplete_server_pricing");
  }
  const totalCostNanousd = matchedUsage.reduce((sum, row) => sum + row.costNanousd, 0);
  if (totalCostNanousd <= 0) refusals.push("no_priced_usage");
  if (ordered.length < 2) refusals.push("insufficient_quota_observations");

  const boundaries = [];
  if (ordered.length > 0) {
    boundaries.push({
      usedPercent: ordered[0].usedPercent,
      lowerCostNanousd: 0,
      upperCostNanousd: 0,
      observedAt: ordered[0].observedAt,
    });
    let runningMaxPercent = ordered[0].usedPercent;
    for (let index = 1; index < ordered.length; index += 1) {
      const prior = ordered[index - 1];
      const current = ordered[index];
      // Skip against the running max, not just the prior observation, so a
      // tolerated noise dip (MAX_BACKWARD_NOISE_PP) can never emit a boundary
      // below an earlier one — non-monotonic boundaries break the downstream
      // fit. For a clean climb the prior observation IS the running max, so this
      // is byte-identical to the old check.
      if (current.usedPercent <= runningMaxPercent) continue;
      runningMaxPercent = current.usedPercent;
      boundaries.push({
        usedPercent: current.usedPercent,
        lowerCostNanousd: cumulativeCostAt(
          matchedUsage,
          firstObservedMs,
          Date.parse(prior.observedAt),
        ),
        upperCostNanousd: cumulativeCostAt(
          matchedUsage,
          firstObservedMs,
          Date.parse(current.observedAt),
        ),
        observedAt: current.observedAt,
      });
    }
  }

  const refusalCodes = orderedRefusals(refusals);
  return {
    schemaVersion: "quota-reset-evidence-v0.1",
    status: refusalCodes.length === 0 ? "eligible" : "refused",
    refusalCodes,
    continuityKey: continuityKey(first),
    resetKey: resetKey(first),
    accountTrackId: first.accountTrackId,
    provider: first.provider,
    planType: first.planType,
    planVariant: first.planVariant,
    limitId: first.limitId,
    windowDurationMinutes: first.windowDurationMinutes,
    policyEpoch: first.policyEpoch,
    resetsAt: first.resetsAt,
    slots: [...new Set(ordered.map((row) => row.slot))],
    firstObservedAt: first.observedAt,
    lastObservedAt: ordered.at(-1).observedAt,
    snapshotCount: ordered.length,
    usageEventCount: matchedUsage.length,
    totalCostNanousd,
    sourceDatasetCount: referencedDatasets.size,
    boundaries,
    quotaSeries: ordered.map((row) => ({
      observedAt: row.observedAt,
      receivedAt: row.receivedAt,
      usedPercent: row.usedPercent,
    })),
    usageSeries: matchedUsage.map((row) => ({
      observedAt: row.observedAt,
      costNanousd: row.costNanousd,
    })),
  };
}

export function buildResetEvidence(input) {
  plainExact(input, ["datasets", "quotaSnapshots", "usageEvents"]);
  if (!Array.isArray(input.datasets)
      || !Array.isArray(input.quotaSnapshots)
      || !Array.isArray(input.usageEvents)) invalidInput();

  const datasets = deduplicate(input.datasets.map(validateDataset), "datasetId", DATASET_KEYS);
  const quota = deduplicate(input.quotaSnapshots.map(validateQuota), "snapshotId", QUOTA_KEYS);
  const usage = deduplicate(input.usageEvents.map(validateUsage), "eventId", USAGE_KEYS);
  const datasetStatus = new Map(datasets.map((row) => [row.datasetId, row.complete]));
  const groups = new Map();
  for (const row of quota) {
    const key = resetKey(row);
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  const resets = [...groups.values()]
    .flatMap((rows) => splitAtCycleRestarts(orderQuotaRows(rows))
      .map((segment) => buildOneReset(segment, usage, datasetStatus)))
    .sort((left, right) => (
      left.firstObservedAt.localeCompare(right.firstObservedAt)
      || left.resetKey.localeCompare(right.resetKey)
    ));
  return {
    schemaVersion: "quota-track-evidence-v0.1",
    resetCount: resets.length,
    resets,
  };
}

export const QUOTA_TRACK_POLICY = Object.freeze({
  supportedDurationsMinutes: SUPPORTED_QUOTA_WINDOW_DURATIONS,
  maximumReceiptLagMs: MAX_RECEIPT_LAG_MS,
  maximumBackwardNoisePp: MAX_BACKWARD_NOISE_PP,
});
