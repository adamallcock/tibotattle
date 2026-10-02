import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay, expandAdminModelHistoryDay,
} from "@app-usagemonitor/telemetry-contract";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";

function counts() {
  return { fittedParticipantCount: 2, unstableParticipantCount: 1,
    staleParticipantCount: 1, refusedParticipantCount: 1,
    v1ParticipantCount: 5, unsupportedSourceParticipantCount: 3 };
}
function current() {
  return { day: "2026-09-03", catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-astra", 2_000, 2]], ...counts() };
}

test("admin compact history preserves legacy coverage, new models and separate Spark", () => {
  const legacy = { day: "2026-09-02", byModel: Object.fromEntries([
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  ].map((id) => [id, { capacityUsd: null, participantCount: 0 }])), ...counts() };
  legacy.byModel["gpt-5.6-sol"] = { capacityUsd: 900, participantCount: 2 };
  const wire = projectAdminModelHistoryDay(legacy);
  assert.equal(wire.catalogVersion, LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION);
  assert.deepEqual(wire.values, [["gpt-5.6-sol", 900, 2]]);
  assert.equal("byModel" in wire, false);
  const old = expandAdminModelHistoryDay(wire);
  assert.deepEqual(old.byModel["gpt-6-astra"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(old.byModel["gpt-5.6-luna"], { capacityUsd: null, participantCount: 0 });
  const fresh = expandAdminModelHistoryDay(current());
  assert.deepEqual(fresh.byModel["gpt-6-astra"], { capacityUsd: 2_000, participantCount: 2 });
  assert.deepEqual(fresh.byModel["gpt-5.4"], { capacityUsd: null, participantCount: 0 });
  assert.deepEqual(fresh.byModel["gpt-5.3-codex-spark"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(browser.expandAdminModelHistoryDay(wire), old);
  assert.deepEqual(browser.expandAdminModelHistoryDay(current()), fresh);
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "o1"));
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "gpt-5.5-codex"));
});

test("admin model history fails closed on extra fields, raw IDs, invalid tuples and counters", () => {
  const bad = [
    { ...current(), privatePath: "/private/canary" },
    { ...current(), catalogVersion: "unreviewed" },
    { ...current(), day: "2026-02-30" },
    { ...current(), fittedParticipantCount: 0 },
    { ...current(), values: [["private-model-canary", 1, 1]] },
    { ...current(), values: [["gpt-5.3-codex-spark", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1], ["gpt-6-astra", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1, "private-canary"]] },
    { ...current(), values: [["gpt-6-astra", null, 0]] },
    ...[0, -1, NaN, Infinity, "1"].map((value) => ({ ...current(), values: [["gpt-6-astra", value, 1]] })),
    ...[0, -1, 3, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...current(), values: [["gpt-6-astra", 1, value]] })),
  ];
  for (const value of bad) {
    assert.equal(projectAdminModelHistoryDay(value), null);
    assert.equal(browser.projectAdminModelHistoryDay(value), null);
  }
});

test("GPT-6.1 Sol preserves prior catalog coverage and stays separate from GPT-6 Sol", () => {
  const prior = { ...current(), catalogVersion: "reviewed-model-catalog-2026-09-23.1",
    values: [["gpt-6-sol", 1_000, 2]] };
  const old = expandAdminModelHistoryDay(prior);
  assert.equal(old.catalogVersion, prior.catalogVersion);
  assert.deepEqual(old.byModel["gpt-6-sol"], { capacityUsd: 1_000, participantCount: 2 });
  assert.deepEqual(old.byModel["gpt-6.1-astra"], { capacityUsd: null, participantCount: 0 });
  assert.deepEqual(old.byModel["gpt-6.1-sol"], { capacityUsd: null, participantCount: null });
  assert.equal(projectAdminModelHistoryDay({ ...prior, values: [["gpt-6.1-sol", 1_000, 1]] }), null);
  const fresh = expandAdminModelHistoryDay({ ...current(),
    values: [["gpt-6-sol", 1_000, 2], ["gpt-6.1-sol", 1_200, 1]] });
  assert.deepEqual(fresh.byModel["gpt-6-sol"], { capacityUsd: 1_000, participantCount: 2 });
  assert.deepEqual(fresh.byModel["gpt-6.1-sol"], { capacityUsd: 1_200, participantCount: 1 });
  assert.deepEqual(browser.expandAdminModelHistoryDay(prior), old);
});

