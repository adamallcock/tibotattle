import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localContributionSyncQueue } from
  "../src/local-node-runtime.js";
import {
  ContributionDeviceSyncError,
} from "../src/contribution-device-sync.js";
import {
  buildTelemetryContributionsFromBundle,
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "../src/telemetry-contribution-builder.js";
import {
  PREPARED_CONTRIBUTION_SET_VERSION,
  loadVerifiedPreparedContribution,
  preparedContributionSetId,
  publishPreparedContributionFile,
  publishPreparedContributionManifest,
} from "../src/telemetry-prepared-set.js";
import {
  createTelemetryEnvelope,
} from "../src/platform/telemetry-envelope.js";
import { stableJson } from "../src/storage.js";
import {
  MAX_TELEMETRY_BROWSER_BYTES,
  parseTelemetryEnvelope,
} from "@app-usagemonitor/telemetry-contract";

const {
  conservativeUploadReservationBytes,
  discoverCommittedPreparedSets,
  inspectExactNextContributionSyncUpload,
  inspectContributionSyncQueue,
  inspectNextContributionSyncUpload,
  RETRY_BACKOFF_POLICY,
  retireAcceptedContributionArtifacts,
  retireSupersededPendingContributionArtifacts,
  runContributionSyncQueueOnce,
  runContributionSyncQueueWatch,
  setContributionSyncPaused,
} = localContributionSyncQueue;

const ORIGIN = "https://usage.example";
const ACCEPTED_ID =
  "contribution:11111111-1111-4111-8111-111111111111";

test("retry backoff policy is a named immutable contract", () => {
  assert.equal(Object.isFrozen(RETRY_BACKOFF_POLICY), true);
  assert.deepEqual(RETRY_BACKOFF_POLICY, {
    initialDelayMilliseconds: 5_000,
    maximumDelayMilliseconds: 3_600_000,
    minimumDelayMilliseconds: 1_000,
    jitterMinimumMultiplier: 0.75,
    jitterMaximumMultiplier: 1.25,
  });
});

function usage(index = 1) {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-26T10:05:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 100 + index,
      inputCacheReadTokens: 200,
      inputCacheWriteTokens: 0,
      outputTextTokens: 5,
      outputReasoningTokens: 2,
    },
    totalInputContextTokens: 300 + index,
    surface: "extension_or_ide",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0,
      fileSearch: 0,
      codeInterpreter: 0,
      hostedShell: 0,
      computerUse: 0,
      mcp: 0,
      applyPatch: 0,
      localShell: 0,
      subagent: 0,
      toolGateway: 0,
      other: 0,
      unknown: 0,
    },
    outcome: "unknown",
    eventId: `event:v2:${String(index).padStart(64, "a")}`,
    sessionScopeId: `session:v1:${"b".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function sourceBundle(index = 1, usageCount = 1) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    createdAt: "2026-07-26T10:10:00.000Z",
    coveredAt: {
      startAt: "2026-07-26T10:00:00.000Z",
      endAt: "2026-07-26T10:10:00.000Z",
    },
    clientPlatform: "macos",
    records: {
      usageEvents: Array.from(
        { length: usageCount },
        (_, offset) => usage(index + offset),
      ),
      quotaSnapshots: [],
      activityMarkers: [],
    },
  };
}

async function createPreparedSet(parent, {
  setName = null,
  index = 1,
  usageCount = 1,
} = {}) {
  const directory = setName === null ? parent : join(parent, setName);
  if (setName !== null) await mkdir(directory, { mode: 0o700 });
  const [contribution] =
    buildTelemetryContributionsFromBundle(sourceBundle(index, usageCount));
  const content = stableJson(contribution);
  const published = await publishPreparedContributionFile({
    directory,
    name: "telemetry-contribution-000001.json",
    content,
  });
  const manifest = {
    schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    eligibleSchemaVersion: "telemetry-contribution-v0.1",
    batchCount: 1,
    files: [{
      basename: published.basename,
      sha256: published.sha256,
      bytes: published.bytes,
      recordCounts: {
        usageEvents: usageCount,
        quotaSnapshots: 0,
        activityMarkers: 0,
      },
    }],
  };
  await publishPreparedContributionManifest({
    directory,
    manifest,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  return { directory, manifest };
}

async function createReviewForPreparedSet(reviewRoot, setName) {
  const suffix = setName.slice("prepared-set-".length);
  const directory = join(reviewRoot, `review-${suffix}`);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "review.umx.json"), "{}\n", {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "review.umx.json.privacy-receipt.json"),
    "{}\n",
    { mode: 0o600 },
  );
  return directory;
}

async function fixture({ spool = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-sync-queue-"));
  const preparedRoot = join(root, "prepared");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const setName = spool ? `prepared-set-${randomUUID()}` : null;
  const prepared = await createPreparedSet(preparedRoot, { setName });
  return {
    root,
    preparedRoot,
    prepared,
    queueFile: join(privateRoot, "sync.sqlite3"),
  };
}

function acceptedReceipt() {
  return {
    basename: "telemetry-contribution-000001.json",
    contributionId: ACCEPTED_ID,
    status: "accepted",
  };
}

test("upload reservations conservatively bound prepared bytes", () => {
  assert.equal(conservativeUploadReservationBytes(0), 8192);
  assert.equal(conservativeUploadReservationBytes(4096), 16_384);
  assert.throws(
    () => conservativeUploadReservationBytes(-1),
    (error) => error.code
      === "contribution_sync_queue_configuration_invalid",
  );
});

test("upload reservation exceeds a real maximum-record encrypted envelope", async () => {
  const [payload] =
    buildTelemetryContributionsFromBundle(sourceBundle(1, 200));
  const preparedBytes = Buffer.byteLength(stableJson(payload), "utf8");
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk: publicKey.export({ format: "jwk" }),
    keyId: `key:${"a".repeat(64)}`,
  });
  assert.equal(parseTelemetryEnvelope(envelope), envelope);
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify(envelope),
    "utf8",
  );
  assert.ok(envelopeBytes < conservativeUploadReservationBytes(preparedBytes));
});

test("inspect-next verifies and projects one queued payload without identifiers", async () => {
  const value = await fixture();
  let nowMilliseconds = Date.parse("2026-07-26T12:00:00.000Z");
  const result = await inspectNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    // Real clocks advance while discovery and verification run. A newly
    // enqueued job must still be immediately ready rather than appearing to
    // wait for its own insertion timestamp.
    now: () => new Date(nowMilliseconds++),
  });
  assert.equal(result.schemaVersion, "contribution-sync-preview-v0.1");
  assert.equal(result.state, "ready");
  assert.equal(result.networkActivity, false);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.item.recordCounts, {
    usageEvents: 1,
    quotaSnapshots: 0,
    activityMarkers: 0,
    total: 1,
  });
  assert.equal(result.item.clientPlatform, "macos");
  assert.equal(
    result.item.accounting.verification,
    "client_declared_unverified",
  );
  assert.equal(
    result.item.reservedUploadBytes,
    conservativeUploadReservationBytes(result.item.preparedBytes),
  );
  assert.equal(result.queue.counts.pending, 1);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    value.root,
    "telemetry-contribution-000001.json",
    "event:v2:",
    "session:v1:",
    "usage.example",
    "contribution:",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("exact inspection returns the verified next telemetry payload without queue identifiers", async () => {
  const value = await fixture();
  const verifiedPayloads = [];
  const result = await inspectExactNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    loadContribution: async (options) => {
      const payload = await loadVerifiedPreparedContribution(options);
      verifiedPayloads.push(payload);
      return payload;
    },
  });

  assert.equal(result.schemaVersion, "contribution-sync-exact-review-v0.1");
  assert.equal(result.state, "ready");
  assert.equal(result.networkActivity, false);
  assert.equal(verifiedPayloads.length, 2);
  assert.equal(
    result.payloadBytes,
    value.prepared.manifest.files[0].bytes,
  );
  assert.ok(result.payloadBytes <= MAX_TELEMETRY_BROWSER_BYTES);
  assert.deepEqual(result.payload, verifiedPayloads.at(-1));
  assert.deepEqual(result.recordCounts, {
    usageEvents: 1,
    quotaSnapshots: 0,
    activityMarkers: 0,
    total: 1,
  });
  assert.match(
    result.reviewBinding.jobId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(
    result.reviewBinding.contributionSha256,
    value.prepared.manifest.files[0].sha256,
  );

  const outer = JSON.stringify({ ...result, payload: null });
  for (const privateValue of [
    value.root,
    "telemetry-contribution-000001.json",
    "event:v2:",
    "session:v1:",
    "contribution:",
    "usage.example",
  ]) {
    assert.equal(outer.includes(privateValue), false);
  }

  const aggregate = await inspectNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const aggregateSerialized = JSON.stringify(aggregate);
  assert.equal(aggregate.item.coveredAt.startAt, result.payload.coveredAt.startAt);
  assert.equal(aggregate.item.coveredAt.endAt, result.payload.coveredAt.endAt);
  for (const privateValue of [
    value.root,
    "telemetry-contribution-000001.json",
    "event:v2:",
    "session:v1:",
    "contribution:",
    "usage.example",
  ]) {
    assert.equal(aggregateSerialized.includes(privateValue), false);
  }
});

test("review-bound foreground send processes exactly the inspected job", async () => {
  const value = await fixture({ spool: true });
  await createPreparedSet(value.preparedRoot, {
    setName: `prepared-set-${randomUUID()}`,
    index: 2,
  });
  const review = await inspectExactNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const calls = [];
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:01:00.000Z"),
    reviewedJob: review.reviewBinding,
    maximumJobs: 10,
    syncEntry: async (options) => {
      calls.push(options);
      return acceptedReceipt();
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(result.accepted, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].entry.sha256,
    review.reviewBinding.contributionSha256,
  );
  assert.equal(result.queue.counts.accepted, 1);
  assert.equal(result.queue.counts.pending, 1);
});

test("prepared-set-bound automatic send cannot process older queued sets", async () => {
  const value = await fixture({ spool: true });
  const newer = await createPreparedSet(value.preparedRoot, {
    setName: `prepared-set-${randomUUID()}`,
    index: 2,
  });
  const aborted = new AbortController();
  aborted.abort();
  const seeded = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    signal: aborted.signal,
  });
  assert.equal(seeded.status, "interrupted");
  assert.equal(seeded.queue.counts.pending, 2);

  const selectedId = preparedContributionSetId(newer.manifest);
  const calls = [];
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    preparedSetId: selectedId,
    maximumJobs: 10,
    syncEntry: async (options) => {
      calls.push(options);
      return acceptedReceipt();
    },
  });
  assert.equal(result.discoveredSets, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.queue.counts.accepted, 1);
  assert.equal(result.queue.counts.pending, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.sha256, newer.manifest.files[0].sha256);
});

test("prepared-set-bound automatic retry returns only its selected checkpoint", async () => {
  const value = await fixture({ spool: true });
  const selected = await createPreparedSet(value.preparedRoot, {
    setName: `prepared-set-${randomUUID()}`,
    index: 2,
  });
  const olderId = preparedContributionSetId(value.prepared.manifest);
  const selectedId = preparedContributionSetId(selected.manifest);
  const older = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    preparedSetId: olderId,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    random: () => 0,
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: 60_000,
      });
    },
  });
  assert.equal(older.retryNotBeforeAt, "2026-07-26T12:01:00.000Z");

  const selectedResult = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    preparedSetId: selectedId,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    random: () => 0,
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: 120_000,
      });
    },
  });
  assert.equal(selectedResult.queue.nextAttemptAt, "2026-07-26T12:01:00.000Z");
  assert.equal(selectedResult.retryNotBeforeAt, "2026-07-26T12:02:00.000Z");
});

test("inspect-next rejects arbitrary text in projected classification fields", async () => {
  const value = await fixture();
  await assert.rejects(
    inspectNextContributionSyncUpload({
      directory: value.preparedRoot,
      queueFile: value.queueFile,
      loadContribution: async () => ({
        schemaVersion: "telemetry-contribution-v0.1",
        clientPlatform: "/private/content-canary",
        providerPolicyEpoch: "unknown",
        coveredAt: {
          startAt: "2026-07-26T10:00:00.000Z",
          endAt: "2026-07-26T10:10:00.000Z",
        },
        usageEvents: [],
        quotaSnapshots: [{}],
        activityMarkers: [],
        accounting: {
          estimatedApiCostUsd: null,
          pricedEventCoveragePercent: 0,
          unknownModelEventCount: 0,
          unknownBillableUnits: 0,
          priceBasis: "unpriced",
        },
      }),
    }),
    (error) => error.code === "contribution_sync_queue_queue_invalid",
  );
});

test("queue persists one path-free job and deduplicates subsequent scans", async () => {
  const value = await fixture();
  const calls = [];
  const first = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    syncEntry: async (options) => {
      calls.push(options);
      return acceptedReceipt();
    },
  });
  assert.equal(first.status, "completed");
  assert.equal(first.enqueued, 1);
  assert.equal(first.accepted, 1);
  assert.equal(first.queue.counts.accepted, 1);
  assert.equal(calls.length, 1);

  const second = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:01:00.000Z"),
    maximumQueuedJobs: 1,
    syncEntry: async () => {
      throw new Error("accepted rows must not be replayed");
    },
  });
  assert.equal(second.enqueued, 0);
  assert.equal(second.processed, 0);
  assert.equal(second.queue.counts.accepted, 1);

  const stats = await lstat(value.queueFile);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.nlink, 1);
  if (process.platform !== "win32") {
    assert.equal(stats.mode & 0o077, 0);
  }
  const database = new DatabaseSync(value.queueFile, { readOnly: true });
  const columns = database.prepare(
    "PRAGMA table_info(contribution_jobs)",
  ).all().map((row) => row.name);
  const row = database.prepare(`
    SELECT set_name, contribution_basename, contribution_sha256,
           contribution_bytes, schema_version, covered_start_at,
           covered_end_at, state, attempt_count, last_error_code,
           contribution_id
      FROM contribution_jobs
  `).get();
  database.close();
  assert.equal(columns.some((name) => (
    /path|directory|origin|secret|account|session/u.test(name)
  )), false);
  assert.equal(row.set_name, ".");
  assert.equal(row.state, "accepted");
  assert.equal(row.attempt_count, 1);
  assert.equal(row.contribution_id, ACCEPTED_ID);
  const raw = await readFile(value.queueFile);
  for (const forbidden of [
    value.root,
    "usage.example",
    "um_device_",
    "accountScopeId",
    "sessionScopeId",
  ]) {
    assert.equal(raw.includes(Buffer.from(forbidden)), false);
  }
});

test("spool discovery queues only fixed prepared-set child names", async () => {
  const value = await fixture({ spool: true });
  await writeFile(join(value.preparedRoot, "loose.json"), "{\"raw\":true}\n", {
    mode: 0o600,
  });
  await mkdir(join(value.preparedRoot, "arbitrary-directory"), { mode: 0o700 });
  const sets = await discoverCommittedPreparedSets({
    directory: value.preparedRoot,
  });
  assert.equal(sets.length, 1);
  assert.match(sets[0].setName, /^prepared-set-/u);
  let clock = Date.parse("2026-07-26T12:00:00.000Z");
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date(clock++),
    syncEntry: async () => acceptedReceipt(),
  });
  assert.equal(result.discoveredSets, 1);
  assert.equal(result.accepted, 1);
});

test("retryable failures use bounded backoff and later produce one accepted row", async () => {
  const value = await fixture();
  let clock = Date.parse("2026-07-26T12:00:00.000Z");
  let calls = 0;
  const syncEntry = async () => {
    calls += 1;
    if (calls === 1) {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
      });
    }
    return acceptedReceipt();
  };
  const first = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date(clock),
    random: () => 0.5,
    syncEntry,
  });
  assert.equal(first.retryable, 1);
  assert.equal(first.queue.counts.retryable, 1);
  assert.equal(
    first.queue.nextAttemptAt,
    "2026-07-26T12:00:05.000Z",
  );

  clock += 4000;
  const tooSoon = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date(clock),
    random: () => 0.5,
    syncEntry,
  });
  assert.equal(tooSoon.processed, 0);
  clock += 1000;
  const retried = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date(clock),
    random: () => 0.5,
    syncEntry,
  });
  assert.equal(retried.accepted, 1);
  assert.equal(retried.queue.counts.accepted, 1);
  assert.equal(calls, 2);

  const database = new DatabaseSync(value.queueFile, { readOnly: true });
  const row = database.prepare(
    "SELECT state, attempt_count, contribution_id FROM contribution_jobs",
  ).get();
  database.close();
  assert.deepEqual({ ...row }, {
    state: "accepted",
    attempt_count: 2,
    contribution_id: ACCEPTED_ID,
  });
});

test("retryable failures honor Retry-After before adding bounded client spread", async () => {
  const value = await fixture();
  const clock = Date.parse("2026-07-26T12:00:00.000Z");
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date(clock),
    random: () => 0.5,
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: 60_000,
      });
    },
  });
  assert.equal(result.retryable, 1);
  // 60 seconds is the service floor; the half-random client adds 7.5 seconds
  // (half of the bounded 15-second, 25% spread).
  assert.equal(result.queue.nextAttemptAt, "2026-07-26T12:01:07.500Z");
});

test("a never-prepared account previews empty instead of unavailable", async () => {
  // Fresh-account bootstrap: the prepared spool is only created by the first
  // successful preparation, and the page only runs that preparation when the
  // preview reports empty. A missing spool must therefore be the empty state,
  // never prepared_root_invalid — otherwise a brand-new account deadlocks on
  // Check again forever (found live on a fresh macOS account, 2026-08-19).
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-sync-queue-"));
  const privateRoot = join(root, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  const neverCreated = join(root, "never-created-prepared-root");
  const queueFile = join(privateRoot, "sync.sqlite3");
  try {
    const preview = await inspectNextContributionSyncUpload({
      directory: neverCreated,
      queueFile,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(preview.state, "empty");
    assert.equal(preview.discoveredSets, 0);
    assert.equal(preview.enqueued, 0);
    assert.equal(preview.item, null);
    const review = await inspectExactNextContributionSyncUpload({
      directory: neverCreated,
      queueFile,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(review.state, "empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry and pause survive a queue reopen without invalidating exact review", async () => {
  const value = await fixture();
  const now = () => new Date("2026-07-26T12:00:00.000Z");
  const failed = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now,
    random: () => 0.5,
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
      });
    },
  });
  assert.equal(failed.retryable, 1);

  // Every queue API closes its SQLite connection before returning. These
  // reads therefore model a companion/app restart against the same durable
  // Application Support state rather than an in-memory continuation.
  const retryReview = await inspectExactNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    now,
  });
  assert.equal(retryReview.state, "retry_wait");
  assert.equal(retryReview.payload?.schemaVersion, "telemetry-contribution-v0.1");
  assert.match(retryReview.reviewBinding?.jobId ?? "", /^[0-9a-f-]{36}$/u);
  assert.match(retryReview.reviewBinding?.contributionSha256 ?? "", /^[0-9a-f]{64}$/u);

  await setContributionSyncPaused({
    paused: true,
    queueFile: value.queueFile,
    now,
  });
  const pausedReview = await inspectExactNextContributionSyncUpload({
    directory: value.preparedRoot,
    queueFile: value.queueFile,
    now,
  });
  assert.equal(pausedReview.state, "paused");
  assert.deepEqual(pausedReview.payload, retryReview.payload);
  assert.deepEqual(pausedReview.reviewBinding, retryReview.reviewBinding);
});

test("an interruption cannot undercut a Retry-After floor", async () => {
  const value = await fixture();
  const abort = new AbortController();
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    random: () => 0.5,
    signal: abort.signal,
    syncEntry: async () => {
      abort.abort();
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: 60_000,
      });
    },
  });
  assert.equal(result.status, "interrupted");
  assert.equal(result.retryable, 1);
  assert.equal(result.queue.nextAttemptAt, "2026-07-26T12:01:07.500Z");
});

test("an over-horizon Retry-After pauses instead of scheduling an earlier retry", async () => {
  const value = await fixture();
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("service_unavailable", {
        retryable: true,
        retryAfterExceedsMaximum: true,
      });
    },
  });
  assert.equal(result.status, "paused");
  assert.equal(result.retryable, 1);
  assert.equal(result.queue.paused, true);
});

test("terminal validation failures are rejected without automatic replay", async () => {
  const value = await fixture();
  let calls = 0;
  const syncEntry = async () => {
    calls += 1;
    throw new ContributionDeviceSyncError("upload_rejected");
  };
  const first = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    syncEntry,
  });
  assert.equal(first.rejected, 1);
  assert.equal(first.queue.counts.rejected, 1);
  const second = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    syncEntry,
  });
  assert.equal(second.processed, 0);
  assert.equal(calls, 1);
});

test("revoked device pauses the queue while preserving a retryable job", async () => {
  const value = await fixture();
  const unavailable = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    syncEntry: async () => {
      throw new ContributionDeviceSyncError("device_unavailable", {
        deviceUnavailable: true,
      });
    },
  });
  assert.equal(unavailable.status, "paused");
  assert.equal(unavailable.queue.paused, true);
  assert.equal(unavailable.queue.counts.retryable, 1);

  await setContributionSyncPaused({
    paused: false,
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:01:00.000Z"),
  });
  const resumed = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:01:00.000Z"),
    syncEntry: async () => acceptedReceipt(),
  });
  assert.equal(resumed.accepted, 1);
  assert.equal(resumed.queue.paused, false);
});

test("expired in-flight lease is recovered after an interrupted process", async () => {
  const value = await fixture();
  await setContributionSyncPaused({
    paused: true,
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    syncEntry: async () => acceptedReceipt(),
  });
  const database = new DatabaseSync(value.queueFile);
  database.prepare(`
    UPDATE contribution_jobs
       SET state = 'in_flight',
           attempt_count = 1,
           next_attempt_at = NULL,
           lease_token = ?,
           lease_expires_at = ?
  `).run(
    randomUUID(),
    "2026-07-26T12:05:00.000Z",
  );
  database.close();

  const before = await inspectContributionSyncQueue({
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:04:59.000Z"),
  });
  assert.equal(before.counts.in_flight, 1);
  const after = await inspectContributionSyncQueue({
    queueFile: value.queueFile,
    now: () => new Date("2026-07-26T12:05:00.000Z"),
  });
  assert.equal(after.counts.in_flight, 0);
  assert.equal(after.counts.retryable, 1);
  assert.equal(after.nextAttemptAt, "2026-07-26T12:05:00.000Z");
});

test("post-enqueue file substitution fails before any sync network boundary", async () => {
  const value = await fixture();
  await setContributionSyncPaused({
    paused: true,
    queueFile: value.queueFile,
  });
  await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    syncEntry: async () => acceptedReceipt(),
  });
  await writeFile(
    join(value.preparedRoot, "telemetry-contribution-000001.json"),
    "{\"tampered\":true}\n",
    { mode: 0o600 },
  );
  await setContributionSyncPaused({
    paused: false,
    queueFile: value.queueFile,
  });
  let syncCalls = 0;
  await assert.rejects(
    runContributionSyncQueueOnce({
      directory: value.preparedRoot,
      origin: ORIGIN,
      backend: {},
      queueFile: value.queueFile,
      syncEntry: async () => {
        syncCalls += 1;
        return acceptedReceipt();
      },
    }),
    (error) => error.code === "prepared_contribution_set_file_invalid"
      || error.code === "prepared_contribution_set_file_digest",
  );
  assert.equal(syncCalls, 0);
});

test("byte cap stops before claiming the next job", async () => {
  const value = await fixture({ spool: true });
  const second = await createPreparedSet(value.preparedRoot, {
    setName: `prepared-set-${randomUUID()}`,
    index: 2,
  });
  const reservations = [
    value.prepared.manifest.files[0].bytes,
    second.manifest.files[0].bytes,
  ].map(conservativeUploadReservationBytes);
  const cap = Math.max(16 * 1024, ...reservations);
  assert.ok(reservations.every((reservation) => reservation <= cap));
  assert.ok(reservations[0] + reservations[1] > cap);
  let calls = 0;
  const result = await runContributionSyncQueueOnce({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    maximumReservedUploadBytes: cap,
    syncEntry: async () => {
      calls += 1;
      return acceptedReceipt();
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.bandwidthLimited, true);
  assert.equal(result.reservedUploadBytes <= cap, true);
  assert.equal(calls, 1);
  assert.equal(result.queue.counts.pending, 1);

  const database = new DatabaseSync(value.queueFile, { readOnly: true });
  const attempts = database.prepare(`
    SELECT attempt_count FROM contribution_jobs ORDER BY attempt_count
  `).all().map((row) => row.attempt_count);
  database.close();
  assert.deepEqual(attempts, [0, 1]);
});

test("oversized first job remains pending and unattempted", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-sync-large-"));
  const preparedRoot = join(root, "prepared");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const prepared = await createPreparedSet(preparedRoot, {
    usageCount: 200,
  });
  assert.ok(
    conservativeUploadReservationBytes(prepared.manifest.files[0].bytes)
      > 16 * 1024,
  );
  let calls = 0;
  const queueFile = join(privateRoot, "sync.sqlite3");
  const result = await runContributionSyncQueueOnce({
    directory: preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile,
    maximumReservedUploadBytes: 16 * 1024,
    syncEntry: async () => {
      calls += 1;
      return acceptedReceipt();
    },
  });
  assert.equal(result.processed, 0);
  assert.equal(result.reservedUploadBytes, 0);
  assert.equal(result.bandwidthLimited, true);
  assert.equal(result.queue.counts.pending, 1);
  assert.equal(calls, 0);
  const database = new DatabaseSync(queueFile, { readOnly: true });
  const job = database.prepare(`
    SELECT state, attempt_count FROM contribution_jobs
  `).get();
  database.close();
  assert.deepEqual({ ...job }, { state: "pending", attempt_count: 0 });
});

test("accepted artifact retirement is crash-resumable and preserves protected first-review evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-retirement-"));
  const preparedRoot = join(root, "prepared");
  const reviewRoot = join(root, "reviews");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(reviewRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const retiredName =
    "prepared-set-00000000-0000-4000-8000-000000000011";
  const protectedName =
    "prepared-set-00000000-0000-4000-8000-000000000012";
  const retired = await createPreparedSet(preparedRoot, {
    setName: retiredName,
    index: 11,
  });
  const protectedSet = await createPreparedSet(preparedRoot, {
    setName: protectedName,
    index: 12,
  });
  await createReviewForPreparedSet(reviewRoot, retiredName);
  await createReviewForPreparedSet(reviewRoot, protectedName);
  const retiredId = preparedContributionSetId(retired.manifest);
  const protectedId = preparedContributionSetId(protectedSet.manifest);
  const queueFile = join(privateRoot, "sync.sqlite3");
  for (const preparedSetId of [retiredId, protectedId]) {
    const result = await runContributionSyncQueueOnce({
      directory: preparedRoot,
      origin: ORIGIN,
      backend: {},
      queueFile,
      preparedSetId,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      syncEntry: async () => acceptedReceipt(),
    });
    assert.equal(result.preparedSet.completeAccepted, true);
  }

  await assert.rejects(
    retireAcceptedContributionArtifacts({
      preparedSpoolDirectory: preparedRoot,
      reviewArchiveDirectory: reviewRoot,
      queueFile,
      protectedPreparedSetIds: [protectedId],
      maximumAgeDays: 1,
      maximumRetainedSets: 1,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      failpoint: async (name, context) => {
        if (name === "after_prepared_retirement"
            && context.preparedSetId === retiredId) {
          throw new Error("simulated retirement crash");
        }
      },
    }),
    /simulated retirement crash/u,
  );
  await assert.rejects(
    lstat(join(preparedRoot, retiredName)),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(
    (await lstat(join(
      reviewRoot,
      retiredName.replace("prepared-set-", "review-"),
    ))).isDirectory(),
    true,
  );
  let database = new DatabaseSync(queueFile, { readOnly: true });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
        FROM contribution_jobs
       WHERE prepared_set_id = ? AND state = 'accepted'
    `).get(retiredId).count,
    1,
  );
  database.close();

  const completed = await retireAcceptedContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
    protectedPreparedSetIds: [protectedId],
    maximumAgeDays: 1,
    maximumRetainedSets: 1,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
  assert.equal(completed.retiredSets, 1);
  assert.equal(completed.retiredJobs, 1);
  assert.deepEqual(await readdir(preparedRoot), [protectedName]);
  assert.deepEqual(await readdir(reviewRoot), [
    protectedName.replace("prepared-set-", "review-"),
  ]);
  database = new DatabaseSync(queueFile, { readOnly: true });
  assert.deepEqual(
    database.prepare(`
      SELECT prepared_set_id, state FROM contribution_jobs
    `).all().map((row) => ({ ...row })),
    [{ prepared_set_id: protectedId, state: "accepted" }],
  );
  database.close();
});

