import { stableJson } from "../export/index.js";
import {
  preparedContributionSetId,
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "../contribution/index.js";

const CONTRIBUTION_SYNC_QUEUE_SCHEMA =
  "contribution-sync-queue-v0.1";
const CONTRIBUTION_SYNC_STATUS_SCHEMA =
  "contribution-sync-status-v0.1";
const CONTRIBUTION_SYNC_PREVIEW_SCHEMA =
  "contribution-sync-preview-v0.1";
const CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA =
  "contribution-sync-exact-review-v0.1";

const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUE_JOBS = 25_600;
const MAX_DISCOVERED_SETS = 256;
const DEFAULT_MAXIMUM_ATTEMPTS = 8;
const DEFAULT_LEASE_MILLISECONDS = 10 * 60 * 1000;
const DEFAULT_MAXIMUM_JOBS_PER_PASS = 25;
const MAXIMUM_JOBS_PER_PASS = 100;
const RETRY_BACKOFF_POLICY = Object.freeze({
  initialDelayMilliseconds: 5_000,
  maximumDelayMilliseconds: 3_600_000,
  minimumDelayMilliseconds: 1_000,
  jitterMinimumMultiplier: 0.75,
  jitterMaximumMultiplier: 1.25,
});
const MAXIMUM_SERVER_RETRY_DITHER_MILLISECONDS = 60_000;
const MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 16 * 1024;
const DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 16 * 1024 * 1024;
const MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS = 256 * 1024 * 1024;
const ACCEPTED_ARTIFACT_MAXIMUM_AGE_DAYS = 7;
const ACCEPTED_ARTIFACT_MAXIMUM_RETAINED_SETS = 8;
const ACCEPTED_ARTIFACT_MAXIMUM_RETIREMENTS_PER_PASS = 16;
const RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES = 8 * 1024;
const MINIMUM_WATCH_INTERVAL_SECONDS = 30;
const MAXIMUM_WATCH_INTERVAL_SECONDS = 3600;
const SET_NAME =
  /^prepared-set-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVIEW_NAME =
  /^review-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTRIBUTION_ID =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_STATES = Object.freeze([
  "pending",
  "in_flight",
  "accepted",
  "retryable",
  "rejected",
]);
const ERROR_CODES = new Set([
  "configuration_invalid",
  "queue_invalid",
  "queue_unavailable",
  "prepared_root_invalid",
  "retirement_invalid",
  "job_limit",
]);

class ContributionSyncQueueError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown contribution sync queue error code");
    }
    super("Contribution sync queue failed");
    this.name = "ContributionSyncQueueError";
    this.code = `contribution_sync_queue_${code}`;
  }
}

function fail(code) {
  throw new ContributionSyncQueueError(code);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function captureStorage(storage) {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
    throw new TypeError("contribution sync queue storage must be an object");
  }
  const captured = {};
  for (const name of [
    "canonicalPreparedRoot",
    "manifestExists",
    "openQueue",
    "preparedSetDirectories",
    "prepareRetentionRoot",
    "retireFlatDirectory",
  ]) {
    let value;
    try {
      value = storage[name];
    } catch {
      throw new TypeError("contribution sync queue storage is invalid");
    }
    captured[name] = requireFunction(
      value,
      `contribution sync queue storage ${name}`,
    );
  }
  return Object.freeze(captured);
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.toISOString();
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
  return date.getTime();
}

function queueTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function conservativeUploadReservationBytes(preparedBytes) {
  if (!integer(preparedBytes, 0, Number.MAX_SAFE_INTEGER)) {
    fail("configuration_invalid");
  }
  const reservation = (preparedBytes * 2)
    + RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(reservation)) fail("configuration_invalid");
  return reservation;
}

function openQueueRepository(queueFile, now, runtime) {
  return Reflect.apply(runtime.storage.openQueue, undefined, [{
    queueFile,
    now,
  }]);
}

/**
 * Accept either one direct prepared set or an owner-only spool whose immediate
 * child names are generated `prepared-set-<uuid>` directories. Unrecognized
 * loose files and directories are never queued.
 */
