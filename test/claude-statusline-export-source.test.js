import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createClaudeStatusLedgerExportCursor,
  createClaudeStatusLedgerExportSourcePlan,
  scanClaudeStatusLedgerExportSource,
  verifyClaudeStatusLedgerExportSourcePlan,
} from "../src/claude-statusline-export-source.js";
import { sanitizeClaudeStatusline } from "../src/claude-statusline.js";
import { writeClaudeStatusSnapshot } from "../src/claude-statusline-storage.js";
import { normalizeClaudeStatusQuotaSnapshots } from "../src/export-safe-records.js";
import { createExportResourceGuard, ExportResourceLimitError } from "../src/export-resource-policy.js";

const SECRET = Buffer.alloc(32, 61);
const SESSION_SECRET = Buffer.alloc(32, 62);
const CANARY = "PRIVATE_CLAUDE_LEDGER_CANARY_account@example.com_/secret/project";
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

function rawInput(usedPercent = 23.55) {
  return {
    version: "2.1.176",
    model: { id: "claude-opus-4-20260701", display_name: CANARY },
    session_id: "private-session",
    cwd: `/private/${CANARY}`,
    prompt: CANARY,
    account_id: CANARY,
    rate_limits: {
      five_hour: { used_percentage: usedPercent, resets_at: 1_774_608_000 },
      seven_day: { used_percentage: 41.2, resets_at: 1_775_212_800 },
    },
  };
}

function snapshot(capturedAt, usedPercent = 23.55) {
  return sanitizeClaudeStatusline(rawInput(usedPercent), capturedAt, { sessionSecret: SESSION_SECRET });
}

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "claude-export-source-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  return { root, stateDirectory: resolve(root, "state") };
}

async function withFixture(fn) {
  const value = await fixture();
  try {
    return await fn(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

async function writeSnapshot(stateDirectory, capturedAt, uuid, usedPercent = 23.55) {
  return writeClaudeStatusSnapshot(snapshot(capturedAt, usedPercent), { stateDirectory, uuid });
}

async function planFor(stateDirectory, options = {}) {
  return createClaudeStatusLedgerExportSourcePlan({
    stateDirectory,
    startAt: START_AT,
    endAt: END_AT,
    secret: SECRET,
    ...options,
  });
}

test("freezes an inclusive interval-bound sorted inventory and emits only safe records", async () => withFixture(async ({ stateDirectory }) => {
  await writeSnapshot(stateDirectory, "2026-07-24T11:59:59.999Z", "00000000-0000-4000-8000-000000000001", 1);
  await writeSnapshot(stateDirectory, START_AT, "00000000-0000-4000-8000-000000000002", 2);
  await writeSnapshot(stateDirectory, END_AT, "00000000-0000-4000-8000-000000000003", 3);
  await writeSnapshot(stateDirectory, "2026-07-24T13:00:00.001Z", "00000000-0000-4000-8000-000000000004", 4);

  const planGuard = createExportResourceGuard();
  const plan = await planFor(stateDirectory, { resourceGuard: planGuard });
  assert.equal(plan.startAt, START_AT);
  assert.equal(plan.endAt, END_AT);
  assert.equal(plan.recordCount, 2);
  assert.deepEqual(plan.records.map((record) => record.name), [...plan.records.map((record) => record.name)].sort());
  assert.equal(plan.totalBytes, plan.records.reduce((sum, record) => sum + record.size, 0));
  assert.match(plan.inventorySha256, /^[a-f0-9]{64}$/);
  assert.match(plan.sourceKey, /^claude-ledger-source:v1:[A-Za-z0-9_-]{43}$/);
  const planCounters = planGuard.snapshot().counters;
  assert.equal(planCounters.directoryEntries, 4);
  assert.equal(planCounters.sourceFiles, 2);
  assert.equal(planCounters.sourceBytes, plan.totalBytes);

  const verified = await verifyClaudeStatusLedgerExportSourcePlan(plan, { secret: SECRET });
  assert.deepEqual(verified, {
    schemaVersion: "claude-status-ledger-export-source-plan-v0.1",
    sourceKey: plan.sourceKey,
    sourceFiles: 2,
    sourceBytes: plan.totalBytes,
  });
  const scanGuard = createExportResourceGuard();
  const batch = await scanClaudeStatusLedgerExportSource(plan, { secret: SECRET, resourceGuard: scanGuard });
  assert.equal(batch.complete, true);
  assert.deepEqual(batch.records.map(({ snapshot: value }) => value.capturedAt), [START_AT, END_AT]);
  assert.ok(batch.records.every(({ physicalOccurrenceMaterial }) =>
    /^claude-ledger-occurrence:v1:[A-Za-z0-9_-]{43}$/.test(physicalOccurrenceMaterial)));
  const serialized = JSON.stringify(batch);
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(serialized.includes("private-session"), false);
  assert.equal(serialized.includes(stateDirectory), false);
  assert.ok(plan.records.every((record) => !serialized.includes(record.name)));
  const scanCounters = scanGuard.snapshot().counters;
  assert.equal(scanCounters.sourceFiles, 2);
  assert.equal(scanCounters.sourceBytes, plan.totalBytes);
  assert.equal(scanCounters.lines, 2);
  assert.equal(scanCounters.outputRecords, 2);
  assert.equal(
    scanCounters.expandedRecordBytes,
    batch.records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), "utf8"), 0),
  );
}));