test("retirement never deletes pending, retryable, in-flight, or rejected artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-retention-state-"));
  const preparedRoot = join(root, "prepared");
  const reviewRoot = join(root, "reviews");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(reviewRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const definitions = [
    ["accepted", "00000000-0000-4000-8000-000000000021", 21],
    ["retryable", "00000000-0000-4000-8000-000000000022", 22],
    ["rejected", "00000000-0000-4000-8000-000000000023", 23],
    ["pending", "00000000-0000-4000-8000-000000000024", 24],
    ["in_flight", "00000000-0000-4000-8000-000000000025", 25],
  ];
  const preparedSets = [];
  for (const [state, uuid, index] of definitions) {
    const setName = `prepared-set-${uuid}`;
    const prepared = await createPreparedSet(preparedRoot, {
      setName,
      index,
    });
    await createReviewForPreparedSet(reviewRoot, setName);
    preparedSets.push({
      state,
      setName,
      preparedSetId: preparedContributionSetId(prepared.manifest),
    });
  }
  const queueFile = join(privateRoot, "sync.sqlite3");
  for (const set of preparedSets) {
    const controller = new AbortController();
    if (set.state === "pending" || set.state === "in_flight") {
      controller.abort();
    }
    await runContributionSyncQueueOnce({
      directory: preparedRoot,
      origin: ORIGIN,
      backend: {},
      queueFile,
      preparedSetId: set.preparedSetId,
      signal: controller.signal,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      syncEntry: async () => {
        if (set.state === "accepted") return acceptedReceipt();
        const error = new Error(`${set.state} test`);
        if (set.state === "retryable") error.retryable = true;
        throw error;
      },
    });
  }
  let database = new DatabaseSync(queueFile);
  database.prepare(`
    UPDATE contribution_jobs
       SET state = 'in_flight'
     WHERE prepared_set_id = ?
  `).run(
    preparedSets.find((set) => set.state === "in_flight").preparedSetId,
  );
  database.close();
  const result = await retireAcceptedContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
    maximumAgeDays: 1,
    maximumRetainedSets: 1,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
  assert.equal(result.retiredSets, 1);
  const retainedNames = preparedSets
    .filter((set) => set.state !== "accepted")
    .map((set) => set.setName)
    .sort();
  assert.deepEqual((await readdir(preparedRoot)).sort(), retainedNames);
  assert.deepEqual((await readdir(reviewRoot)).sort(), retainedNames.map(
    (name) => name.replace("prepared-set-", "review-"),
  ));
  database = new DatabaseSync(queueFile, { readOnly: true });
  assert.deepEqual(
    database.prepare(`
      SELECT state FROM contribution_jobs ORDER BY state
    `).all().map((row) => row.state),
    ["in_flight", "pending", "rejected", "retryable"],
  );
  database.close();
});