async function discoverCommittedPreparedSets({
  directory,
  verifySet = undefined,
} = {}, runtime) {
  const selectedVerifySet = verifySet ?? runtime.verifyPreparedSet;
  if (typeof selectedVerifySet !== "function") fail("configuration_invalid");
  const root = await Reflect.apply(
    runtime.storage.canonicalPreparedRoot,
    undefined,
    [directory],
  );
  const discovered = [];
  // A null root is the never-prepared first-run state: the spool directory
  // does not exist until the first successful preparation creates it, and
  // zero discovered sets is what lets the preview report "empty" so the page
  // can run that very first preparation.
  if (root === null) return discovered;
  if (await Reflect.apply(runtime.storage.manifestExists, undefined, [
    root,
    PREPARED_CONTRIBUTION_SET_MANIFEST,
  ])) {
    const manifest = await selectedVerifySet({
      directory: root,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    discovered.push({
      setName: ".",
      directory: root,
      preparedSetId: preparedContributionSetId(manifest),
      manifest,
    });
    return discovered;
  }

  const directories = await Reflect.apply(
    runtime.storage.preparedSetDirectories,
    undefined,
    [{
    root,
    maximumEntries: MAX_DISCOVERED_SETS,
    matches: (name) => SET_NAME.test(name),
    }],
  );
  for (const { name, directory: child } of directories) {
    const manifest = await selectedVerifySet({
      directory: child,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    discovered.push({
      setName: name,
      directory: child,
      preparedSetId: preparedContributionSetId(manifest),
      manifest,
    });
  }
  return discovered;
}

/**
 * Retire only fully accepted prepared sets. The protected first-review set is
 * retained indefinitely as the exact local consent provenance. All other
 * accepted sets are bounded by both age and count, while each invocation has
 * a fixed cleanup ceiling so foreground work remains predictable.
 *
 * Crash ordering is deliberate: artifacts are removed before accepted queue
 * rows. A crash can therefore leave harmless accepted rows for the next pass,
 * but can never make a still-present set discoverable after its dedupe rows
 * have been deleted.
 */
async function retireAcceptedContributionArtifacts({
  preparedSpoolDirectory,
  reviewArchiveDirectory,
  queueFile = defaultContributionSyncQueueFile(),
  protectedPreparedSetIds = [],
  maximumAgeDays = ACCEPTED_ARTIFACT_MAXIMUM_AGE_DAYS,
  maximumRetainedSets = ACCEPTED_ARTIFACT_MAXIMUM_RETAINED_SETS,
  maximumRetirements =
    ACCEPTED_ARTIFACT_MAXIMUM_RETIREMENTS_PER_PASS,
  now = () => new Date(),
  signal = undefined,
  failpoint = async () => {},
} = {}, runtime) {
  if (!Array.isArray(protectedPreparedSetIds)
      || protectedPreparedSetIds.length > 8
      || protectedPreparedSetIds.some((value) => !SHA256.test(value))
      || new Set(protectedPreparedSetIds).size
        !== protectedPreparedSetIds.length
      || !integer(maximumAgeDays, 1, 30)
      || !integer(maximumRetainedSets, 1, 32)
      || !integer(maximumRetirements, 1, 64)
      || typeof failpoint !== "function"
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("configuration_invalid");
  }
  const preparedRoot = await Reflect.apply(
    runtime.storage.prepareRetentionRoot,
    undefined,
    [preparedSpoolDirectory],
  );
  const reviewRoot = await Reflect.apply(
    runtime.storage.prepareRetentionRoot,
    undefined,
    [reviewArchiveDirectory],
  );
  const repository = await openQueueRepository(queueFile, now, runtime);
  try {
    if (signal?.aborted) {
      return Object.freeze({
        retiredSets: 0,
        retiredJobs: 0,
        interrupted: true,
        networkActivity: false,
      });
    }
    const nowMs = nowMilliseconds(now);
    const cutoff = queueTimestamp(
      nowMs - maximumAgeDays * 24 * 60 * 60 * 1_000,
    );
    const queryLimit = maximumRetainedSets
      + maximumRetirements
      + protectedPreparedSetIds.length;
    const rows = repository.acceptedSets(queryLimit);
    const protectedIds = new Set(protectedPreparedSetIds);
    const unprotected = rows.filter(
      (row) => !protectedIds.has(row.prepared_set_id),
    );
    const candidates = unprotected.filter((row, index) => (
      index >= maximumRetainedSets || row.accepted_at <= cutoff
    )).slice(0, maximumRetirements);
    let retiredSets = 0;
    let retiredJobs = 0;
    for (const row of candidates) {
      if (signal?.aborted) break;
      if (!SHA256.test(row.prepared_set_id)
          || !SET_NAME.test(row.set_name)
          || !integer(Number(row.total_jobs), 1, MAX_QUEUE_JOBS)
          || Number(row.accepted_jobs) !== Number(row.total_jobs)
          || iso(row.accepted_at) !== row.accepted_at) {
        fail("retirement_invalid");
      }
      const suffix = row.set_name.slice("prepared-set-".length);
      const reviewName = `review-${suffix}`;
      if (!REVIEW_NAME.test(reviewName)) fail("retirement_invalid");
      const context = Object.freeze({
        preparedSetId: row.prepared_set_id,
        setName: row.set_name,
        reviewName,
      });
      await failpoint("before_artifact_retirement", context);
      await Reflect.apply(runtime.storage.retireFlatDirectory, undefined, [{
        root: preparedRoot,
        name: row.set_name,
        maximumEntries: 128,
      }]);
      await failpoint("after_prepared_retirement", context);
      await Reflect.apply(runtime.storage.retireFlatDirectory, undefined, [{
        root: reviewRoot,
        name: reviewName,
        maximumEntries: 4,
      }]);
      await failpoint("before_queue_compaction", context);
      const removed = repository.deleteAcceptedSet(row.prepared_set_id);
      if (removed.changes !== Number(row.total_jobs)) {
        fail("retirement_invalid");
      }
      retiredSets += 1;
      retiredJobs += removed.changes;
      await failpoint("after_queue_compaction", context);
    }
    return Object.freeze({
      retiredSets,
      retiredJobs,
      interrupted: signal?.aborted === true,
      networkActivity: false,
    });
  } finally {
    repository.close();
  }
}

function validateCoveredAt(payload) {
  const startAt = payload?.coveredAt?.startAt;
  const endAt = payload?.coveredAt?.endAt;
  if (typeof startAt !== "string" || typeof endAt !== "string"
      || iso(startAt) !== startAt || iso(endAt) !== endAt
      || Date.parse(startAt) > Date.parse(endAt)) {
    fail("queue_invalid");
  }
  return { startAt, endAt };
}

async function enqueueDiscoveredSets({
  repository,
  sets,
  now,
  loadContribution,
  maximumQueuedJobs,
}) {
  const timestamp = iso(now());
  let inserted = 0;
  let alreadyQueued = 0;
  for (const set of sets) {
    if (!SHA256.test(set.preparedSetId)
        || (set.setName !== "." && !SET_NAME.test(set.setName))) {
      fail("queue_invalid");
    }
    for (const entry of set.manifest.files) {
      const payload = await loadContribution({
        directory: set.directory,
        entry,
      });
      const covered = validateCoveredAt(payload);
      const result = repository.enqueueJob({
        preparedSetId: set.preparedSetId,
        setName: set.setName,
        entry,
        coveredAt: covered,
        timestamp,
        maximumQueuedJobs,
      });
      if (result === "limit") fail("job_limit");
      if (result === "existing") {
        alreadyQueued += 1;
      } else {
        inserted += 1;
      }
    }
  }
  return { inserted, existing: alreadyQueued };
}

function defaultContributionSyncQueueFile(runtime) {
  return Reflect.apply(runtime.resolvePath, undefined, [
    process.cwd(),
    ".usage-monitor",
    "private",
    "contribution-sync-v0.1.sqlite3",
  ]);
}

async function inspectContributionSyncQueue({
  queueFile = undefined,
  now = () => new Date(),
} = {}, runtime) {
  const selectedQueueFile = queueFile ?? defaultContributionSyncQueueFile(runtime);
  const repository = await openQueueRepository(selectedQueueFile, now, runtime);
  try {
    const timestamp = iso(now());
    repository.recoverExpiredLeases(timestamp);
    return repository.status(timestamp);
  } finally {
    repository.close();
  }
}

async function setContributionSyncPaused({
  paused,
  queueFile = undefined,
  now = () => new Date(),
} = {}, runtime) {
  if (typeof paused !== "boolean") fail("configuration_invalid");
  const selectedQueueFile = queueFile ?? defaultContributionSyncQueueFile(runtime);
  const repository = await openQueueRepository(selectedQueueFile, now, runtime);
  try {
    const timestamp = iso(now());
    repository.setPaused(paused, timestamp);
    return repository.status(timestamp);
  } finally {
    repository.close();
  }
}

function boundedErrorCode(error, fallback) {
  const code = error?.code;
  if (typeof code === "string"
      && /^[a-z0-9_]{1,80}$/u.test(code)) {
    return code;
  }
  return fallback;
}

function retryDelayMilliseconds(
  attemptCount,
  random,
  retryAfterMilliseconds = null,
) {
  const base = Math.min(
    RETRY_BACKOFF_POLICY.maximumDelayMilliseconds,
    RETRY_BACKOFF_POLICY.initialDelayMilliseconds
      * (2 ** Math.max(0, attemptCount - 1)),
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const jitter = RETRY_BACKOFF_POLICY.jitterMinimumMultiplier
    + (boundedRandom * (
      RETRY_BACKOFF_POLICY.jitterMaximumMultiplier
      - RETRY_BACKOFF_POLICY.jitterMinimumMultiplier
    ));
  const localDelay = Math.max(
    RETRY_BACKOFF_POLICY.minimumDelayMilliseconds,
    Math.round(base * jitter),
  );
  if (!Number.isSafeInteger(retryAfterMilliseconds)
      || retryAfterMilliseconds <= 0) {
    return localDelay;
  }
  // RFC Retry-After is a lower bound. Add only a small positive per-client
  // spread so a shared server deadline cannot become a second herd boundary.
  const serverDither = Math.round(
    Math.min(
      MAXIMUM_SERVER_RETRY_DITHER_MILLISECONDS,
      retryAfterMilliseconds * 0.25,
    ) * boundedRandom,
  );
  return Math.max(localDelay, retryAfterMilliseconds + serverDither);
}

function entryForJob(set, job) {
  const entry = set?.manifest?.files?.find(
    (candidate) => candidate.basename === job.contribution_basename,
  );
  if (!entry || entry.sha256 !== job.contribution_sha256
      || entry.bytes !== job.contribution_bytes
      || set.setName !== job.set_name) {
    return null;
  }
  return entry;
}

function safeContributionProjection(payload) {
  if (payload?.schemaVersion !== "telemetry-contribution-v0.1"
      || ![
        "macos",
        "linux",
        "windows",
        "other",
        "unknown",
      ].includes(payload.clientPlatform)
      || ![
        "unknown",
        "openai_pre_agentic_pool_2026_07_09",
        "openai_agentic_pool_2026_07_09",
        "anthropic_unknown",
      ].includes(payload.providerPolicyEpoch)
      || !Array.isArray(payload.usageEvents)
      || !Array.isArray(payload.quotaSnapshots)
      || !Array.isArray(payload.activityMarkers)
      || !payload.accounting || typeof payload.accounting !== "object") {
    fail("queue_invalid");
  }
  const coveredAt = validateCoveredAt(payload);
  const recordCounts = {
    usageEvents: payload.usageEvents.length,
    quotaSnapshots: payload.quotaSnapshots.length,
    activityMarkers: payload.activityMarkers.length,
  };
  const total = Object.values(recordCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (!Object.values(recordCounts).every(
    (count) => integer(count, 0, 200),
  ) || !integer(total, 1, 200)) {
    fail("queue_invalid");
  }
  const accounting = payload.accounting;
  const {
    estimatedApiCostUsd,
    pricedEventCoveragePercent,
    unknownModelEventCount,
    unknownBillableUnits,
    priceBasis,
  } = accounting;
  if ((estimatedApiCostUsd !== null
        && (typeof estimatedApiCostUsd !== "string"
          || !/^(?:0|[1-9]\d*)\.\d{6}$/u.test(estimatedApiCostUsd)))
      || !Number.isFinite(pricedEventCoveragePercent)
      || pricedEventCoveragePercent < 0
      || pricedEventCoveragePercent > 100
      || !integer(unknownModelEventCount, 0, recordCounts.usageEvents)
      || !integer(unknownBillableUnits, 0, Number.MAX_SAFE_INTEGER)
      || ![
        "current_api_prices",
        "historical_api_prices",
        "unpriced",
        "mixed_api_prices",
      ].includes(priceBasis)) {
    fail("queue_invalid");
  }
  return {
    schemaVersion: payload.schemaVersion,
    clientPlatform: payload.clientPlatform,
    providerPolicyEpoch: payload.providerPolicyEpoch,
    coveredAt,
    recordCounts: { ...recordCounts, total },
    accounting: {
      estimatedApiCostUsd,
      pricedEventCoveragePercent,
      unknownModelEventCount,
      unknownBillableUnits,
      priceBasis,
      verification: "client_declared_unverified",
    },
  };
}

function setAndEntryForQueuedJob(sets, job) {
  const set = sets.find(
    (candidate) => candidate.preparedSetId === job.prepared_set_id,
  );
  const entry = entryForJob(set, job);
  if (!set || !entry) fail("queue_invalid");
  return { set, entry };
}

function verifiedPayloadForQueuedJob({ sets, job, payload }) {
  const { set, entry } = setAndEntryForQueuedJob(sets, job);
  const projection = safeContributionProjection(payload);
  if (projection.coveredAt.startAt !== job.covered_start_at
      || projection.coveredAt.endAt !== job.covered_end_at
      || job.schema_version !== projection.schemaVersion
      || Buffer.byteLength(stableJson(payload), "utf8")
        !== job.contribution_bytes) {
    fail("queue_invalid");
  }
  return { set, entry, projection };
}

async function inspectNextContributionSyncUpload({
  directory,
  queueFile = undefined,
  now = () => new Date(),
  maximumQueuedJobs = MAX_QUEUE_JOBS,
  discoverSets = undefined,
  loadContribution = undefined,
} = {}, runtime) {
  const selectedDiscoverSets = discoverSets
    ?? ((options) => discoverCommittedPreparedSets(options, runtime));
  const selectedLoadContribution = loadContribution
    ?? runtime.loadPreparedContribution;
  if (typeof selectedDiscoverSets !== "function"
      || typeof selectedLoadContribution !== "function"
      || !integer(maximumQueuedJobs, 1, MAX_QUEUE_JOBS)) {
    fail("configuration_invalid");
  }
  const sets = await selectedDiscoverSets({ directory });
  const selectedQueueFile = queueFile ?? defaultContributionSyncQueueFile(runtime);
  const repository = await openQueueRepository(selectedQueueFile, now, runtime);
  try {
    repository.recoverExpiredLeases(iso(now()));
    const enqueued = await enqueueDiscoveredSets({
      repository,
      sets,
      now,
      loadContribution: selectedLoadContribution,
      maximumQueuedJobs,
    });
    const timestamp = iso(now());
    const queue = repository.status(timestamp);
    const job = repository.nextQueuedJob();
    if (!job) {
      return Object.freeze({
        schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA,
        state: "empty",
        networkActivity: false,
        discoveredSets: sets.length,
        enqueued: enqueued.inserted,
        queue,
        item: null,
      });
    }
    const { set, entry } = setAndEntryForQueuedJob(sets, job);
    const payload = await selectedLoadContribution({
      directory: set.directory,
      entry,
    });
    const { projection } = verifiedPayloadForQueuedJob({ sets, job, payload });
    const retryWaiting = job.next_attempt_at > timestamp;
    return Object.freeze({
      schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA,
      state: queue.paused
        ? "paused"
        : retryWaiting
          ? "retry_wait"
          : "ready",
      networkActivity: false,
      discoveredSets: sets.length,
      enqueued: enqueued.inserted,
      queue,
      item: Object.freeze({
        ...projection,
        preparedBytes: job.contribution_bytes,
        reservedUploadBytes: conservativeUploadReservationBytes(
          job.contribution_bytes,
        ),
        attemptCount: job.attempt_count,
        nextAttemptAt: job.next_attempt_at,
      }),
    });
  } finally {
    repository.close();
  }
}

/**
 * Load the exact next queued telemetry contribution for an explicit local
 * review. This is deliberately separate from the aggregate preview: the
 * telemetry payload is safe only because it has passed the prepared-set
 * verifier, while queue bookkeeping remains path- and identifier-free.
 */
async function inspectExactNextContributionSyncUpload({
  directory,
  queueFile = undefined,
  now = () => new Date(),
  maximumQueuedJobs = MAX_QUEUE_JOBS,
  discoverSets = undefined,
  loadContribution = undefined,
} = {}, runtime) {
  const selectedDiscoverSets = discoverSets
    ?? ((options) => discoverCommittedPreparedSets(options, runtime));
  const selectedLoadContribution = loadContribution
    ?? runtime.loadPreparedContribution;
  if (typeof selectedDiscoverSets !== "function"
      || typeof selectedLoadContribution !== "function"
      || !integer(maximumQueuedJobs, 1, MAX_QUEUE_JOBS)) {
    fail("configuration_invalid");
  }
  const sets = await selectedDiscoverSets({ directory });
  const selectedQueueFile = queueFile ?? defaultContributionSyncQueueFile(runtime);
  const repository = await openQueueRepository(selectedQueueFile, now, runtime);
  try {
    repository.recoverExpiredLeases(iso(now()));
    const enqueued = await enqueueDiscoveredSets({
      repository,
      sets,
      now,
      loadContribution: selectedLoadContribution,
      maximumQueuedJobs,
    });
    const timestamp = iso(now());
    const queue = repository.status(timestamp);
    const job = repository.nextQueuedJob();
    if (!job) {
      return Object.freeze({
        schemaVersion: CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA,
        state: "empty",
        networkActivity: false,
        discoveredSets: sets.length,
        enqueued: enqueued.inserted,
        queue,
        payloadBytes: null,
        payload: null,
      });
    }
    const { set, entry } = setAndEntryForQueuedJob(sets, job);
    const payload = await selectedLoadContribution({
      directory: set.directory,
      entry,
    });
    const { projection } = verifiedPayloadForQueuedJob({ sets, job, payload });
    const retryWaiting = job.next_attempt_at > timestamp;
    return Object.freeze({
      schemaVersion: CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA,
      state: queue.paused
        ? "paused"
        : retryWaiting
          ? "retry_wait"
          : "ready",
      networkActivity: false,
      discoveredSets: sets.length,
      enqueued: enqueued.inserted,
      queue,
      payloadBytes: job.contribution_bytes,
      payload: structuredClone(payload),
      recordCounts: projection.recordCounts,
      reviewBinding: Object.freeze({
        jobId: job.job_id,
        contributionSha256: job.contribution_sha256,
      }),
    });
  } finally {
    repository.close();
  }
}

async function runContributionSyncQueueOnce({
  directory,
  origin,
  backend,
  queueFile = undefined,
  stateFile = undefined,
  signal = undefined,
  now = () => new Date(),
  random = Math.random,
  maximumAttempts = DEFAULT_MAXIMUM_ATTEMPTS,
  maximumQueuedJobs = MAX_QUEUE_JOBS,
  leaseMilliseconds = DEFAULT_LEASE_MILLISECONDS,
  maximumJobs = DEFAULT_MAXIMUM_JOBS_PER_PASS,
  maximumReservedUploadBytes =
    DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  reviewedJob = undefined,
  preparedSetId = undefined,
  discoverSets = undefined,
  loadContribution = undefined,
  syncEntry = undefined,
} = {}, runtime) {
  const selectedDiscoverSets = discoverSets
    ?? ((options) => discoverCommittedPreparedSets(options, runtime));
  const selectedLoadContribution = loadContribution
    ?? runtime.loadPreparedContribution;
  const selectedSyncEntry = syncEntry ?? runtime.syncPreparedEntry;
  if (!backend || typeof backend !== "object"
      || typeof selectedDiscoverSets !== "function"
      || typeof selectedLoadContribution !== "function"
      || typeof selectedSyncEntry !== "function"
      || typeof random !== "function"
      || !integer(maximumAttempts, 1, 32)
      || !integer(maximumQueuedJobs, 1, MAX_QUEUE_JOBS)
      || !integer(leaseMilliseconds, 60_000, 60 * 60 * 1000)
      || !integer(maximumJobs, 1, MAXIMUM_JOBS_PER_PASS)
      || !integer(
        maximumReservedUploadBytes,
        MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
        MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
      )
      || (reviewedJob !== undefined
        && (typeof reviewedJob !== "object"
          || reviewedJob === null
          || !UUID_V4.test(reviewedJob.jobId ?? "")
          || !SHA256.test(reviewedJob.contributionSha256 ?? "")))
      || (preparedSetId !== undefined && !SHA256.test(preparedSetId))
      || (reviewedJob !== undefined && preparedSetId !== undefined)
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("configuration_invalid");
  }
  const discoveredSets = await selectedDiscoverSets({ directory });
  const sets = preparedSetId === undefined
    ? discoveredSets
    : discoveredSets.filter((set) => set.preparedSetId === preparedSetId);
  const selectedQueueFile = queueFile ?? defaultContributionSyncQueueFile(runtime);
  const repository = await openQueueRepository(selectedQueueFile, now, runtime);
  const openedAt = queueTimestamp(nowMilliseconds(now));
  let enqueued;
  try {
    repository.recoverExpiredLeases(openedAt);
    enqueued = await enqueueDiscoveredSets({
      repository,
      sets,
      now,
      loadContribution: selectedLoadContribution,
      maximumQueuedJobs,
    });
    const readyAt = queueTimestamp(nowMilliseconds(now));
    const initialStatus = repository.status(readyAt);
    if (initialStatus.paused || signal?.aborted) {
      return Object.freeze({
        status: initialStatus.paused ? "paused" : "interrupted",
        discoveredSets: sets.length,
        enqueued: enqueued.inserted,
        processed: 0,
        accepted: 0,
        retryable: 0,
        rejected: 0,
        reservedUploadBytes: 0,
        bandwidthLimited: false,
        queue: initialStatus,
        preparedSet: preparedSetId === undefined
          ? null
          : repository.preparedSetStatus(preparedSetId),
      });
    }

    const availableSets = new Map(
      sets.map((set) => [set.preparedSetId, set]),
    );
    const candidates = repository.readyJobs({
      reviewedJob,
      preparedSetId,
      readyAt,
      maximumJobs,
    });
    const selectedPreparedSetId = preparedSetId
      ?? candidates[0]?.prepared_set_id
      ?? null;
    const result = {
      processed: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0,
      reservedUploadBytes: 0,
      bandwidthLimited: false,
    };
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const set = availableSets.get(candidate.prepared_set_id);
      if (!set) continue;
      const reservation = conservativeUploadReservationBytes(
        candidate.contribution_bytes,
      );
      if (result.reservedUploadBytes + reservation
          > maximumReservedUploadBytes) {
        result.bandwidthLimited = true;
        break;
      }
      const claimedAtMs = nowMilliseconds(now);
      const claimedAt = queueTimestamp(claimedAtMs);
      const job = repository.claimJob(
        candidate.job_id,
        claimedAt,
        queueTimestamp(claimedAtMs + leaseMilliseconds),
      );
      if (!job) continue;
      result.processed += 1;
      const entry = entryForJob(set, job);
      if (!entry) {
        repository.finishFailed(job, {
          state: "rejected",
          errorCode: "prepared_entry_changed",
          nextAttemptAt: null,
          timestamp: iso(now()),
          pause: false,
        });
        result.rejected += 1;
        continue;
      }
      try {
        result.reservedUploadBytes += reservation;
        const receipt = await selectedSyncEntry({
          directory: set.directory,
          entry,
          origin,
          backend,
          stateFile,
          signal,
        });
        if (!CONTRIBUTION_ID.test(receipt?.contributionId ?? "")) {
          throw new Error("Receipt identity invalid");
        }
        repository.finishAccepted(job, receipt, iso(now()));
        result.accepted += 1;
      } catch (error) {
        const failureAtMs = nowMilliseconds(now);
        const failureAt = queueTimestamp(failureAtMs);
        const interrupted = signal?.aborted === true;
        const deviceUnavailable = error?.deviceUnavailable === true;
        const retryAfterExceedsMaximum = error?.retryAfterExceedsMaximum === true;
        const mayRetry = interrupted || deviceUnavailable
          || error?.retryable === true;
        const exhausted = job.attempt_count >= maximumAttempts;
        const state = mayRetry && !exhausted ? "retryable" : "rejected";
        const errorCode = interrupted
          ? "interrupted"
          : exhausted && mayRetry
            ? "retry_exhausted"
            : boundedErrorCode(error, "local_failure");
        const retryAfterMilliseconds = error?.retryAfterMilliseconds;
        // Cancellation must not turn a response that already supplied
        // Retry-After into an immediate retry. A plain interruption remains
        // eligible for immediate recovery; a service floor always wins.
        const nextAttemptAt = state === "retryable"
          ? queueTimestamp(
            interrupted
              && (!Number.isSafeInteger(retryAfterMilliseconds)
                || retryAfterMilliseconds <= 0)
              ? failureAtMs
              : failureAtMs + retryDelayMilliseconds(
                job.attempt_count,
                random,
                retryAfterMilliseconds,
              ),
          )
          : null;
        repository.finishFailed(job, {
          state,
          errorCode,
          nextAttemptAt,
          timestamp: failureAt,
          // An over-horizon Retry-After is safer as an explicit pause than a
          // truncated deadline that would violate the server's retry floor.
          pause: deviceUnavailable || retryAfterExceedsMaximum,
        });
        if (state === "retryable") result.retryable += 1;
        else result.rejected += 1;
        if (deviceUnavailable || retryAfterExceedsMaximum || interrupted) break;
      }
    }
    const completedAt = iso(now());
    const queue = repository.status(completedAt);
    const retryNotBeforeAt = selectedPreparedSetId === null
      ? null
      : repository.preparedSetNextAttemptAt(selectedPreparedSetId);
    return Object.freeze({
      status: queue.paused
        ? "paused"
        : signal?.aborted
          ? "interrupted"
          : "completed",
      discoveredSets: sets.length,
      enqueued: enqueued.inserted,
      ...result,
      queue,
      retryNotBeforeAt,
      preparedSet: selectedPreparedSetId === null
        ? null
        : repository.preparedSetStatus(selectedPreparedSetId),
    });
  } finally {
    repository.close();
  }
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolveDelay();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function runContributionSyncQueueWatch({
  intervalSeconds = 60,
  durationMilliseconds = null,
  signal = undefined,
  sleep = abortableDelay,
  clock = Date.now,
  ...options
} = {}, runtime) {
  if (!integer(intervalSeconds, MINIMUM_WATCH_INTERVAL_SECONDS,
    MAXIMUM_WATCH_INTERVAL_SECONDS)
      || (durationMilliseconds !== null
        && !integer(durationMilliseconds, 0, 30 * 24 * 60 * 60 * 1000))
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || typeof sleep !== "function" || typeof clock !== "function") {
    fail("configuration_invalid");
  }
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) fail("configuration_invalid");
  const totals = {
    passes: 0,
    enqueued: 0,
    processed: 0,
    accepted: 0,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 0,
    bandwidthLimitedPasses: 0,
  };
  let latest = null;
  while (!signal?.aborted) {
    latest = await runContributionSyncQueueOnce({
      ...options,
      signal,
    }, runtime);
    totals.passes += 1;
    for (const key of [
      "enqueued",
      "processed",
      "accepted",
      "retryable",
      "rejected",
      "reservedUploadBytes",
    ]) {
      totals[key] += latest[key];
    }
    if (latest.bandwidthLimited) totals.bandwidthLimitedPasses += 1;
    if (latest.status === "paused") break;
    const elapsed = clock() - startedAt;
    if (durationMilliseconds !== null && elapsed >= durationMilliseconds) break;
    const remaining = durationMilliseconds === null
      ? intervalSeconds * 1000
      : Math.min(intervalSeconds * 1000, durationMilliseconds - elapsed);
    if (remaining <= 0) break;
    await sleep(remaining, signal);
  }
  return Object.freeze({
    status: latest?.status === "paused"
      ? "paused"
      : signal?.aborted
        ? "interrupted"
        : "completed",
    ...totals,
    queue: latest?.queue ?? await inspectContributionSyncQueue({
      queueFile: options.queueFile,
    }, runtime),
  });
}

const CONTRIBUTION_SYNC_QUEUE_LIMITS = Object.freeze({
  maximumQueueBytes: MAX_QUEUE_BYTES,
  maximumJobs: MAX_QUEUE_JOBS,
  maximumPreparedSets: MAX_DISCOVERED_SETS,
  maximumAttempts: DEFAULT_MAXIMUM_ATTEMPTS,
  leaseMilliseconds: DEFAULT_LEASE_MILLISECONDS,
  maximumJobsPerPass: DEFAULT_MAXIMUM_JOBS_PER_PASS,
  maximumJobsPerPassAllowed: MAXIMUM_JOBS_PER_PASS,
  retryBackoffPolicy: RETRY_BACKOFF_POLICY,
  minimumReservedUploadBytesPerPass:
    MINIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  maximumReservedUploadBytesPerPass:
    MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  defaultMaximumReservedUploadBytesPerPass:
    DEFAULT_MAXIMUM_RESERVED_UPLOAD_BYTES_PER_PASS,
  reservedUploadEnvelopeOverheadBytes:
    RESERVED_UPLOAD_ENVELOPE_OVERHEAD_BYTES,
  minimumWatchIntervalSeconds: MINIMUM_WATCH_INTERVAL_SECONDS,
  maximumWatchIntervalSeconds: MAXIMUM_WATCH_INTERVAL_SECONDS,
});

export function createLocalContributionSyncQueueContext({
  createStorage,
  resolvePath,
  verifyPreparedSet,
  loadPreparedContribution,
  syncPreparedEntry,
} = {}) {
  const storageFactory = requireFunction(createStorage, "createStorage");
  const storage = Reflect.apply(storageFactory, undefined, [{
    createError: (code) => new ContributionSyncQueueError(code),
    queueSchemaVersion: CONTRIBUTION_SYNC_QUEUE_SCHEMA,
    queueStatusSchemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA,
    maximumQueueBytes: MAX_QUEUE_BYTES,
    maximumQueueJobs: MAX_QUEUE_JOBS,
    jobStates: JOB_STATES,
  }]);
  const runtime = Object.freeze({
    storage: captureStorage(storage),
    resolvePath: requireFunction(resolvePath, "resolvePath"),
    verifyPreparedSet: requireFunction(
      verifyPreparedSet,
      "verifyPreparedSet",
    ),
    loadPreparedContribution: requireFunction(
      loadPreparedContribution,
      "loadPreparedContribution",
    ),
    syncPreparedEntry: requireFunction(syncPreparedEntry, "syncPreparedEntry"),
  });
  return Object.freeze({
    ACCEPTED_ARTIFACT_MAXIMUM_AGE_DAYS,
    ACCEPTED_ARTIFACT_MAXIMUM_RETAINED_SETS,
    ACCEPTED_ARTIFACT_MAXIMUM_RETIREMENTS_PER_PASS,
    CONTRIBUTION_SYNC_EXACT_REVIEW_SCHEMA,
    CONTRIBUTION_SYNC_PREVIEW_SCHEMA,
    CONTRIBUTION_SYNC_QUEUE_LIMITS,
    CONTRIBUTION_SYNC_QUEUE_SCHEMA,
    CONTRIBUTION_SYNC_STATUS_SCHEMA,
    RETRY_BACKOFF_POLICY,
    ContributionSyncQueueError,
    conservativeUploadReservationBytes,
    defaultContributionSyncQueueFile: () =>
      defaultContributionSyncQueueFile(runtime),
    discoverCommittedPreparedSets: (options) =>
      discoverCommittedPreparedSets(options, runtime),
    inspectContributionSyncQueue: (options) =>
      inspectContributionSyncQueue(options, runtime),
    inspectExactNextContributionSyncUpload: (options) =>
      inspectExactNextContributionSyncUpload(options, runtime),
    inspectNextContributionSyncUpload: (options) =>
      inspectNextContributionSyncUpload(options, runtime),
    retireAcceptedContributionArtifacts: (options) =>
      retireAcceptedContributionArtifacts(options, runtime),
    runContributionSyncQueueOnce: (options) =>
      runContributionSyncQueueOnce(options, runtime),
    runContributionSyncQueueWatch: (options) =>
      runContributionSyncQueueWatch(options, runtime),
    setContributionSyncPaused: (options) =>
      setContributionSyncPaused(options, runtime),
  });
}
