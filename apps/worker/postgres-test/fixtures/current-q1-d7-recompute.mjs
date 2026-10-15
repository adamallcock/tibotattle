/** Current-source D7 mechanics. This is a separate v3 surface: the frozen D1
 * validators and their 168-day/two-conflict contract remain unchanged. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const CURRENT_Q1_D7_CASES = Object.freeze({
  conflictPreserving: Object.freeze({ id: "conflict-preserving-negative-v2", conflicts: 2, daily: 168 }),
  conflictFreePositive: Object.freeze({ id: "conflict-free-positive-v2", conflicts: 0, daily: 170 }),
});
export const CURRENT_Q1_D7_OWNER_KEYS = Object.freeze(["a", "b", "c", "d"]);
export const CURRENT_Q1_D7_DAILY_BOUND = 4_096;
export const CURRENT_Q1_D7_FORCED_DAILY_PER_HEAD = 64;
export const CURRENT_Q1_D7_NATIVE_INVOCATIONS = 128;
export const CURRENT_Q1_D7_NATIVE_STALL = 8;
export const CURRENT_Q1_D7_NATIVE_QUERY_LIMIT = 900;
export const CURRENT_Q1_D7_DIAGNOSTIC_DEADLINE_MS = 30_000;
const DAY_MS = 86_400_000;
const SHA = /^[a-f0-9]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const fail = (code = "CURRENT_Q1_D7_RECOMPUTATION_INVALID") => {
  throw Object.assign(new Error(code), { code });
};
const requireFact = (condition, code) => { if (!condition) fail(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha256 = (value) => sha256(JSON.stringify(value));
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function currentQ1D7Days(fromDay = "2026-04-15", length = 170) {
  requireFact(DAY.test(fromDay) && Number.isSafeInteger(length) && length >= 1 && length <= 170);
  return Array.from({ length }, (_, n) => new Date(Date.parse(`${fromDay}T00:00:00.000Z`) + n * DAY_MS)
    .toISOString().slice(0, 10));
}

export function validateCurrentQ1D7Topology(caseKey, corpus) {
  const definition = CURRENT_Q1_D7_CASES[caseKey];
  requireFact(definition && object(corpus) && Array.isArray(corpus.owners) && corpus.owners.length === 4);
  const allDays = currentQ1D7Days();
  const conflictDays = caseKey === "conflictPreserving" ? [allDays[2], allDays[3]] : [];
  const days = allDays.filter((day) => !conflictDays.includes(day));
  requireFact(isDeepStrictEqual(corpus.owners.map((owner) => owner.key).sort(), [...CURRENT_Q1_D7_OWNER_KEYS])
    && corpus.owners.every((owner) => Array.isArray(owner.days) && owner.days.length === 170)
    && isDeepStrictEqual(corpus.owners[0].conflict?.days ?? [], conflictDays)
    && days.length === definition.daily, "CURRENT_Q1_D7_CORPUS_INVALID");
  let primary = 0, extras = 0;
  const counts = { quota: 0, session: 0, usage: 0 };
  for (const owner of corpus.owners) for (const day of owner.days) {
    for (const stream of Object.keys(counts)) {
      const rows = day.records?.[stream];
      requireFact(Array.isArray(rows), "CURRENT_Q1_D7_CORPUS_INVALID");
      counts[stream] += rows.length;
      primary += rows.length;
      const extraRows = day.v1Extra?.[stream] ?? [];
      requireFact(Array.isArray(extraRows), "CURRENT_Q1_D7_CORPUS_INVALID");
      extras += extraRows.length;
    }
  }
  requireFact(primary === 14_830 && extras === 2 && primary + extras === 14_832,
    "CURRENT_Q1_D7_CORPUS_INVALID");
  const legacyOwner = corpus.owners.find((owner) => owner.key === "d");
  const legacyDuplicate = legacyOwner?.duplicate;
  const duplicateDay = legacyOwner?.days.find((day) => day.day === legacyDuplicate?.day);
  const legacyDuplicateRecord = duplicateDay?.v1Extra?.usage?.[0];
  const domainDuplicateRecord = duplicateDay?.records?.usage?.find((row) => row.eventId === legacyDuplicate?.occurrenceId);
  requireFact(legacyDuplicate?.day && isDeepStrictEqual(legacyDuplicate.formats, ["v1", "v11"])
    && legacyDuplicate.v1AdmittedBeforeV11Domain === true && duplicateDay?.format === "v11"
    && duplicateDay.v1Extra?.usage?.length === 1 && legacyDuplicateRecord
    && isDeepStrictEqual(legacyDuplicateRecord, domainDuplicateRecord), "CURRENT_Q1_D7_CORPUS_INVALID");
  if (caseKey === "conflictPreserving") {
    requireFact(corpus.conflict?.owner === "a" && isDeepStrictEqual(corpus.conflict.days, conflictDays)
      && corpus.owners[0].days.find((day) => day.day === conflictDays[0])?.v1Extra?.usage?.length === 1
      && corpus.owners[0].days.find((day) => day.day === conflictDays[1])?.records?.usage?.some((row) =>
        row.eventId === corpus.conflict.occurrenceId), "CURRENT_Q1_D7_CORPUS_INVALID");
  } else {
    const legacyDay = corpus.owners[0].days.find((day) => day.v1Extra?.usage?.length === 1);
    const legacyRecord = legacyDay?.v1Extra?.usage?.[0];
    const pairedPrimary = corpus.owners[0].days.find((day) => day.day === allDays[3])?.records?.usage?.[0];
    requireFact(!Object.hasOwn(corpus, "conflict") && legacyDay?.day === allDays[2]
      && legacyRecord && pairedPrimary && legacyRecord.eventId !== pairedPrimary.eventId
      && legacyRecord.sessionUuid !== pairedPrimary.sessionUuid, "CURRENT_Q1_D7_CORPUS_INVALID");
  }
  return Object.freeze({ caseKey, caseId: definition.id, allDays, dailyDays: days, conflictDays,
    counts, sourceDays: 170, recordCount: 14_832, primaryRecordCount: 14_830, extraAdmissions: 2 });
}

function validateDaySets(expectedDailyDays, conflictDays) {
  requireFact(Array.isArray(expectedDailyDays) && Array.isArray(conflictDays)
    && expectedDailyDays.length + conflictDays.length === 170
    && expectedDailyDays.every((day, n) => DAY.test(day) && (n === 0 || expectedDailyDays[n - 1] < day))
    && conflictDays.every((day, n) => DAY.test(day) && (n === 0 || conflictDays[n - 1] < day)));
  const combined = [...expectedDailyDays, ...conflictDays].sort();
  requireFact(isDeepStrictEqual(combined, currentQ1D7Days()));
  requireFact(!conflictDays.some((day) => expectedDailyDays.includes(day)));
}

/** One bounded real scheduler pass. Only the source-proved conflicting dates
 * can be excluded, and each is re-proved by the final filtered idle selector. */
