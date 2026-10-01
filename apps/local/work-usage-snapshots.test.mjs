import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkUsageSnapshotStore } from "./work-usage-snapshots.js";
import { createWorkUsageService } from "../../src/application/index.js";
import { createWorkUsageAccumulator, WORK_USAGE_SCHEMA } from "../../src/reporting/index.js";

const now = Date.UTC(2026, 8, 21);
const query = { schemaVersion: WORK_USAGE_SCHEMA, period: "7d" };
function result(tokens = 20) {
  const accumulator = createWorkUsageAccumulator();
  if (tokens !== 0) accumulator.add({ thread: "private-thread-handle", project: "private-project-handle",
    worktree: "private-worktree-handle", model: "gpt-5.5", at: now - 10,
    components: { input_uncached_tokens: tokens, input_cache_read_tokens: 0, input_cache_write_tokens: 0,
      output_text_tokens: 0, output_reasoning_tokens: 0 }, price: { amount: "0.1", status: "fully_priced" } });
  return { status: "available", generation: { status: "complete", fingerprint: "synthetic-generation" },
    scope: "private-account-handle", scopes: [{ id: "private-account-handle", status: "available" }],
    fromMs: now - 604_800_000, toMs: now, cells: accumulator.finish(), models: ["gpt-5.5"],
    threadLookup: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "private-thread-handle" },
    threadFamilies: { "private-thread-handle": "private-thread-handle" },
    display: { projects: { "private-project-handle": { name: "Private project name" } },
      threads: { "private-thread-handle": { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Private task name" } } },
    metadata: { status: "available", observedAt: now, sourcePath: "/private/synthetic/source" },
    pricing: { basis: "event_time", fingerprint: "synthetic-prices" } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "saved-work-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { snapshotFile: join(root, "snapshot.json"), codexHome: join(root, "codex"), indexFile: join(root, "index.sqlite") };
  return { options, store: createWorkUsageSnapshotStore(options) };
}
async function completed(service, request) {
  let response = await service.query(request);
  for (let i = 0; i < 100 && (response.status === "preparing" || response.retained); i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    response = await service.query({ ...request, sourceSnapshotId: undefined, snapshotId: response.refreshSnapshotId ?? response.snapshotId });
  }
  assert.equal(response.status, "available");
  assert.equal(response.retained, undefined);
  return response;
}

test("saved work figures survive restart without names, raw IDs, paths or join handles", async t => {
  const { store, options } = await fixture(t);
  assert.equal(await store.write(query, result()), true);
  const bytes = await readFile(options.snapshotFile, "utf8");
  for (const forbidden of ["private-", "Private ", "aaaaaaaa-aaaa", "/private/synthetic", options.codexHome, "threadLookup", "display"])
    assert.equal(bytes.includes(forbidden), false, forbidden);
  const restored = await createWorkUsageSnapshotStore(options).read(query);
  assert.equal(restored.cells[0].tokens, 20);
  assert.deepEqual(restored.cells[0].projects, ["p-1"]);
  assert.equal(restored.metadata.observedAt, now);
  assert.deepEqual(restored.threadLookup, {});
  assert.equal(await store.read({ ...query, scope: "different-scope" }), null);
  assert.equal(await store.read({ ...query, period: "30d" }), null);
  assert.equal(await createWorkUsageSnapshotStore({ ...options, codexHome: "different-source" }).read(query), null);
});

test("durable work figures match the exact reporting end before reuse or publication", async t => {
  const { store, options } = await fixture(t);
  const exact = { ...query, endAt: new Date(now).toISOString() };
  assert.equal(await store.write(exact, result()), true);
  const restarted = createWorkUsageSnapshotStore(options);
  assert.equal((await restarted.read(exact)).cells[0].tokens, 20);
  for (const shift of [-1, 1]) {
    const otherEnd = { ...query, endAt: new Date(now + shift).toISOString() };
    assert.equal(await restarted.read(otherEnd), null, "another instant cannot use this saved window");
    assert.equal(await restarted.write(otherEnd, result(99)), false, "a stale build cannot publish for another instant");
  }
  assert.equal((await createWorkUsageSnapshotStore(options).read(exact)).cells[0].tokens, 20);
});

test("an exact reporting window restores after restart and refuses an older replacement", async t => {
  const { store, options } = await fixture(t);
  const exact = { ...query, endAt: new Date(now).toISOString() };
  await store.write(exact, result());
  let finish;
  const service = createWorkUsageService({ clock: () => now + 1000,
    snapshotStore: createWorkUsageSnapshotStore(options),
    build: () => new Promise(resolve => { finish = resolve; }),
    enrich: () => assert.fail("a restored anonymous report does not load names") });
  t.after(() => service.close());
  const saved = await service.query(exact);
  assert.equal(saved.retained, true);
  assert.equal(saved.namesAvailable, false);
  assert.equal(saved.toMs, now);
  assert.equal(saved.totals.tokens, 20);
  finish({ ...result(99), fromMs: now - 604_800_001, toMs: now - 1 });
  await new Promise(resolve => setImmediate(resolve));
  const rejected = await service.query({ ...exact, snapshotId: saved.refreshSnapshotId });
  assert.equal(rejected.retained, true);
  assert.equal(rejected.refreshing, false);
  assert.equal(rejected.errorCode, "work_usage_snapshot_changed");
  assert.equal(rejected.toMs, now);
  assert.equal(rejected.totals.tokens, 20);
  for (const shift of [-1, 1]) {
    const pending = await service.query({ ...query, endAt: new Date(now + shift).toISOString() });
    assert.equal(pending.status, "preparing");
    assert.equal(pending.retained, undefined);
    assert.equal(pending.toMs, now + shift);
  }
  await service.close();
  assert.equal((await createWorkUsageSnapshotStore(options).read(exact)).cells[0].tokens, 20);
});

test("in-memory saved reports respect exact reporting ends without a source snapshot", async t => {
  let block = false;
  const service = createWorkUsageService({ clock: () => now + 1000,
    build: () => block ? new Promise(() => {}) : result() });
  t.after(() => service.close());
  const exact = { ...query, endAt: new Date(now).toISOString() };
  const original = await completed(service, exact);
  block = true;
  const retained = await service.query(exact);
  assert.equal(retained.retained, true);
  assert.equal(retained.namesAvailable, true);
  assert.equal(retained.snapshotId, original.snapshotId);
  assert.equal(retained.toMs, now);
  for (const shift of [-1, 1]) {
    const pending = await service.query({ ...query, endAt: new Date(now + shift).toISOString() });
    assert.equal(pending.status, "preparing");
    assert.equal(pending.retained, undefined);
    assert.equal(pending.toMs, now + shift);
  }
});

test("partial work refresh cannot replace saved figures; authoritative empty can", async t => {
  const { store, options } = await fixture(t);
  await store.write(query, result());
  assert.equal(await store.write(query, { ...result(10), generation: { status: "partial" } }), false);
  assert.equal((await store.read(query)).cells[0].tokens, 20);
  assert.equal(await store.write(query, result(0)), true);
  assert.deepEqual((await createWorkUsageSnapshotStore(options).read(query)).cells, []);
});

test("corrupt and incompatible work snapshots are rejected", async t => {
  const { store, options } = await fixture(t);
  await store.write(query, result());
  const original = await readFile(options.snapshotFile, "utf8");
  for (const mutate of [value => { value.schemaVersion = "future"; }, value => { value.snapshot.entries[0].cells[0].tokens++; }]) {
    const value = JSON.parse(original); mutate(value);
    await writeFile(options.snapshotFile, JSON.stringify(value), { mode: 0o600 });
    assert.equal(await createWorkUsageSnapshotStore(options).read(query), null);
  }
});

test("service reload immediately returns an immutable saved report while independent replacement runs", async t => {
  let finish;
  let builds = 0;
  const service = createWorkUsageService({ clock: () => now,
    build: async () => ++builds === 1 ? result() : new Promise(resolve => { finish = resolve; }),
    enrich: async () => ({ "private-project-handle": { name: "Transient project" } }) });
  t.after(() => service.close());
  const original = await completed(service, query);
  const saved = await service.query(query);
  assert.equal(saved.retained, true);
  assert.equal(saved.refreshing, true);
  assert.equal(saved.namesAvailable, true);
  assert.equal(saved.snapshotId, original.snapshotId);
  assert.notEqual(saved.refreshSnapshotId, saved.snapshotId);
  assert.equal(saved.totals.tokens, 20);
  assert.equal(saved.display["private-project-handle"].name, "Transient project");
  finish(result(0));
  const fresh = await completed(service, { ...query, snapshotId: saved.refreshSnapshotId });
  assert.equal(fresh.totals.tokens, 0);
  assert.notEqual(fresh.snapshotId, saved.snapshotId);
});

test("restart serves saved figures with blocked or failed build and does not expose another query", async t => {
  const { store, options } = await fixture(t);
  await store.write(query, result());
  let rejectBuild;
  const service = createWorkUsageService({ clock: () => now,
    snapshotStore: createWorkUsageSnapshotStore(options),
    build: () => new Promise((_, reject) => { rejectBuild = reject; }),
    enrich: () => { throw new Error("anonymous snapshots never enrich"); } });
  t.after(() => service.close());
  const saved = await service.query(query);
  assert.equal(saved.retained, true);
  assert.equal(saved.namesAvailable, false);
  assert.equal(saved.totals.tokens, 20);
  assert.deepEqual(saved.display, {});
  assert.equal(saved.nextCursor, null);
  rejectBuild(new Error("synthetic failure"));
  await new Promise(resolve => setImmediate(resolve));
  const failed = await service.query({ ...query, snapshotId: saved.refreshSnapshotId });
  assert.equal(failed.retained, true);
  assert.equal(failed.refreshing, false);
  assert.equal(failed.refreshSnapshotId, null);
  assert.equal(failed.totals.tokens, 20);
  const filtered = await service.query({ ...query, snapshotId: saved.refreshSnapshotId, search: "secret" });
  assert.equal(filtered.status, "unavailable");
  const other = await service.query({ ...query, scope: "another" });
  assert.equal(other.status, "preparing");
  assert.equal(other.retained, undefined);
});

test("cancelled late build cannot overwrite durable saved results", async t => {
  const { store } = await fixture(t);
  await store.write(query, result());
  let finish;
  const service = createWorkUsageService({ clock: () => now, snapshotStore: store,
    build: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => service.close());
  const saved = await service.query(query);
  await service.query({ ...query, action: "cancel", snapshotId: saved.refreshSnapshotId });
  finish(result(99));
  await new Promise(resolve => setImmediate(resolve));
  await service.close();
  assert.equal((await store.read(query)).cells[0].tokens, 20);
});

test("saved non-project figures preserve the public classification", async t => {
  const { store } = await fixture(t);
  const candidate = result();
  candidate.cells[0].projects = ["non-project"];
  await store.write(query, candidate);
  assert.deepEqual((await store.read(query)).cells[0].projects, ["non-project"]);
});

test("reports reached through period navigation are retained with their original bounds", async t => {
  let block = false;
  const service = createWorkUsageService({ clock: () => now, build: async q => block
    ? new Promise(() => {}) : { ...result(), fromMs: q.fromMs, toMs: q.toMs } });
  t.after(() => service.close());
  const first = await completed(service, query);
  const thirty = await completed(service, { ...query, period: "30d", sourceSnapshotId: first.snapshotId });
  block = true;
  const saved = await service.query({ ...query, period: "30d" });
  assert.equal(saved.retained, true);
  assert.equal(saved.snapshotId, thirty.snapshotId);
  assert.equal(saved.fromMs, now - 2_592_000_000);
});

test("missing completeness evidence cannot displace last good figures", async t => {
  let candidate = result();
  const service = createWorkUsageService({ clock: () => now, build: async () => candidate });
  t.after(() => service.close());
  await completed(service, query);
  for (const change of [{ generation: {} }, { metadata: { status: "unavailable" } }, { generation: { status: "partial" } }]) {
    candidate = { ...result(99), ...change };
    const saved = await service.query(query);
    await new Promise(resolve => setImmediate(resolve));
    const failed = await service.query({ ...query, snapshotId: saved.refreshSnapshotId });
    assert.equal(failed.retained, true);
    assert.equal(failed.refreshing, false);
    assert.equal(failed.totals.tokens, 20);
  }
});

test("slow snapshot writes coalesce repeated refreshes and publish the latest figures last", async () => {
  const { createWorkUsageSnapshotStore: createContext } = await import("../../src/application/index.js");
  let release, started, writes = 0;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const context = createContext({ snapshotFile: "/synthetic/snapshot.json", codexHome: "/synthetic/codex", indexFile: "/synthetic/index",
    createStore: () => ({ read: async () => null, write: async () => {
      if (++writes === 1) { started(); await new Promise(resolve => { release = resolve; }); }
      return true;
    } }) });
  const pending = context.write(query, result(1));
  await firstStarted;
  for (let i = 2; i <= 20; i++) assert.equal(context.write(query, result(i)), pending);
  release();
  assert.equal(await pending, true);
  assert.equal(writes, 2);
  assert.equal((await context.read(query)).cells[0].tokens, 20);
});
