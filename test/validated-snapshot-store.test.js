import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createValidatedSnapshotStore } from "../src/platform/index.js";

const SCHEMA = "test-complete-projection-v1";
const SAVED_AT = "2026-09-21T12:00:00.000Z";
const snapshot = { status: "complete", values: [1, 2, 3] };
const validate = (value) => value?.status === "complete"
  && Object.keys(value).sort().join(",") === "status,values"
  && Array.isArray(value.values)
  && value.values.length <= 100
  && value.values.every((item) => Number.isSafeInteger(item) && item >= 0);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "validated-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotFile = join(root, "private", "projection-v1.json");
  const options = {
    snapshotFile, schemaVersion: SCHEMA, validate,
    now: () => Date.parse(SAVED_AT),
  };
  return { root, snapshotFile, options, store: createValidatedSnapshotStore(options) };
}

test("validated snapshots survive a new store instance and retain the exact envelope", async (t) => {
  const { snapshotFile, options, store } = await fixture(t);
  assert.equal(await store.read(), null);
  assert.equal(await store.write(snapshot), true);
  const reopened = createValidatedSnapshotStore(options);
  assert.deepEqual(await reopened.read(), { savedAt: SAVED_AT, snapshot });
  const payload = JSON.stringify(snapshot);
  assert.equal(await readFile(snapshotFile, "utf8"), JSON.stringify({
    schemaVersion: SCHEMA,
    savedAt: SAVED_AT,
    digest: createHash("sha256").update(payload, "utf8").digest("hex"),
    snapshot,
  }));
  if (process.platform !== "win32") {
    assert.equal((await lstat(snapshotFile)).mode & 0o777, 0o600);
    assert.equal((await lstat(dirname(snapshotFile))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(dirname(snapshotFile)), ["projection-v1.json"]);
  assert.equal(await reopened.write({ status: "complete", values: [] }), true);
  assert.deepEqual((await store.read()).snapshot.values, [], "a verified empty result replaces old data");
});

test("incomplete, oversized, unserializable and failed-clock writes preserve the previous receipt", async (t) => {
  const { snapshotFile, options, store } = await fixture(t);
  assert.equal(await store.write(snapshot), true);
  const original = await readFile(snapshotFile, "utf8");
  assert.equal(await store.write({ status: "preparing", values: [] }), false);
  assert.equal(await store.write({ ...snapshot, privateTitle: "must not persist" }), false);
  assert.equal(await createValidatedSnapshotStore({ ...options, maximumBytes: 20 }).write(snapshot), false);
  assert.equal(await createValidatedSnapshotStore({ ...options, now: () => NaN }).write(snapshot), false);
  assert.equal(await createValidatedSnapshotStore({ ...options, now: () => { throw new Error("clock"); } }).write(snapshot), false);
  assert.equal(await createValidatedSnapshotStore({ ...options, validate: () => { throw new Error("validator"); } }).write(snapshot), false);
  const circular = {};
  circular.self = circular;
  assert.equal(await createValidatedSnapshotStore({ ...options, validate: () => true }).write(circular), false);
  assert.equal(await readFile(snapshotFile, "utf8"), original);
  assert.deepEqual(await store.read(), { savedAt: SAVED_AT, snapshot });
});

test("digest, schema, shape, timestamp and malformed receipts fail closed", async (t) => {
  const { snapshotFile, options, store } = await fixture(t);
  assert.equal(await store.write(snapshot), true);
  const valid = JSON.parse(await readFile(snapshotFile, "utf8"));
  const altered = { status: "preparing", values: [] };
  const candidates = [
    { ...valid, digest: "0".repeat(64) },
    { ...valid, schemaVersion: "test-complete-projection-v2" },
    { ...valid, savedAt: "2026-09-21" },
    { ...valid, privateTitle: "unexpected" },
    { ...valid, snapshot: { ...snapshot, values: [999] } },
    { ...valid, snapshot: altered, digest: createHash("sha256").update(JSON.stringify(altered)).digest("hex") },
  ];
  for (const candidate of candidates) {
    await writeFile(snapshotFile, JSON.stringify(candidate), { mode: 0o600 });
    assert.equal(await store.read(), null);
  }
  await writeFile(snapshotFile, "{broken", { mode: 0o600 });
  assert.equal(await store.read(), null);
  assert.equal(await store.write(snapshot), true);
  assert.equal(await createValidatedSnapshotStore({ ...options, maximumBytes: 20 }).read(), null);
  assert.equal(await createValidatedSnapshotStore({ ...options, validate: () => { throw new Error("validator"); } }).read(), null);
});

test("open-mode files, symlinks and open-mode publication directories fail closed", async (t) => {
  const { root, snapshotFile, options, store } = await fixture(t);
  assert.equal(await store.write(snapshot), true);
  const linked = join(root, "linked.json");
  await symlink(snapshotFile, linked);
  assert.equal(await createValidatedSnapshotStore({ ...options, snapshotFile: linked }).read(), null);
  if (process.platform === "win32") return;
  await chmod(snapshotFile, 0o644);
  assert.equal(await store.read(), null);
  await chmod(snapshotFile, 0o600);
  const original = await readFile(snapshotFile, "utf8");
  await chmod(dirname(snapshotFile), 0o755);
  assert.equal(await store.write({ status: "complete", values: [9] }), false);
  assert.equal(await readFile(snapshotFile, "utf8"), original);
});

test("invalid configuration cannot read or write state", async () => {
  for (const invalid of [
    {}, { snapshotFile: "relative.json" }, { snapshotFile: "/" },
    { snapshotFile: "/tmp/unused.json", schemaVersion: "", validate },
    { snapshotFile: "/tmp/unused.json", schemaVersion: SCHEMA, validate: true },
    { snapshotFile: "/tmp/unused.json", schemaVersion: SCHEMA, validate, maximumBytes: Infinity },
  ]) {
    const store = createValidatedSnapshotStore(invalid);
    assert.equal(await store.read(), null);
    assert.equal(await store.write(snapshot), false);
  }
});