export async function runCurrentQ1D7DailyPass({ advance, expectedDailyDays, conflictDays,
  preferStaleHead, bound, onIteration = () => {} }) {
  validateDaySets(expectedDailyDays, conflictDays);
  requireFact(typeof advance === "function" && typeof preferStaleHead === "boolean"
    && count(bound) && bound > 0 && bound <= CURRENT_Q1_D7_DAILY_BOUND
    && typeof onIteration === "function");
  const skipped = [], outcomes = { published: 0, unchanged: 0, progress: 0, conflicts: 0 };
  for (let iteration = 1; iteration <= bound; iteration++) {
    onIteration(iteration);
    const step = await advance({ preferStaleHead, skipDays: [...skipped] });
    requireFact(object(step) && count(step.ownersAdvanced));
    if (step.state === "idle") {
      requireFact(exact(step, ["state", "ownersAdvanced"]) && step.ownersAdvanced === 0
        && isDeepStrictEqual([...skipped].sort(), conflictDays));
      return { iterations: iteration, outcomes, filteredIdle: true };
    }
    requireFact(DAY.test(step.day) && !skipped.includes(step.day)
      && (expectedDailyDays.includes(step.day) || conflictDays.includes(step.day)));
    if (step.state === "deferred") {
      requireFact(exact(step, ["state", "reason", "ownersAdvanced", "day"])
        && conflictDays.includes(step.day) && step.reason === "projection_pending" && step.ownersAdvanced === 0);
      skipped.push(step.day); outcomes.conflicts++;
    } else if (step.state === "progress") {
      requireFact((exact(step, ["state", "ownersAdvanced", "day"])
          || exact(step, ["state", "reason", "ownersAdvanced", "day"]) && step.reason === "projection_pending")
        && step.ownersAdvanced > 0 && step.ownersAdvanced <= 4);
      outcomes.progress++;
    } else {
      requireFact(exact(step, ["state", "ownersAdvanced", "day"])
        && expectedDailyDays.includes(step.day) && ["published", "unchanged"].includes(step.state)
        && step.ownersAdvanced <= 4);
      outcomes[step.state]++;
    }
  }
  fail("CURRENT_Q1_D7_DAILY_BOUND");
}

