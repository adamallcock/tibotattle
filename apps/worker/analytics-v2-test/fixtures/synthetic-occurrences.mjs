// Synthetic, content-free effective occurrences for the analytics-v2 compute
// specs. No real session, account, path or prompt data: every identifier is a
// generated hex string and every record uses fixed synthetic values.
//
// `composeProofCorpus()` reproduces analytics-v2-test/compose-proof.spec.ts
// byte for byte (3 owners, 7 active days in a 170-day calendar). The other
// builders add the owners the refusal cases need: a dense owner whose scalar
// window exceeds the kernels' 120,000 usage-row bound, an owner whose day
// exceeds the cache reducer's 512-group bound, an owner with a conflicting
// occurrence on two candidate days, and non-effective owners.
//
// Records are canonicalized with the d43c8f92 telemetry-contract vendored
// beside the kernels, so the fixture is plain JavaScript and loads in Node.
import { canonicalTelemetryV11Json } from "../../vendor/analytics-d43c8f92/packages/telemetry-contract/index.js";

export const DAY_MS = 86_400_000;
export const TODAY = "2026-09-30";
export const NOW_MS = Date.parse(`${TODAY}T18:00:00.000Z`);
export const CALENDAR_DAYS = 170;
export const ACTIVE_DAYS_BACK = Object.freeze([0, 1, 2, 9, 20, 45, 80]);
/** compose-proof.spec.ts pins these for JSON.stringify of its envelope and preview. */
export const COMPOSED_RESPONSE_SHA256 = "2737d60661d0392b19ccc368b62bdb7ba3c8f14ead2241a28d30d6914ee84390";
export const COMPOSED_PREVIEW_SHA256 = "f04259f71d4e2a34bddaa92f306687d051fd8c3ac082f012dcec80e8fd7af6d2";

export const stamp = (at) => new Date(at).toISOString();
export const label = (at) => stamp(at).slice(0, 10);
export const dayMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
export const addDays = (day, days) => label(dayMs(day) + days * DAY_MS);
const id = (prefix, owner, index) => `${prefix}:v1:${(owner * 1_000_000 + index).toString(16).padStart(64, "0")}`;
const PLANS = ["pro", "prolite", "plus"];

/** A synthetic owner: n selects the digest digit, plan and account track. */
export function syntheticOwner(n, plan = PLANS[(n - 1) % PLANS.length]) {
  return Object.freeze({
    n,
    digest: String(n).repeat(64),
    participant: `synthetic-owner-${n}`,
    account: `account-track:v2:${String.fromCharCode(97 + n).repeat(64)}`,
    plan,
  });
}
export const COMPOSE_OWNERS = Object.freeze([1, 2, 3].map((n) => syntheticOwner(n)));

/** The AnalyticsV2Owner A-1 would list for an effective (v1.2) owner. */
export function effectiveV2Owner(owner) {
  return Object.freeze({ participantId: owner.participant, ownerDigest: owner.digest, hasV1: false, hasV11: false,
    hasV12: true, hasLegacy: false, hasEffective: true, source: "effective" });
}

/** test/helpers/telemetry-v11.ts v11UsageRecord defaults, d43c8f92. */
function usageRecord(day, overrides) {
  return {
    schemaVersion: "usage-event-v1.1", eventId: `event:v2:${"c".repeat(64)}`,
    eventTime: `${day}T12:05:00.000Z`, sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    ...overrides,
  };
}

export function occurrence(owner, stream, at, occurrenceId, record) {
  return { methodVersion: "effective-telemetry-owner-day-v1", stream, participantId: owner.participant,
    ownerDigest: owner.digest, occurrenceId, eventTime: stamp(at), eventTimeConflict: false, status: "compatible",
    sourceCount: 1, sourceFormats: ["v12"], sourceRowIds: [], sourceRecordKeys: ["synthetic"],
    recordJson: canonicalTelemetryV11Json(record) };
}
const attribution = (owner) => ({ accountBasis: "same_source", accountTrackId: owner.account,
  planBasis: "same_source_occurrence", planType: owner.plan, planEraId: null });
export function usage(owner, index, at) {
  const record = usageRecord(label(at), { eventId: id("event", owner.n, index), eventTime: stamp(at),
    sessionUuid: `synthetic-session-${owner.n}`, accountPlanAttribution: attribution(owner) });
  return occurrence(owner, "usage", at, record.eventId, record);
}
export function quota(owner, index, at, usedPercent, resetsAt) {
  const observationId = id("quota", owner.n, index);
  return occurrence(owner, "quota", at, observationId, { schemaVersion: "quota-observation-v1.1", observationId,
    observedTime: stamp(at), provider: "openai_codex", planType: owner.plan, planVariant: "unknown", limitId: "codex",
    slot: "seven_day", usedPercent, windowDurationMinutes: 10_080, resetsAt: stamp(resetsAt),
    accountPlanAttribution: attribution(owner) });
}
export function session(owner, at) {
  return occurrence(owner, "session", at, id("session", owner.n, at % 1_000_000), {
    schemaVersion: "session-dimension-v1.1", sessionUuid: `synthetic-session-${owner.n}`, firstEventTime: stamp(at),
    provider: "openai_codex", toolClassCounts: { shell: 1 } });
}

/** compose-proof.spec.ts facts(): day -> streams on the 7 active days only. */
export function composeFacts(owner, today = TODAY) {
  const byDay = new Map();
  let k = 0;
  for (const back of ACTIVE_DAYS_BACK) {
    const start = dayMs(today) - back * DAY_MS;
    const u = Array.from({ length: 9 }, (_, i) => usage(owner, ++k, start + i * 3_600_000 + 30 * 60_000 + owner.n * 1000));
    const q = Array.from({ length: 9 }, (_, i) => quota(owner, ++k, start + i * 3_600_000, 5 + i * 10 + owner.n,
      start + 8 * DAY_MS));
    byDay.set(label(start), { usage: u, quota: q, session: [session(owner, start + 30 * 60_000)] });
  }
  return byDay;
}