test("bounded retirement eventually compacts accepted sets beyond one query window", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-retention-window-"));
  const preparedRoot = join(root, "prepared");
  const reviewRoot = join(root, "reviews");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(reviewRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const queueFile = join(privateRoot, "sync.sqlite3");
  await inspectContributionSyncQueue({
    queueFile,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
  const database = new DatabaseSync(queueFile);
  const insert = database.prepare(`
    INSERT INTO contribution_jobs (
      job_id, prepared_set_id, set_name, contribution_basename,
      contribution_sha256, contribution_bytes, schema_version,
      covered_start_at, covered_end_at, state, attempt_count,
      next_attempt_at, last_error_code, contribution_id,
      lease_token, lease_expires_at, created_at, updated_at, accepted_at
    ) VALUES (
      ?, ?, ?, 'telemetry-contribution-000001.json',
      ?, 3, 'telemetry-contribution-v0.1',
      '2026-07-29T10:00:00.000Z', '2026-07-29T11:00:00.000Z',
      'accepted', 1, NULL, NULL, ?, NULL, NULL, ?, ?, ?
    )
  `);
  for (let index = 1; index <= 30; index += 1) {
    const suffix = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const setName = `prepared-set-${suffix}`;
    const preparedDirectory = join(preparedRoot, setName);
    await mkdir(preparedDirectory, { mode: 0o700 });
    await writeFile(join(preparedDirectory, "manifest.json"), "{}\n", {
      mode: 0o600,
    });
    await createReviewForPreparedSet(reviewRoot, setName);
    const preparedSetId = index.toString(16).padStart(64, "0");
    const timestamp = new Date(
      Date.parse("2026-07-29T11:00:00.000Z") + index,
    ).toISOString();
    insert.run(
      randomUUID(),
      preparedSetId,
      setName,
      "f".repeat(64),
      ACCEPTED_ID,
      timestamp,
      timestamp,
      timestamp,
    );
  }
  database.close();

  let retiredSets = 0;
  let passes = 0;
  while (passes < 20) {
    const result = await retireAcceptedContributionArtifacts({
      preparedSpoolDirectory: preparedRoot,
      reviewArchiveDirectory: reviewRoot,
      queueFile,
      maximumAgeDays: 30,
      maximumRetainedSets: 1,
      maximumRetirements: 2,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    assert.ok(result.retiredSets <= 2);
    retiredSets += result.retiredSets;
    passes += 1;
    if (result.retiredSets === 0) break;
  }
  assert.equal(retiredSets, 29);
  assert.equal(passes, 16);
  assert.equal((await readdir(preparedRoot)).length, 1);
  assert.equal((await readdir(reviewRoot)).length, 1);
  const finalDatabase = new DatabaseSync(queueFile, { readOnly: true });
  assert.equal(
    finalDatabase.prepare(`
      SELECT COUNT(*) AS count FROM contribution_jobs
    `).get().count,
    1,
  );
  finalDatabase.close();
});

// Superseded-pending fixture: sets are created and enqueued one at a time
// with an advancing clock, because the first-review protection is derived
// from enqueue order — every set enqueued in one preview pass would share
// one created_at.
async function supersededFixture(definitions) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-superseded-"));
  const preparedRoot = join(root, "prepared");
  const reviewRoot = join(root, "reviews");
  const privateRoot = join(root, "private");
  await mkdir(preparedRoot, { mode: 0o700 });
  await mkdir(reviewRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const queueFile = join(privateRoot, "sync.sqlite3");
  let tick = Date.parse("2026-08-06T23:00:00.000Z");
  const sets = {};
  for (const [key, uuid, index] of definitions) {
    const setName = `prepared-set-${uuid}`;
    const prepared = await createPreparedSet(preparedRoot, { setName, index });
    await createReviewForPreparedSet(reviewRoot, setName);
    const enqueuedAt = tick;
    const preview = await inspectNextContributionSyncUpload({
      directory: preparedRoot,
      queueFile,
      now: () => new Date(enqueuedAt),
    });
    assert.equal(preview.state, "ready");
    tick += 60_000;
    sets[key] = {
      setName,
      preparedSetId: preparedContributionSetId(prepared.manifest),
    };
  }
  return { root, preparedRoot, reviewRoot, queueFile, sets };
}

test("superseded pending retirement keeps the first-review provenance and is crash-resumable", async () => {
  const value = await supersededFixture([
    ["ceremony", "00000000-0000-4000-8000-000000000031", 31],
    ["strandedA", "00000000-0000-4000-8000-000000000032", 32],
    ["strandedB", "00000000-0000-4000-8000-000000000033", 33],
  ]);
  const { preparedRoot, reviewRoot, queueFile, sets } = value;

  await assert.rejects(
    retireSupersededPendingContributionArtifacts({
      preparedSpoolDirectory: preparedRoot,
      reviewArchiveDirectory: reviewRoot,
      queueFile,
      failpoint: async (name, context) => {
        if (name === "after_prepared_retirement"
            && context.preparedSetId === sets.strandedA.preparedSetId) {
          throw new Error("simulated retirement crash");
        }
      },
    }),
    /simulated retirement crash/u,
  );
  // The crash left rows whose prepared directory is gone. The preview stays
  // healthy through the window because the protected first-review job still
  // sorts first, and discovery can never re-queue the removed files.
  await assert.rejects(
    lstat(join(preparedRoot, sets.strandedA.setName)),
    (error) => error?.code === "ENOENT",
  );
  let database = new DatabaseSync(queueFile, { readOnly: true });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
        FROM contribution_jobs
       WHERE prepared_set_id = ?
    `).get(sets.strandedA.preparedSetId).count,
    1,
  );
  database.close();
  const crashedPreview = await inspectNextContributionSyncUpload({
    directory: preparedRoot,
    queueFile,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  assert.equal(crashedPreview.state, "ready");

  const resumed = await retireSupersededPendingContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
  });
  assert.equal(resumed.retiredSets, 2);
  assert.equal(resumed.retiredJobs, 2);
  assert.deepEqual(await readdir(preparedRoot), [sets.ceremony.setName]);
  assert.deepEqual(await readdir(reviewRoot), [
    sets.ceremony.setName.replace("prepared-set-", "review-"),
  ]);
  database = new DatabaseSync(queueFile, { readOnly: true });
  assert.deepEqual(
    database.prepare(`
      SELECT prepared_set_id, state FROM contribution_jobs
    `).all().map((row) => ({ ...row })),
    [{ prepared_set_id: sets.ceremony.preparedSetId, state: "pending" }],
  );
  database.close();

  // Converged installs stay converged: repeated passes retire nothing, and
  // the retained provenance still previews for a later consent ceremony.
  const idle = await retireSupersededPendingContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
  });
  assert.equal(idle.retiredSets, 0);
  assert.equal(idle.retiredJobs, 0);
  const preview = await inspectNextContributionSyncUpload({
    directory: preparedRoot,
    queueFile,
    now: () => new Date("2026-08-07T01:00:00.000Z"),
  });
  assert.equal(preview.state, "ready");
  assert.equal(preview.discoveredSets, 1);
});

test("superseded pending retirement is bounded per pass and never touches delivered or delivering sets", async () => {
  const value = await supersededFixture([
    ["oldest", "00000000-0000-4000-8000-000000000041", 41],
    ["accepted", "00000000-0000-4000-8000-000000000042", 42],
    ["inFlight", "00000000-0000-4000-8000-000000000043", 43],
    ["rejected", "00000000-0000-4000-8000-000000000044", 44],
    ["strandedA", "00000000-0000-4000-8000-000000000045", 45],
    ["strandedB", "00000000-0000-4000-8000-000000000046", 46],
    ["strandedC", "00000000-0000-4000-8000-000000000047", 47],
  ]);
  const { preparedRoot, reviewRoot, queueFile, sets } = value;
  // Delivery-state surgery, exactly like the accepted-retention test: any
  // accepted row is upload-authority evidence and any in-flight or rejected
  // row is delivery history, so those whole sets must survive every pass.
  let database = new DatabaseSync(queueFile);
  database.prepare(`
    UPDATE contribution_jobs
       SET state = 'accepted',
           accepted_at = '2026-08-06T23:30:00.000Z',
           contribution_id = ?
     WHERE prepared_set_id = ?
  `).run(ACCEPTED_ID, sets.accepted.preparedSetId);
  database.prepare(`
    UPDATE contribution_jobs SET state = 'in_flight'
     WHERE prepared_set_id = ?
  `).run(sets.inFlight.preparedSetId);
  database.prepare(`
    UPDATE contribution_jobs SET state = 'rejected'
     WHERE prepared_set_id = ?
  `).run(sets.rejected.preparedSetId);
  database.close();

  // Pass one: bounded to two retirements, with strandedA additionally under
  // the caller's protection. Only strandedB and strandedC may go.
  const first = await retireSupersededPendingContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
    protectedPreparedSetIds: [sets.strandedA.preparedSetId],
    maximumRetirements: 2,
  });
  assert.equal(first.retiredSets, 2);
  assert.equal(first.retiredJobs, 2);
  assert.equal(
    (await lstat(join(preparedRoot, sets.strandedA.setName))).isDirectory(),
    true,
  );

  // Pass two: without the protection the remaining stranded set converges;
  // the oldest set is still held back as the first-review provenance.
  const second = await retireSupersededPendingContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
    maximumRetirements: 2,
  });
  assert.equal(second.retiredSets, 1);
  assert.equal(second.retiredJobs, 1);
  const third = await retireSupersededPendingContributionArtifacts({
    preparedSpoolDirectory: preparedRoot,
    reviewArchiveDirectory: reviewRoot,
    queueFile,
    maximumRetirements: 2,
  });
  assert.equal(third.retiredSets, 0);

  const retainedNames = [
    sets.oldest.setName,
    sets.accepted.setName,
    sets.inFlight.setName,
    sets.rejected.setName,
  ].sort();
  assert.deepEqual((await readdir(preparedRoot)).sort(), retainedNames);
  assert.deepEqual((await readdir(reviewRoot)).sort(), retainedNames.map(
    (name) => name.replace("prepared-set-", "review-"),
  ));
  database = new DatabaseSync(queueFile, { readOnly: true });
  assert.deepEqual(
    database.prepare(`
      SELECT state FROM contribution_jobs ORDER BY state
    `).all().map((row) => row.state),
    ["accepted", "in_flight", "pending", "rejected"],
  );
  database.close();
  // The accepted evidence the dashboard's upload-authority claim reads from
  // survives retirement.
  const status = await inspectContributionSyncQueue({
    queueFile,
    now: () => new Date("2026-08-07T02:00:00.000Z"),
  });
  assert.equal(status.counts.accepted, 1);
  assert.equal(status.lastAcceptedAt, "2026-08-06T23:30:00.000Z");
});

test("queue refuses symlinked or non-owner-only database locations", async (t) => {
  if (process.platform === "win32") {
    return t.skip("Windows ACL and reparse-point refusal is deferred");
  }
  const value = await fixture();
  const target = join(value.root, "target.sqlite3");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, value.queueFile);
  await assert.rejects(
    inspectContributionSyncQueue({ queueFile: value.queueFile }),
    (error) => error.code === "contribution_sync_queue_queue_invalid",
  );

  const openParent = join(value.root, "open-parent");
  await mkdir(openParent, { mode: 0o755 });
  await chmod(openParent, 0o755);
  await assert.rejects(
    inspectContributionSyncQueue({
      queueFile: join(openParent, "queue.sqlite3"),
    }),
    (error) => error.code === "contribution_sync_queue_queue_invalid",
  );
});

test("foreground watch repeats explicitly and exits without installing persistence", async () => {
  const value = await fixture();
  const sleeps = [];
  let elapsed = 0;
  const result = await runContributionSyncQueueWatch({
    directory: value.preparedRoot,
    origin: ORIGIN,
    backend: {},
    queueFile: value.queueFile,
    intervalSeconds: 30,
    durationMilliseconds: 60_000,
    clock: () => elapsed,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      elapsed += milliseconds;
    },
    syncEntry: async () => acceptedReceipt(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.passes, 3);
  assert.equal(result.accepted, 1);
  assert.deepEqual(sleeps, [30_000, 30_000]);
});