export async function runCurrentQ1D7DailyConvergence(ctx, topology, totalBound = CURRENT_Q1_D7_DAILY_BOUND) {
  validateDaySets(topology.dailyDays, topology.conflictDays);
  requireFact(count(totalBound) && totalBound > 0 && totalBound <= CURRENT_Q1_D7_DAILY_BOUND);
  const dailyPasses = [];
  let remaining = totalBound;
  for (const preferStaleHead of [false, true]) {
    const pass = await runCurrentQ1D7DailyPass({ ...topology, expectedDailyDays: topology.dailyDays,
      preferStaleHead, bound: remaining - 2,
      advance: (options) => ctx.P.advanceNextStorageCommunityDaily({ source: ctx.ingestion, target: ctx.analytics,
        sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace, ...options, nowMs: ctx.nowMs }),
      onIteration: (iteration) => ctx.progress.counts({ iteration }) });
    dailyPasses.push(pass); remaining -= pass.iterations;
  }
  return dailyPasses;
}

/** Build public D7 model-day expectations from already verified current owner
 * reads and exact source proofs. No database candidate or historical DTO enters. */
export function buildCurrentQ1D7ModelDayExpectations({ P, days, ownerEvidence, ownerResults }) {
  requireFact(P && typeof P.buildCommunityModelCompositionDay === "function"
    && typeof P.projectAdminModelHistoryDay === "function" && Array.isArray(days) && days.length === 70
    && Array.isArray(ownerEvidence) && ownerEvidence.length === 280 && ownerResults instanceof Map);
  return days.map((day) => {
    const group = ownerEvidence.filter((entry) => entry.day === day);
    requireFact(group.length === 4 && isDeepStrictEqual(group.map((entry) => entry.owner).sort(), [...CURRENT_Q1_D7_OWNER_KEYS]));
    const collection = { compositions: [], v1ParticipantCount: 0, unsupportedSourceParticipantCount: 0,
      refusedParticipantCount: 0, storeAvailable: true };
    for (const entry of group) {
      if (entry.classification === "refused") { collection.v1ParticipantCount++; collection.refusedParticipantCount++; continue; }
      const result = ownerResults.get(`${entry.owner}/${day}`);
      requireFact(result?.composition?.status === "ready", "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED");
      collection.v1ParticipantCount++;
      collection.compositions.push({ participantId: entry.ownerDigest, composition: result.composition });
    }
    const raw = P.buildCommunityModelCompositionDay(collection, day);
    const projected = P.projectAdminModelHistoryDay(raw);
    requireFact(projected !== null && projected.day === day, "CURRENT_Q1_D7_EXPECTATION_UNRESOLVED");
    return projected;
  });
}

const BOOTSTRAP_MUTABLE_TABLES = new Set([
  "community_public_source_bootstrap", "community_daily_aggregate_rebuilds", "community_current_analysis_queue",
]);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const rowsExact = (rows, keys) => Array.isArray(rows) && rows.every((row) => exact(row, keys));