test("batch-one cursor resumes exactly and ignores records inserted after the freeze", async () => withFixture(async ({ stateDirectory }) => {
  await writeSnapshot(stateDirectory, "2026-07-24T12:01:00.000Z", "10000000-0000-4000-8000-000000000001", 10);
  await writeSnapshot(stateDirectory, "2026-07-24T12:02:00.000Z", "10000000-0000-4000-8000-000000000002", 20);
  const plan = await planFor(stateDirectory);
  const initial = createClaudeStatusLedgerExportCursor(plan, { secret: SECRET });
  assert.deepEqual(initial, {
    schemaVersion: "claude-status-ledger-export-cursor-v0.1",
    sourceKey: plan.sourceKey,
    nextRecordIndex: 0,
  });
  const first = await scanClaudeStatusLedgerExportSource(plan, {
    secret: SECRET,
    cursor: initial,
    maximumRecords: 1,
  });
  assert.equal(first.complete, false);
  assert.equal(first.cursor.nextRecordIndex, 1);

  await writeSnapshot(stateDirectory, "2026-07-24T12:01:30.000Z", "10000000-0000-4000-8000-000000000003", 15);
  const second = await scanClaudeStatusLedgerExportSource(plan, {
    secret: SECRET,
    cursor: first.cursor,
    maximumRecords: 1,
  });
  assert.equal(second.complete, true);
  assert.equal(second.cursor.nextRecordIndex, 2);
  assert.deepEqual(
    [...first.records, ...second.records].map(({ snapshot: value }) => value.limits.fiveHour.usedPercent),
    [10, 20],
  );

  await assert.rejects(
    scanClaudeStatusLedgerExportSource(plan, {
      secret: SECRET,
      cursor: { ...first.cursor, unexpected: true },
    }),
    (error) => error.code === "claude_status_ledger_export_cursor_invalid",
  );
}));

test("byte-identical physical records receive distinct occurrence and snapshot identities", async () => withFixture(async ({ stateDirectory }) => {
  const identical = snapshot("2026-07-24T12:10:00.000Z", 33);
  await writeClaudeStatusSnapshot(identical, {
    stateDirectory,
    uuid: "20000000-0000-4000-8000-000000000001",
  });
  await writeClaudeStatusSnapshot(identical, {
    stateDirectory,
    uuid: "20000000-0000-4000-8000-000000000002",
  });
  const plan = await planFor(stateDirectory);
  assert.equal(plan.records[0].sha256, plan.records[1].sha256);
  const batch = await scanClaudeStatusLedgerExportSource(plan, { secret: SECRET, maximumRecords: 2 });
  assert.deepEqual(batch.records[0].snapshot, batch.records[1].snapshot);
  assert.notEqual(batch.records[0].physicalOccurrenceMaterial, batch.records[1].physicalOccurrenceMaterial);
  const first = normalizeClaudeStatusQuotaSnapshots(SECRET, batch.records[0].snapshot, batch.records[0]);
  const second = normalizeClaudeStatusQuotaSnapshots(SECRET, batch.records[1].snapshot, batch.records[1]);
  assert.notEqual(first[0].snapshotId, second[0].snapshotId);
  const normalized = JSON.stringify(first);
  assert.equal(normalized.includes("physicalOccurrenceMaterial"), false);
  assert.equal(normalized.includes("claude-ledger-occurrence"), false);
  assert.equal(normalized.includes(plan.sourceKey), false);
  assert.equal(normalized.includes(stateDirectory), false);
  assert.ok(plan.records.every((record) => !normalized.includes(record.name)));
}));

for (const mutation of ["delete", "replace", "hardlink", "mode", "digest"]) {
  test(`frozen record ${mutation} mutation fails closed`, async () => withFixture(async ({ root, stateDirectory }) => {
    const result = await writeSnapshot(
      stateDirectory,
      "2026-07-24T12:20:00.000Z",
      "30000000-0000-4000-8000-000000000001",
      23.55,
    );
    const plan = await planFor(stateDirectory);
    if (mutation === "delete") await unlink(result.recordFile);
    if (mutation === "replace") {
      const bytes = await readFile(result.recordFile);
      await unlink(result.recordFile);
      await writeFile(result.recordFile, bytes, { mode: 0o600 });
    }
    if (mutation === "hardlink") await link(result.recordFile, join(root, "extra-link"));
    if (mutation === "mode") await chmod(result.recordFile, 0o644);
    if (mutation === "digest") {
      const text = await readFile(result.recordFile, "utf8");
      await writeFile(result.recordFile, text.replace("23.55", "24.55"), { mode: 0o600 });
    }
    await assert.rejects(
      scanClaudeStatusLedgerExportSource(plan, { secret: SECRET }),
      (error) => [
        "claude_status_ledger_export_record_changed",
        "claude_status_ledger_export_record_invalid",
      ].includes(error.code) && !error.message.includes(CANARY),
    );
  }));
}