/** The compose-proof corpus as computeAnalyticsV2 inputs (before the queue). */
export function composeProofCorpus() {
  const owners = COMPOSE_OWNERS.map(effectiveV2Owner);
  const occurrencesByOwner = new Map(COMPOSE_OWNERS.map((owner) => [owner.digest, composeFacts(owner)]));
  const publishedDays = ACTIVE_DAYS_BACK.map((back) => addDays(TODAY, -back)).sort();
  return { owners, occurrencesByOwner, publishedDays };
}

/** One contributing device for every owner with evidence on each day. */
export function oneDevicePerOwner(occurrencesByOwner, days) {
  return new Map(days.map((day) => [day, new Map([...occurrencesByOwner]
    .filter(([, byDay]) => byDay.has(day)).map(([digest]) => [digest, 1]))]));
}

/**
 * A dense effective owner: the compose pattern plus `denseDays` consecutive
 * days of `usagePerDay` usage rows (and the 9 quota rows) starting
 * `firstDenseBack` days before today. With the defaults the rows sit at the
 * start of today's 101-day window and inside every model window, so every
 * scalar and model window holds 7 x 17,200 = 120,400 usage rows: more than
 * the shared reducers' 120,000-row bound, with no day over 20,000 rows.
 */
export function denseFacts(owner, { firstDenseBack = 100, denseDays = 7, usagePerDay = 17_200 } = {}) {
  const byDay = composeFacts(owner);
  const spacingMs = Math.floor(86_000_000 / usagePerDay);
  let k = 10_000_000;
  for (let d = 0; d < denseDays; d++) {
    const start = dayMs(TODAY) - (firstDenseBack - d) * DAY_MS;
    if (byDay.has(label(start))) throw new Error("dense day overlaps an active day");
    const u = Array.from({ length: usagePerDay }, () => usage(owner, ++k, start + (k % usagePerDay) * spacingMs + 1_000));
    u.sort((left, right) => left.eventTime < right.eventTime ? -1 : left.eventTime > right.eventTime ? 1
      : left.occurrenceId < right.occurrenceId ? -1 : 1);
    const q = Array.from({ length: 9 }, (_, i) => quota(owner, ++k, start + i * 3_600_000, 5 + i * 10, start + 8 * DAY_MS));
    byDay.set(label(start), { usage: u, quota: q, session: [session(owner, start + 500)] });
  }
  return byDay;
}

/**
 * The compose pattern plus one day on which the owner's session switches
 * model `models` times, two requests per model 10 seconds apart, so the day
 * holds `models` distinct (model, effort) cache groups. The d43c8f92 cache
 * reducer bounds one owner-day at 512 groups (CACHE_RETENTION_GROUP_LIMIT)
 * and refuses the day above it. Model ids are synthetic tokens.
 */
export function manyModelFacts(owner, day, models) {
  const byDay = composeFacts(owner);
  if (byDay.has(day)) throw new Error("many-model day overlaps an active day");
  const start = dayMs(day) + 3_600_000;
  const rows = [];
  let k = 20_000_000;
  for (let model = 0; model < models; model++) {
    for (let request = 0; request < 2; request++) {
      const at = start + (model * 2 + request) * 10_000;
      const record = usageRecord(label(at), { eventId: id("event", owner.n, ++k), eventTime: stamp(at),
        sessionUuid: `synthetic-session-${owner.n}`, modelId: `synthetic-model-${model}`,
        accountPlanAttribution: attribution(owner) });
      rows.push(occurrence(owner, "usage", at, record.eventId, record));
    }
  }
  byDay.set(day, { usage: rows, quota: [], session: [] });
  return byDay;
}

/**
 * The compose pattern plus one occurrence the occurrence adapter reports as a
 * conflict: its sources disagree on event time across midnight, so A-1 emits
 * a `conflict` row (null event time and record) on both candidate days.
 */
export function conflictFacts(owner, conflictDay) {
  const byDay = composeFacts(owner);
  const occurrenceId = id("event", owner.n, 999_999);
  const conflictRow = { methodVersion: "effective-telemetry-owner-day-v1", stream: "usage",
    participantId: owner.participant, ownerDigest: owner.digest, occurrenceId, eventTime: null,
    eventTimeConflict: true, status: "conflict", sourceCount: 2, sourceFormats: ["v11", "v12"], sourceRowIds: [],
    sourceRecordKeys: ["synthetic-a", "synthetic-b"], recordJson: null };
  for (const day of [conflictDay, addDays(conflictDay, 1)]) {
    const streams = byDay.get(day) ?? { usage: [], quota: [], session: [] };
    byDay.set(day, { ...streams, usage: [...streams.usage, conflictRow] });
  }
  return byDay;
}

/** Non-effective owners exactly as A-1 routes them. */
export function legacyOnlyV2Owner(owner) {
  return Object.freeze({ participantId: owner.participant, ownerDigest: owner.digest, hasV1: false, hasV11: false,
    hasV12: false, hasLegacy: true, hasEffective: false, source: "v0.2" });
}
export function v1OnlyV2Owner(owner) {
  return Object.freeze({ participantId: owner.participant, ownerDigest: owner.digest, hasV1: true, hasV11: false,
    hasV12: false, hasLegacy: false, hasEffective: false, source: "v1" });
}
