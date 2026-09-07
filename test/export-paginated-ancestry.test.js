import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSourcePlanSummaryContract } from "../src/export/index.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import {
  createCodexExportSourcePlan,
  resolveCodexExportSourcePlan,
  verifyCodexExportSourcePlan,
} from "../src/export-source-plan.js";
import { createExportSourcePlanBundle } from "../src/export-source-plan-bundle.js";
import { localExportSourcePipeline, localExportWorkspace, localSafeRecords } from "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";

const { createLocalExportWorkspace, resumeLocalExportWorkspace } = localExportSourcePipeline.controller;
const { openExportWorkspace } = localExportWorkspace;
const { scanCodexSafeRecords } = localSafeRecords;
const { planDigest } = createSourcePlanSummaryContract();
const SECRET = Buffer.alloc(32, 81);
const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const PARENT = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const SECOND_CHILD = "44444444-4444-4444-8444-444444444444";
const RESET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tokenCount(total) {
  const usage = { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total };
  return { timestamp: "2026-07-24T12:02:00.000Z", type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: usage, last_token_usage: usage },
  } };
}

async function fixture(t, { secondChild = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-paginated-ancestry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const definitions = [
    { label: "grandparent", id: PARENT, parentId: null, totals: [20] },
    { label: "older", id: THREAD, parentId: PARENT, totals: [40] },
    { label: "reset", id: THREAD, parentId: null, rolloutId: RESET, totals: [100] },
    { label: "child", id: CHILD, parentId: THREAD, totals: [100, 30] },
    ...(secondChild ? [{ label: "secondChild", id: SECOND_CHILD, parentId: THREAD, totals: [100, 30] }] : []),
  ];
  const paths = {};
  for (const [index, source] of definitions.entries()) {
    const name = `rollout-2026-07-24T12-00-0${index}-${source.id}${source.rolloutId ? `_${source.rolloutId}` : ""}.jsonl`;
    paths[source.label] = join(home, "sessions", name);
    const records = [
      { ordinal: 0, timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: {
        id: source.id,
        ...(source.parentId === null ? {} : { forked_from_id: source.parentId }),
        ...(source.rolloutId ? { history_mode: "paginated" } : {}),
      } },
      { timestamp: "2026-07-24T12:01:00.000Z", type: "turn_context", payload: { model: "gpt-6-astra" } },
      ...source.totals.map(tokenCount),
    ];
    await writeFile(paths[source.label], `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  }
  const databasePath = join(home, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE threads(id TEXT, rollout_path TEXT)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(THREAD, paths.reset);
  } finally { database.close(); }
  await chmod(databasePath, 0o600);
  return { root, home, paths, databasePath };
}

function options(value, label) {
  return { directory: join(value.root, label), codexHome: value.home, secret: SECRET,
    startAt: START_AT, endAt: END_AT, createdAt: END_AT, checkpointLinesPerBatch: 1 };
}

function planOptions(value) {
  return { codexHome: value.home, startAt: START_AT, endAt: END_AT };
}

function ordered(records) {
  return records.toSorted((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function direct(value) {
  const records = [];
  await scanCodexSafeRecords({ ...planOptions(value), secret: SECRET,
    onRecord: ({ recordType, record }) => { if (recordType === "usageEvent") records.push(record); } });
  return ordered(records);
}

async function workspaceRecords(directory) {
  const workspace = await openExportWorkspace({ directory });
  try {
    return ordered([...workspace.iterateRecords()].filter((item) => item.family === "usageEvents").map((item) => item.record));
  } finally { workspace.close(); }
}

function selectedParent(plan, value) {
  const child = plan.sources.find((source) => source.path === value.paths.child);
  return plan.sources.find((source) => source.sourceKey === child.parentSourceKey);
}

test("an explicit reset head wins replay ancestry even when an older generation sorts later", async (t) => {
  const value = await fixture(t);
  const plan = await createCodexExportSourcePlan(planOptions(value));
  assert.ok(plan.sources.findIndex((source) => source.path === value.paths.reset)
    < plan.sources.findIndex((source) => source.path === value.paths.older), "dependency depth puts older generation later");
  assert.equal(selectedParent(plan, value).path, value.paths.reset);
  const records = await direct(value);
  assert.equal(records.length, 4);
  assert.equal(records.reduce((sum, record) => sum + record.components.inputUncachedTokens, 0), 190);
  const configuration = options(value, "fresh");
  await createLocalExportWorkspace(configuration);
  assert.deepEqual(await workspaceRecords(configuration.directory), records);
});

test("a persisted checkpoint keeps its frozen parent when the live selected-head database changes", async (t) => {
  const value = await fixture(t);
  const before = await direct(value);
  const configuration = options(value, "resume");
  await assert.rejects(createLocalExportWorkspace({ ...configuration, failpoint(stage) {
    if (stage === "after_source_checkpoint_batch") throw new Error("synthetic-ancestry-interruption");
  } }), /synthetic-ancestry-interruption/u);
  const workspace = await openExportWorkspace({ directory: configuration.directory });
  let storedPlan;
  try { storedPlan = workspace.loadSourcePlan(); } finally { workspace.close(); }
  const database = new DatabaseSync(value.databasePath);
  try { database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(value.paths.older, THREAD); }
  finally { database.close(); }
  const resolved = await resolveCodexExportSourcePlan(storedPlan, { codexHome: value.home });
  assert.equal(resolved.sourcePlanSha256, storedPlan.sourcePlanSha256);
  assert.equal(selectedParent(resolved, value).path, value.paths.reset);
  assert.equal(resolved.sources.find((source) => source.path === value.paths.reset).rolloutInfo.resolvedHead, true);
  assert.equal(resolved.sources.find((source) => source.path === value.paths.older).rolloutInfo.resolvedHead, false);
  await resumeLocalExportWorkspace(configuration);
  assert.deepEqual(await workspaceRecords(configuration.directory), before);
  const livePlan = await createCodexExportSourcePlan(planOptions(value));
  assert.equal(selectedParent(livePlan, value).path, value.paths.older);
  const live = await direct(value);
  assert.equal(live.length, 5);
  assert.equal(live.reduce((sum, record) => sum + record.components.inputUncachedTokens, 0), 290);
});

test("ephemeral head flags cannot override a private bundle's committed replay parent", async (t) => {
  const value = await fixture(t);
  const before = await direct(value);
  const bundle = await createExportSourcePlanBundle({ ...planOptions(value), secret: SECRET,
    resourceGuard: createExportResourceGuard({ scope: "export_set" }) });
  const originalDigest = bundle.codexPlan.sourcePlanSha256;
  for (const source of bundle.codexPlan.sources) source.rolloutInfo.resolvedHead = source.path === value.paths.older;
  await verifyCodexExportSourcePlan(bundle.codexPlan);
  assert.equal(bundle.codexPlan.sourcePlanSha256, originalDigest);
  assert.equal(selectedParent(bundle.codexPlan, value).path, value.paths.reset);
  const resolved = await resolveCodexExportSourcePlan(bundle.codexPlan, { codexHome: value.home });
  assert.equal(resolved.sources.find((source) => source.path === value.paths.reset).rolloutInfo.resolvedHead, true);
  // The private capability's outer hash covers its ephemeral projection too.
  // Recompute it deliberately to prove the committed graph, not those hints,
  // is what the verified checkpoint adapter actually consumes.
  const { sourcePlanBundleSha256: ignored, ...payload } = bundle;
  bundle.sourcePlanBundleSha256 = createHash("sha256").update("app-usagemonitor/export-source-plan-bundle/v0.1\0")
    .update(stableJson(payload)).digest("hex");
  const configuration = options(value, "flag-tamper");
  const { codexHome: unusedCodexHome, ...frozenConfiguration } = configuration;
  await createLocalExportWorkspace({ ...frozenConfiguration, sourcePlanBundle: bundle });
  assert.deepEqual(await workspaceRecords(configuration.directory), before);
});

test("frozen replay parents must match the logical parent and stay consistent across children", async (t) => {
  const value = await fixture(t, { secondChild: true });
  const plan = await createCodexExportSourcePlan(planOptions(value));
  for (const parentPath of [value.paths.older, value.paths.grandparent]) {
    const changed = structuredClone(plan);
    const secondChild = changed.sources.find((source) => source.path === value.paths.secondChild);
    secondChild.parentSourceKey = changed.sources.find((source) => source.path === parentPath).sourceKey;
    changed.sourcePlanSha256 = planDigest(changed.sources);
    await assert.rejects(verifyCodexExportSourcePlan(changed), { code: "export_source_source_changed" });
    await assert.rejects(resolveCodexExportSourcePlan(changed, { codexHome: value.home }), { code: "export_source_source_changed" });
  }
});