/** Verify the bounded current-source scheduling transition by exact rows.
 * All unlisted tables, controls, audits, schema and sequences remain pinned. */
export function assertCurrentQ1D7BootstrapTransition({ beforeInvariant, afterInvariant, before, after, bootstrapSteps }) {
  const invalid = "CURRENT_Q1_D7_BOOTSTRAP_INVALID";
  requireFact(object(beforeInvariant) && object(afterInvariant) && object(before) && object(after)
    && Number.isSafeInteger(bootstrapSteps) && bootstrapSteps >= 1
    && bootstrapSteps <= 64 && beforeInvariant.schemaSha256 === afterInvariant.schemaSha256
    && isDeepStrictEqual(beforeInvariant.controls, afterInvariant.controls)
    && isDeepStrictEqual(beforeInvariant.audit, afterInvariant.audit)
    && isDeepStrictEqual(beforeInvariant.sequences, before.sequences)
    && isDeepStrictEqual(afterInvariant.sequences, after.sequences)
    && exact(before.bootstrap, ["singleton", "policy_version", "participant_cursor", "source_day_cursor", "completed"])
    && exact(after.bootstrap, ["singleton", "policy_version", "participant_cursor", "source_day_cursor", "completed"])
    && exact(before.mutation, ["singleton_id", "mutation_epoch"])
    && exact(after.mutation, ["singleton_id", "mutation_epoch"])
    && rowsExact(before.dailyRebuilds, ["day", "requested_epoch", "requested_at"])
    && rowsExact(after.dailyRebuilds, ["day", "requested_epoch", "requested_at"])
    && rowsExact(before.queue, ["id", "participant_id", "dirty_generation", "window_generation", "pending",
      "last_served_sequence", "completed_day", "completed_method"])
    && rowsExact(after.queue, ["id", "participant_id", "dirty_generation", "window_generation", "pending",
      "last_served_sequence", "completed_day", "completed_method"])
    && rowsExact(before.domainDays, ["participant_id", "generation_id", "day"])
    && rowsExact(after.domainDays, ["participant_id", "generation_id", "day"])
    && rowsExact(before.sequences, ["name", "seq"]) && rowsExact(after.sequences, ["name", "seq"]), invalid);
  const stableBefore = beforeInvariant.tables.filter((entry) => !BOOTSTRAP_MUTABLE_TABLES.has(entry.table));
  const stableAfter = afterInvariant.tables.filter((entry) => !BOOTSTRAP_MUTABLE_TABLES.has(entry.table));
  requireFact(isDeepStrictEqual(stableBefore, stableAfter)
    && isDeepStrictEqual(beforeInvariant.tables.filter((entry) => BOOTSTRAP_MUTABLE_TABLES.has(entry.table)).map((entry) => entry.table).sort(),
      [...BOOTSTRAP_MUTABLE_TABLES].sort())
    && isDeepStrictEqual(afterInvariant.tables.filter((entry) => BOOTSTRAP_MUTABLE_TABLES.has(entry.table)).map((entry) => entry.table).sort(),
      [...BOOTSTRAP_MUTABLE_TABLES].sort()), invalid);
  requireFact(isDeepStrictEqual(beforeInvariant.sequences.filter((entry) => entry.name !== "community_current_analysis_queue"),
    afterInvariant.sequences.filter((entry) => entry.name !== "community_current_analysis_queue")), invalid);

  const oldBootstrap = before.bootstrap, nextBootstrap = after.bootstrap;
  if (oldBootstrap.completed === 1) {
    requireFact(oldBootstrap.singleton === 1 && nextBootstrap.singleton === 1
      && nextBootstrap.completed === 1
      && typeof oldBootstrap.participant_cursor === "string" && typeof oldBootstrap.source_day_cursor === "string"
      && typeof nextBootstrap.participant_cursor === "string" && typeof nextBootstrap.source_day_cursor === "string"
      && isDeepStrictEqual(beforeInvariant, afterInvariant)
      && isDeepStrictEqual(before, after), invalid);
    return { beforeSha256: jsonSha256(beforeInvariant), afterSha256: jsonSha256(afterInvariant), bootstrapSteps,
      domainDayCount: before.domainDays.length, affectedDayCount: 0, queuedParticipantCount: 0,
      insertedQueueCount: 0, queueSequenceDelta: 0 };
  }
  requireFact(oldBootstrap.singleton === 1 && nextBootstrap.singleton === 1
    && oldBootstrap.policy_version === nextBootstrap.policy_version
    && oldBootstrap.completed === 0 && nextBootstrap.completed === 1
    && typeof oldBootstrap.participant_cursor === "string" && typeof oldBootstrap.source_day_cursor === "string"
    && typeof nextBootstrap.participant_cursor === "string" && typeof nextBootstrap.source_day_cursor === "string"
    && before.mutation.mutation_epoch === after.mutation.mutation_epoch
    && isDeepStrictEqual(before.queueState, after.queueState)
    && isDeepStrictEqual(before.domainDays, after.domainDays)
    && before.domainDays.length > 0 && before.domainDays.length <= 4 * 170, invalid);
  requireFact(Number.isSafeInteger(before.mutation.mutation_epoch) && before.mutation.mutation_epoch >= 0
    && before.domainDays.every((row) => typeof row.participant_id === "string" && row.participant_id.length > 0
      && typeof row.generation_id === "string" && row.generation_id.length === 36 && DAY.test(row.day))
    && before.dailyRebuilds.every((row) => DAY.test(row.day) && Number.isSafeInteger(row.requested_epoch)
      && row.requested_epoch >= 0 && typeof row.requested_at === "string" && Number.isFinite(Date.parse(row.requested_at)))
    && before.queue.every((row) => Number.isSafeInteger(row.id) && row.id > 0 && typeof row.participant_id === "string"
      && Number.isSafeInteger(row.dirty_generation) && row.dirty_generation > 0
      && Number.isSafeInteger(row.window_generation) && row.window_generation >= 0
      && [0, 1].includes(row.pending) && Number.isSafeInteger(row.last_served_sequence) && row.last_served_sequence >= 0)
    && before.sequences.every((row) => typeof row.name === "string" && Number.isSafeInteger(row.seq) && row.seq >= 0)
    && new Set(before.domainDays.map((row) => `${row.participant_id}\0${row.day}`)).size === before.domainDays.length
    && new Set(before.dailyRebuilds.map((row) => row.day)).size === before.dailyRebuilds.length
    && new Set(before.queue.map((row) => row.participant_id)).size === before.queue.length
    && new Set(before.sequences.map((row) => row.name)).size === before.sequences.length, invalid);
  const orderedDomainDays = [...before.domainDays].sort((left, right) =>
    compareText(left.participant_id, right.participant_id) || compareText(left.day, right.day));
  requireFact(isDeepStrictEqual(orderedDomainDays, before.domainDays)
    && new Set(before.domainDays.map((row) => `${row.participant_id}\0${row.day}`)).size === before.domainDays.length, invalid);
  const terminal = orderedDomainDays.at(-1);
  requireFact(nextBootstrap.participant_cursor === terminal.participant_id && nextBootstrap.source_day_cursor === terminal.day
    && (nextBootstrap.participant_cursor > oldBootstrap.participant_cursor
      || nextBootstrap.participant_cursor === oldBootstrap.participant_cursor
        && nextBootstrap.source_day_cursor >= oldBootstrap.source_day_cursor), invalid);

  const beforeDaily = new Map(before.dailyRebuilds.map((row) => [row.day, row]));
  const afterDaily = new Map(after.dailyRebuilds.map((row) => [row.day, row]));
  const expectedDays = new Set(before.domainDays.map((row) => row.day));
  requireFact(afterDaily.size >= beforeDaily.size && [...beforeDaily.keys()].every((day) => afterDaily.has(day))
    && [...afterDaily.keys()].every((day) => beforeDaily.has(day) || expectedDays.has(day)), invalid);
  for (const [day, prior] of beforeDaily) if (!expectedDays.has(day))
    requireFact(isDeepStrictEqual(prior, afterDaily.get(day)), invalid);
  for (const day of expectedDays) {
    const row = afterDaily.get(day), prior = beforeDaily.get(day);
    requireFact(row && row.day === day && row.requested_epoch === Math.max(prior?.requested_epoch ?? 0,
      before.mutation.mutation_epoch) && typeof row.requested_at === "string"
      && Number.isFinite(Date.parse(row.requested_at)), invalid);
  }

  const beforeQueue = new Map(before.queue.map((row) => [row.participant_id, row]));
  const afterQueue = new Map(after.queue.map((row) => [row.participant_id, row]));
  const participants = new Set(before.domainDays.map((row) => row.participant_id));
  requireFact(afterQueue.size >= beforeQueue.size && [...beforeQueue.keys()].every((participant) => afterQueue.has(participant)), invalid);
  requireFact([...afterQueue.keys()].every((participant) => beforeQueue.has(participant) || participants.has(participant)), invalid);
  let inserted = 0;
  for (const [participant, prior] of beforeQueue) if (!participants.has(participant))
    requireFact(isDeepStrictEqual(prior, afterQueue.get(participant)), invalid);
  for (const participant of participants) {
    const prior = beforeQueue.get(participant), row = afterQueue.get(participant);
    requireFact(row && row.participant_id === participant && row.pending === 1, invalid);
    if (prior) requireFact(isDeepStrictEqual(row, { ...prior, pending: 1 }), invalid);
    else {
      inserted++;
      requireFact(Number.isSafeInteger(row.id) && row.id > 0 && row.dirty_generation === 1
        && row.window_generation === before.queueState.window_generation && row.last_served_sequence === 0
        && row.completed_day === null && row.completed_method === null, invalid);
    }
  }
  const sequenceValue = (rows) => rows.find((row) => row.name === "community_current_analysis_queue")?.seq ?? 0;
  const sequenceDelta = sequenceValue(after.sequences) - sequenceValue(before.sequences);
  requireFact(Number.isSafeInteger(sequenceDelta) && sequenceDelta >= inserted && sequenceDelta <= bootstrapSteps, invalid);
  return { beforeSha256: jsonSha256(beforeInvariant), afterSha256: jsonSha256(afterInvariant), bootstrapSteps,
    domainDayCount: before.domainDays.length, affectedDayCount: expectedDays.size,
    queuedParticipantCount: participants.size, insertedQueueCount: inserted, queueSequenceDelta: sequenceDelta };
}