// ---- The admin preview's storage ceiling ---------------------------------
//
// The cached admin preview (blended allowance days plus this model history) is
// written to a column whose storage CHECK is 262,144 bytes, and the Worker
// refuses to write or read anything larger (PREVIEW_CACHE_JSON_LIMIT_BYTES).
// An oversized preview is not an error page: the cache is reported unavailable
// and the public per-model graph stops updating. So the accounting below is
// against the REAL ceiling, taken from source, for the WHOLE preview.
//
// The previous gate compared the model history alone with a hard-coded 192 KiB,
// "leaving a separately tested 64 KiB allowance" for the rest. No test measured
// that rest, and at the four-plan roster the outer part's widest serialization
// is about 70 KiB, so the allowance was both unverified and too small.
//
// Both halves are now built at the widest serialization the writers can
// produce, and the parts of that which source can anchor are anchored:
//   - dollars are the widest finite double (23 characters), because nothing
//     bounds a fitted capacity;
//   - counts are bounded. A publication capture refuses a cohort over
//     MAX_COHORT_BYTES (2 MiB) of canonical owner identities, each at least a
//     64-character digest, so a cohort has at most 32,768 owners. Eight digits
//     is three thousand times that, which also covers several fits per owner;
//   - the plan roster is read from source, never fewer than the four the
//     production site publishes (Pro, Pro 5x, Pro Max, Plus);
//   - the preview's own key list is read from the Worker's validator, so a new
//     field fails this test until it is accounted for here.
const WIDEST_DOLLARS = 1.7976931348623157e308;
const WIDEST_COUNT = 99_999_999;
const PREVIEW_DAYS = 70;
const MINIMUM_PLAN_COUNT = 4;
const repositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workerSource = () => repositoryFile("apps/worker/src/admin-community-allowance.ts");
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

function storageCeilingBytes() {
  const limit = /export const PREVIEW_CACHE_JSON_LIMIT_BYTES = (\d+) \* ([\d_]+);/u.exec(workerSource());
  assert.ok(limit, "PREVIEW_CACHE_JSON_LIMIT_BYTES must stay a literal product the gate can read");
  const guard = Number(limit[1]) * Number(limit[2].replaceAll("_", ""));
  // The guard may never exceed the narrowest storage CHECK it sits in front of.
  // Each file is cut to the one CREATE statement of the preview table. The D1
  // table is always read; the PostgreSQL table only where this checkout has the
  // PostgreSQL store (the GCP line), so one gate serves both.
  const checks = [
    ["apps/worker/analytics-migrations/0011_community_graph_publication.sql",
      "analytics_community_graph_previews", /length\(CAST\(payload_json AS BLOB\)\)<=(\d+)/u, true],
    ["apps/worker/postgres/migrations/primary/0053_community_publication_authority.sql",
      "community_graph_previews", /octet_length\(convert_to\(payload_json, 'UTF8'\)\) <= (\d+)/u, false],
  ].flatMap(([path, table, pattern, required]) => {
    if (!required && !existsSync(new URL(`../${path}`, import.meta.url))) return [];
    const source = repositoryFile(path);
    const start = source.indexOf(`CREATE TABLE ${table} (`);
    assert.notEqual(start, -1, `${path} no longer creates ${table}`);
    const next = source.indexOf("CREATE ", start + 1);
    const match = pattern.exec(source.slice(start, next === -1 ? undefined : next));
    assert.ok(match, `${path} no longer carries the ${table} payload CHECK this gate reads`);
    return [Number(match[1])];
  });
  assert.equal(guard, Math.min(...checks),
    "the Worker guard and the storage CHECK must be the same number; raise both with a migration");
  return guard;
}

function planCount() {
  const config = /COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG = Object\.freeze\(\[([\s\S]*?)\] as const\)/u
    .exec(repositoryFile("apps/worker/src/community-allowance.ts"));
  assert.ok(config, "the personal plan roster must stay readable by the gate");
  return Math.max(MINIMUM_PLAN_COUNT, (config[1].match(/planType:/gu) ?? []).length);
}

function previewKeys() {
  const keys = /exactKeys\(preview, \[([^\]]*)\]/u.exec(workerSource());
  assert.ok(keys, "the preview validator's key list must stay readable by the gate");
  return [...keys[1].matchAll(/"([A-Za-z0-9]+)"/gu)].map((match) => match[1]);
}