test("directory replacement and an after-read rewrite fail closed", async () => {
  await withFixture(async ({ stateDirectory }) => {
    await writeSnapshot(stateDirectory, "2026-07-24T12:30:00.000Z", "40000000-0000-4000-8000-000000000001", 30);
    const plan = await planFor(stateDirectory);
    const displaced = join(stateDirectory, "records-displaced");
    await rename(join(stateDirectory, "records"), displaced);
    await mkdir(join(stateDirectory, "records"), { mode: 0o700 });
    await assert.rejects(
      scanClaudeStatusLedgerExportSource(plan, { secret: SECRET }),
      (error) => error.code === "claude_status_ledger_export_directory_changed",
    );
  });
  await withFixture(async ({ stateDirectory }) => {
    const result = await writeSnapshot(stateDirectory, "2026-07-24T12:31:00.000Z", "40000000-0000-4000-8000-000000000002", 31);
    const plan = await planFor(stateDirectory);
    let mutated = false;
    await assert.rejects(
      scanClaudeStatusLedgerExportSource(plan, {
        secret: SECRET,
        async failpoint(point) {
          if (point !== "after_record_read" || mutated) return;
          mutated = true;
          const text = await readFile(result.recordFile, "utf8");
          await writeFile(result.recordFile, text.replace("31", "32"), { mode: 0o600 });
        },
      }),
      (error) => error.code === "claude_status_ledger_export_record_changed",
    );
  });
});

test("planning rejects torn, non-canonical, and bounded-overflow ledgers", async () => {
  await withFixture(async ({ stateDirectory }) => {
    const result = await writeSnapshot(stateDirectory, "2026-07-24T12:40:00.000Z", "50000000-0000-4000-8000-000000000001", 40);
    const parsed = JSON.parse(await readFile(result.recordFile, "utf8"));
    await writeFile(result.recordFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(planFor(stateDirectory), (error) => error.code === "claude_status_ledger_export_record_invalid");
  });
  await withFixture(async ({ stateDirectory }) => {
    const result = await writeSnapshot(stateDirectory, "2026-07-24T12:40:30.000Z", "50000000-0000-4000-8000-000000000004", 40);
    const canonical = await readFile(result.recordFile, "utf8");
    await writeFile(result.recordFile, canonical.trimEnd(), { mode: 0o600 });
    await assert.rejects(planFor(stateDirectory), (error) => error.code === "claude_status_ledger_export_record_invalid");
  });
  await withFixture(async ({ stateDirectory }) => {
    await writeSnapshot(stateDirectory, "2026-07-24T12:41:00.000Z", "50000000-0000-4000-8000-000000000002", 41);
    await writeSnapshot(stateDirectory, "2026-07-24T12:42:00.000Z", "50000000-0000-4000-8000-000000000003", 42);
    await assert.rejects(planFor(stateDirectory, { maximumRecords: 1 }),
      (error) => error.code === "claude_status_ledger_export_ledger_bound");
    await assert.rejects(planFor(stateDirectory, {
      resourceGuard: createExportResourceGuard({ limits: { maximumSourceFiles: 1 } }),
    }), (error) => error instanceof ExportResourceLimitError && error.code === "export_resource_source_files");
  });
  await withFixture(async ({ stateDirectory }) => {
    for (let index = 0; index < 8; index += 1) {
      await writeSnapshot(
        stateDirectory,
        `2026-07-24T12:43:${String(index).padStart(2, "0")}.000Z`,
        `70000000-0000-4000-8000-00000000000${index}`,
        43,
      );
    }
    await assert.rejects(
      planFor(stateDirectory, { maximumLedgerBytes: 4096 }),
      (error) => error.code === "claude_status_ledger_export_ledger_bound",
    );
  });
});

test("interval and keyed-plan tampering fail closed with content-free errors", async () => withFixture(async ({ stateDirectory }) => {
  await writeSnapshot(stateDirectory, "2026-07-24T12:50:00.000Z", "60000000-0000-4000-8000-000000000001", 50);
  const plan = await planFor(stateDirectory);
  await assert.rejects(
    verifyClaudeStatusLedgerExportSourcePlan({ ...plan, startAt: "2026-07-24T12:00:01.000Z" }, { secret: SECRET }),
    (error) => error.code === "claude_status_ledger_export_plan_invalid" && !error.message.includes(stateDirectory),
  );
  await assert.rejects(
    verifyClaudeStatusLedgerExportSourcePlan(plan, { secret: Buffer.alloc(32, 1) }),
    (error) => error.code === "claude_status_ledger_export_plan_invalid",
  );
  await assert.rejects(
    planFor(stateDirectory, { startAt: "not-a-time" }),
    (error) => error.code === "claude_status_ledger_export_plan_invalid",
  );
}));