export function hashCurrentQ1D7ProducerValue(value) { return jsonSha256(value); }

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]
    && process.argv.includes("--check")) {
  const negativeDays = currentQ1D7Days();
  assert.equal(negativeDays.length, 170);
  assert.equal(CURRENT_Q1_D7_CASES.conflictPreserving.daily, 168);
  assert.equal(CURRENT_Q1_D7_CASES.conflictFreePositive.daily, 170);
  const fakeAdvance = ({ skipDays }) => {
    const next = negativeDays.find((day) => !skipDays.includes(day) && !seen.has(day));
    if (!next) return { state: "idle", ownersAdvanced: 0 };
    seen.add(next);
    return conflictDays.includes(next) ? { state: "deferred", reason: "projection_pending", ownersAdvanced: 0, day: next }
      : { state: "published", ownersAdvanced: 4, day: next };
  };
  const seen = new Set(), conflictDays = [negativeDays[2], negativeDays[3]];
  const check = await runCurrentQ1D7DailyPass({ advance: fakeAdvance,
    expectedDailyDays: negativeDays.filter((day) => !conflictDays.includes(day)), conflictDays,
    preferStaleHead: false, bound: 173 });
  assert.equal(check.filteredIdle, true);
  assert.equal(check.outcomes.conflicts, 2);
  assert.equal(check.outcomes.published, 168);
  process.stdout.write("current-q1-d7-recompute synthetic checks passed\n");
}