function modelHistoryDays(primaryIds) {
  const day = { day: "2026-09-03", catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: primaryIds.map((id) => [id, WIDEST_DOLLARS, WIDEST_COUNT]),
    fittedParticipantCount: WIDEST_COUNT, unstableParticipantCount: 0,
    staleParticipantCount: 0, refusedParticipantCount: 0,
    v1ParticipantCount: WIDEST_COUNT, unsupportedSourceParticipantCount: WIDEST_COUNT };
  const projected = projectAdminModelHistoryDay(day);
  assert.notEqual(projected, null, "the widest day must still be a valid compact day");
  return Array.from({ length: PREVIEW_DAYS }, () => projected);
}

function widestPreview(plans) {
  const summary = () => ({ fitCount: WIDEST_COUNT, participantCount: WIDEST_COUNT, centralUsd: WIDEST_DOLLARS,
    band80Usd: { lowerUsd: WIDEST_DOLLARS, upperUsd: WIDEST_DOLLARS } });
  const planTypes = Array.from({ length: plans }, (_, index) => `plan-${String(index).padStart(7, "0")}`);
  const primary = ADMIN_MODEL_CONFIG.filter((model) => model.allowanceTrack === "primary");
  const fields = {
    schemaVersion: "admin-community-allowance-preview-v0.3", generatedAt: "2026-09-03T00:00:00.000Z",
    from: "2026-06-26", to: "2026-09-03", basis: "x".repeat(72), referencePlanType: "pro",
    trailingDays: 30, qualification: "x".repeat(48), spanFloorPp: 25,
    plans: planTypes.map((planType) => ({ planType, label: "x".repeat(16), multiplier: 0.4 })),
    coverage: Object.fromEntries(["uploadingParticipantCount", "cachedParticipantCount", "recentFittedParticipantCount",
      "mergeEligibleParticipantCount", "noQualifyingFitParticipantCount", "noRecentFitParticipantCount",
      "unsupportedPlanParticipantCount"].map((key) => [key, WIDEST_COUNT])),
    days: Array.from({ length: PREVIEW_DAYS }, () => ({ day: "2026-09-03", combined: summary(),
      byPlanType: Object.fromEntries(planTypes.map((planType) => [planType, summary()])) })),
    models: { modelConfig: ADMIN_MODEL_CONFIG, basis: "x".repeat(48), gate: "x".repeat(40),
      days: modelHistoryDays(primary.map((model) => model.modelId)) },
  };
  return fields;
}

test("the admin preview's key list is accounted for by the size gate", () => {
  // A field the Worker adds to the preview must be measured here before it ships.
  assert.deepEqual([...previewKeys()].sort(), Object.keys(widestPreview(MINIMUM_PLAN_COUNT)).sort());
});

test("70 complete catalog days plus the whole preview stay under the storage ceiling at the widest serialization", (t) => {
  const ceiling = storageCeilingBytes();
  const preview = widestPreview(planCount());
  const total = jsonBytes(preview);
  const modelBytes = jsonBytes(preview.models);
  // One more primary model costs a roster entry plus a tuple on every day, at
  // the longest identity and label the validators accept for the catalog.
  const longest = (key) => Math.max(...ADMIN_MODEL_CONFIG.map((model) => model[key].length));
  const perModel = jsonBytes({ modelId: "x".repeat(longest("modelId")), label: "x".repeat(longest("label")),
    allowanceTrack: "primary", pricingStatus: "published" }) + 1
    + PREVIEW_DAYS * (jsonBytes(["x".repeat(longest("modelId")), WIDEST_DOLLARS, WIDEST_COUNT]) + 1);
  const spareModels = Math.floor((ceiling - total) / perModel);
  t.diagnostic(`preview ${total} B of ${ceiling} B (models ${modelBytes} B, ${planCount()} plans); `
    + `room for ${spareModels} more primary models at ${perModel} B each`);
  assert.ok(total < ceiling, `the widest preview is ${total} B and would exceed the ${ceiling} B storage ceiling; `
    + "compact the wire (see the receipt) or raise the guard and the CHECK together by migration");
  assert.ok(modelBytes < total, "the model history is a part of the preview, never all of it");
});
