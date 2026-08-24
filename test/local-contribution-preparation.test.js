import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LocalContributionPreparationError,
  createLocalContributionPreparationRunner,
  prepareLatestHourLocalContribution,
  prepareRecentLocalContribution,
  projectLocalContributionPreparationError,
} from "../src/local-contribution-preparation.js";
import {
  createLocalPreparedContributionContext,
} from "../src/application/local-prepared-contribution.js";
import {
  loadVerifiedLocalMetadataBundleFiles,
  verifyLocalMetadataBundleFiles,
} from "../src/bundle-verifier.js";
import {
  writeLocalMetadataBundle,
} from "../src/metadata-exporter.js";
import {
  discoverCommittedPreparedSets,
} from "../src/contribution-sync-queue.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  materializeTelemetryContributions,
} from "../src/telemetry-contribution-builder.js";
import {
  createOwnerOnlyPreparedContributionStorageContext,
} from "../src/platform/owner-only-prepared-contribution-storage.js";
import {
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  verifyPreparedContributionSet,
} from "../src/telemetry-prepared-set.js";
import {
  createExportResourceGuard,
} from "../src/export-resource-policy.js";

const COVERAGE = Object.freeze({
  startAt: "2026-07-24T21:00:00.000Z",
  endAt: "2026-07-24T23:02:00.000Z",
});
const UUID_ONE = "00000000-0000-4000-8000-000000000001";
const UUID_TWO = "00000000-0000-4000-8000-000000000002";
const UUID_THREE = "00000000-0000-4000-8000-000000000003";
const UUID_FOUR = "00000000-0000-4000-8000-000000000004";
const UUID_FIVE = "00000000-0000-4000-8000-000000000005";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-local-prepare-"));
  const codexHome = join(root, "codex");
  const sessionDirectory = join(codexHome, "sessions");
  const reviewArchiveDirectory = join(root, "reviews");
  const preparedSpoolDirectory = join(root, "prepared");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const tokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-24T23:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "private-session-that-must-not-leak",
        source: "user",
      },
    },
    {
      timestamp: "2026-07-24T23:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-24T23:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_438_000,
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessionDirectory, "rollout-current.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    codexHome,
    reviewArchiveDirectory,
    preparedSpoolDirectory,
  };
}

function identityDependencies() {
  return {
    selectIdentity: () => ({ identityOptions: Object.freeze({}) }),
    withIdentityLease: async (_options, callback) => callback({
      secret: Buffer.alloc(32, 7),
    }),
  };
}

async function runPreparation(files, uuid, options = {}) {
  return prepareLatestHourLocalContribution({
    coveredAt: COVERAGE,
    codexHome: files.codexHome,
    activityFile: join(files.root, "missing-activity-markers.jsonl"),
    reviewArchiveDirectory: files.reviewArchiveDirectory,
    preparedSpoolDirectory: files.preparedSpoolDirectory,
    uuid: () => uuid,
    ...identityDependencies(),
    ...options,
  });
}

function injectedPreparationStorage(files) {
  const base = createOwnerOnlyPreparedContributionStorageContext();
  const root = files.root;
  const calls = [];
  let identitySwapped = false;
  const directoryMethods = new Set([
    "assertPathAbsent",
    "createOwnerOnlyDirectory",
    "ownerOnlyDirectoryExists",
    "prepareOwnerOnlyDirectory",
    "removeEmptyOwnerOnlyDirectory",
    "renameDirectory",
    "syncDirectory",
  ]);
  const names = [
    "assertPathAbsent",
    "canonicalDirectory",
    "createOwnerOnlyDirectory",
    "ownerOnlyDirectoryExists",
    "prepareOwnerOnlyDirectory",
    "publishManifest",
    "publishOwnerOnlyFile",
    "readDirectoryEntries",
    "readOwnerOnlyFile",
    "removeEmptyOwnerOnlyDirectory",
    "renameDirectory",
    "sha256Hex",
    "syncDirectory",
  ];
  const storage = {};
  for (const name of names) {
    Object.defineProperty(storage, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: (...args) => {
        calls.push([name, ...args]);
        if (!directoryMethods.has(name)) {
          return Reflect.apply(base[name], base, args);
        }
        const paths = name === "removeEmptyOwnerOnlyDirectory"
          ? args.slice(0, 2)
          : name === "renameDirectory"
            ? args.slice(0, 2)
            : args.slice(0, 1);
        let createError;
        for (let index = args.length - 1; index >= 0; index -= 1) {
          if (typeof args[index] === "function") {
            createError = args[index];
            break;
          }
        }
        if (identitySwapped && name !== "syncDirectory") {
          if (typeof createError === "function") {
            throw createError("preparation_failed");
          }
          throw new Error("identity_mismatch");
        }
        for (const path of paths) {
          if (typeof path !== "string") continue;
          const canonical = resolve(path);
          const privateRoot = root.startsWith("/private/")
            ? root.slice("/private".length)
            : `/private${root}`;
          const insideRoot = (canonical === root
            || canonical.startsWith(`${root}/`)
            || canonical === privateRoot
            || canonical.startsWith(`${privateRoot}/`));
          if (!insideRoot) {
            if (typeof createError === "function") {
              throw createError(
                name === "prepareOwnerOnlyDirectory"
                  ? args[1]
                  : "preparation_failed",
              );
            }
            throw new Error("path_escape");
          }
        }
        return Reflect.apply(base[name], base, args);
      },
    });
  }
  Object.freeze(storage);
  return Object.freeze({
    storage,
    calls,
    isStorage: (value) => value === storage,
    swapIdentity() {
      identitySwapped = true;
    },
  });
}

function injectedPreparationRunner(files, injected, options = {}) {
  const preparedContext = createLocalPreparedContributionContext({
    storage: injected.storage,
    sha256Hex: injected.storage.sha256Hex,
  });
  return createLocalContributionPreparationRunner({
    storage: injected.storage,
    storageValidator: injected.isStorage,
    coverageProvider: async () => COVERAGE,
    codexHome: files.codexHome,
    activityFile: join(files.root, "missing-activity-markers.jsonl"),
    reviewArchiveDirectory: files.reviewArchiveDirectory,
    preparedSpoolDirectory: files.preparedSpoolDirectory,
    uuid: () => UUID_ONE,
    ...identityDependencies(),
    materialize: (materializeOptions) => materializeTelemetryContributions({
      ...materializeOptions,
      preparedContributionContext: preparedContext,
    }),
    verifyPreparedSet: preparedContext.verifyPreparedContributionSet,
    ...options,
  });
}

test("latest-hour preparation retains a verified review pair and atomically publishes a stripped prepared set", async () => {
  const files = await fixture();
  try {
    const result = await runPreparation(files, UUID_ONE);
    assert.deepEqual(result.coveredAt, {
      startAt: "2026-07-24T22:02:00.000Z",
      endAt: COVERAGE.endAt,
    });
    assert.equal(result.status, "prepared");
    assert.equal(result.privacy.verdict, "passed");
    assert.equal(result.privacy.checksFailed, 0);
    assert.equal(result.privacy.provenanceRetained, true);
    assert.equal(result.prepared.batchCount, 1);
    assert.match(result.prepared.preparedSetId, /^[a-f0-9]{64}$/u);
    assert.equal(result.networkActivity, false);
    assert.equal(result.includesContent, false);
    assert.equal(result.includesPaths, false);
    assert.equal(result.includesIdentifiers, false);
    assert.equal(result.includesCredentials, false);

    const serializedResult = JSON.stringify(result);
    assert.equal(serializedResult.includes("preparedSetId"), false);
    assert.equal(serializedResult.includes(files.root), false);
    assert.equal(
      serializedResult.includes("private-session-that-must-not-leak"),
      false,
    );
    assert.equal(serializedResult.includes(UUID_ONE), false);

    const reviewDirectory = join(
      files.reviewArchiveDirectory,
      `review-${UUID_ONE}`,
    );
    const bundleFile = join(reviewDirectory, "review.umx.json");
    const receiptFile = join(
      reviewDirectory,
      "review.umx.json.privacy-receipt.json",
    );
    const review = await verifyLocalMetadataBundleFiles({
      bundleFile,
      receiptFile,
    });
    assert.equal(review.verdict, "passed");
    assert.equal(review.transportReady, false);
    if (process.platform !== "win32") {
      assert.equal((await stat(bundleFile)).mode & 0o077, 0);
      assert.equal((await stat(receiptFile)).mode & 0o077, 0);
    }

    const names = await readdir(files.preparedSpoolDirectory);
    assert.deepEqual(names, [`prepared-set-${UUID_ONE}`]);
    const preparedDirectory = join(
      files.preparedSpoolDirectory,
      names[0],
    );
    const manifest = await verifyPreparedContributionSet({
      directory: preparedDirectory,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    assert.equal(manifest.batchCount, 1);
    const contribution = JSON.parse(await readFile(
      join(preparedDirectory, manifest.files[0].basename),
      "utf8",
    ));
    const serializedContribution = JSON.stringify(contribution);
    for (const forbidden of [
      "accountScopeId",
      "sessionScopeId",
      "participantId",
      "providerStateId",
      "private-session-that-must-not-leak",
    ]) {
      assert.equal(serializedContribution.includes(forbidden), false);
    }
    assert.equal(contribution.createdAt, COVERAGE.endAt);
    if (process.platform !== "win32") {
      assert.equal((await lstat(preparedDirectory)).mode & 0o077, 0);
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("recent preparation supports bounded 24-hour and seven-day review sets without weakening privacy invariants", async () => {
  const files = await fixture();
  const coveredAt = {
    startAt: "2026-07-10T23:02:00.000Z",
    endAt: COVERAGE.endAt,
  };
  const prepare = (lookbackHours, uuid, options = {}) =>
    prepareRecentLocalContribution({
      lookbackHours,
      coveredAt,
      codexHome: files.codexHome,
      activityFile: join(files.root, "missing-activity-markers.jsonl"),
      reviewArchiveDirectory: files.reviewArchiveDirectory,
      preparedSpoolDirectory: files.preparedSpoolDirectory,
      uuid: () => uuid,
      ...identityDependencies(),
      ...options,
    });
  try {
    const oneDay = await prepare(24, UUID_ONE);
    assert.deepEqual(oneDay.coveredAt, {
      startAt: "2026-07-23T23:02:00.000Z",
      endAt: COVERAGE.endAt,
    });
    assert.equal(oneDay.networkActivity, false);
    assert.equal(oneDay.privacy.verdict, "passed");

    const sevenDays = await prepare(7 * 24, UUID_TWO);
    assert.deepEqual(sevenDays.coveredAt, {
      startAt: "2026-07-17T23:02:00.000Z",
      endAt: COVERAGE.endAt,
    });
    assert.equal(sevenDays.networkActivity, false);
    assert.equal(sevenDays.includesContent, false);
    assert.equal(sevenDays.includesPaths, false);
    assert.equal(sevenDays.includesIdentifiers, false);
    assert.equal(sevenDays.includesCredentials, false);

    const incremental = await prepare(24, UUID_THREE, {
      acceptedThroughAt: "2026-07-24T22:00:00.000Z",
      replayOverlapHours: 1,
    });
    assert.deepEqual(incremental.coveredAt, {
      startAt: "2026-07-24T21:00:00.000Z",
      endAt: COVERAGE.endAt,
    });

    await assert.rejects(
      prepare(24, UUID_FIVE, {
        acceptedThroughAt: COVERAGE.endAt,
        replayOverlapHours: 1,
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "no_safe_records",
    );

    await assert.rejects(
      prepare(7 * 24, UUID_FOUR, {
        createResourceGuard: () => createExportResourceGuard({
          limits: { maximumOutputRecords: 1 },
        }),
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "export_too_large",
    );
    assert.deepEqual(
      (await readdir(files.preparedSpoolDirectory)).sort(),
      [
        `prepared-set-${UUID_ONE}`,
        `prepared-set-${UUID_TWO}`,
        `prepared-set-${UUID_THREE}`,
      ],
    );

    await assert.rejects(
      prepare(2, UUID_FIVE),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "coverage_invalid",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("public success counts come from the finally reopened source and published artifacts", async () => {
  const files = await fixture();
  let sourceVerificationCalls = 0;
  try {
    const inMemoryCounts = {
      usageEvents: 197,
      quotaSnapshots: 2,
      activityMarkers: 1,
    };
    const result = await runPreparation(files, UUID_ONE, {
      async writeBundle(options) {
        await writeLocalMetadataBundle(options);
        options.receipt.recordCounts = inMemoryCounts;
      },
      async verifySource(options) {
        sourceVerificationCalls += 1;
        return loadVerifiedLocalMetadataBundleFiles(options);
      },
    });
    const reviewDirectory = join(
      files.reviewArchiveDirectory,
      `review-${UUID_ONE}`,
    );
    const verifiedSource = await verifyLocalMetadataBundleFiles({
      bundleFile: join(reviewDirectory, "review.umx.json"),
      receiptFile: join(
        reviewDirectory,
        "review.umx.json.privacy-receipt.json",
      ),
    });
    const publishedManifest = await verifyPreparedContributionSet({
      directory: join(
        files.preparedSpoolDirectory,
        `prepared-set-${UUID_ONE}`,
      ),
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    const publishedCounts = publishedManifest.files.reduce(
      (aggregate, file) => ({
        usageEvents:
          aggregate.usageEvents + file.recordCounts.usageEvents,
        quotaSnapshots:
          aggregate.quotaSnapshots + file.recordCounts.quotaSnapshots,
        activityMarkers:
          aggregate.activityMarkers + file.recordCounts.activityMarkers,
      }),
      { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    );

    assert.equal(sourceVerificationCalls, 2);
    assert.deepEqual(result.recordCounts, verifiedSource.recordCounts);
    assert.deepEqual(result.recordCounts, publishedCounts);
    assert.notDeepEqual(result.recordCounts, inMemoryCounts);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a prepared aggregate mismatch fails closed before publication", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        async verifyPreparedSet(options) {
          const manifest = await verifyPreparedContributionSet(options);
          const mismatched = structuredClone(manifest);
          mismatched.files[0].recordCounts.usageEvents += 1;
          return mismatched;
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "privacy_verification_failed"
        && error.message === "Local contribution preparation failed",
    );
    assert.deepEqual(
      await readdir(files.preparedSpoolDirectory),
      [`.preparing-${UUID_ONE}`],
    );
    assert.deepEqual(
      await discoverCommittedPreparedSets({
        directory: files.preparedSpoolDirectory,
      }),
      [],
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a published aggregate mismatch cannot produce public success", async () => {
  const files = await fixture();
  let preparedVerificationCalls = 0;
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        async verifyPreparedSet(options) {
          const manifest = await verifyPreparedContributionSet(options);
          preparedVerificationCalls += 1;
          if (preparedVerificationCalls === 1) return manifest;
          const mismatched = structuredClone(manifest);
          mismatched.files[0].recordCounts.quotaSnapshots += 1;
          return mismatched;
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "privacy_verification_failed"
        && error.message === "Local contribution preparation failed",
    );
    assert.equal(preparedVerificationCalls, 2);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("an interrupted materializer remains non-discoverable while the privacy review provenance survives", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        async failpoint(name) {
          if (name === "materializer:after_contribution_file") {
            throw new Error(
              `hostile private failure ${files.root} private-session-that-must-not-leak`,
            );
          }
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed"
        && error.message === "Local contribution preparation failed",
    );
    assert.deepEqual(
      await readdir(files.preparedSpoolDirectory),
      [`.preparing-${UUID_ONE}`],
    );
    assert.deepEqual(
      await discoverCommittedPreparedSets({
        directory: files.preparedSpoolDirectory,
      }),
      [],
    );
    const reviewDirectory = join(
      files.reviewArchiveDirectory,
      `review-${UUID_ONE}`,
    );
    const review = await verifyLocalMetadataBundleFiles({
      bundleFile: join(reviewDirectory, "review.umx.json"),
      receiptFile: join(
        reviewDirectory,
        "review.umx.json.privacy-receipt.json",
      ),
    });
    assert.equal(review.verdict, "passed");
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a durable attempt resumes from its verified review pair without minting another artifact", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        async failpoint(name) {
          if (name === "after_review_pair") {
            throw new Error("simulated process interruption");
          }
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed",
    );
    assert.deepEqual(
      await readdir(files.reviewArchiveDirectory),
      [`review-${UUID_ONE}`],
    );
    assert.deepEqual(await readdir(files.preparedSpoolDirectory), []);

    const recovered = await runPreparation(files, UUID_ONE);
    assert.equal(recovered.status, "prepared");
    assert.deepEqual(
      await readdir(files.reviewArchiveDirectory),
      [`review-${UUID_ONE}`],
    );
    assert.deepEqual(
      await readdir(files.preparedSpoolDirectory),
      [`prepared-set-${UUID_ONE}`],
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a post-publication crash reopens the exact attempt and never duplicates its review or prepared set", async () => {
  const files = await fixture();
  let handoffs = 0;
  const beforePreparedPublish = async () => {
    handoffs += 1;
  };
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        beforePreparedPublish,
        async failpoint(name) {
          if (name === "after_prepared_publish") {
            throw new Error("simulated crash after atomic rename");
          }
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed",
    );
    assert.equal(handoffs, 1);
    assert.deepEqual(
      await readdir(files.reviewArchiveDirectory),
      [`review-${UUID_ONE}`],
    );
    assert.deepEqual(
      await readdir(files.preparedSpoolDirectory),
      [`prepared-set-${UUID_ONE}`],
    );

    const recovered = await runPreparation(files, UUID_ONE, {
      beforePreparedPublish,
    });
    assert.equal(recovered.status, "prepared");
    assert.equal(handoffs, 2);
    assert.deepEqual(
      await readdir(files.reviewArchiveDirectory),
      [`review-${UUID_ONE}`],
    );
    assert.deepEqual(
      await readdir(files.preparedSpoolDirectory),
      [`prepared-set-${UUID_ONE}`],
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("an invalid partial staging attempt fails closed under one stable identity across repeated recovery", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        async failpoint(name) {
          if (name === "materializer:after_contribution_file") {
            throw new Error("simulated partial staging crash");
          }
        },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed",
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        runPreparation(files, UUID_ONE),
        (error) => error instanceof LocalContributionPreparationError
          && error.code === "preparation_failed",
      );
      assert.deepEqual(
        await readdir(files.reviewArchiveDirectory),
        [`review-${UUID_ONE}`],
      );
      assert.deepEqual(
        await readdir(files.preparedSpoolDirectory),
        [`.preparing-${UUID_ONE}`],
      );
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a pre-build resource rejection removes only empty unpublished attempt directories", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      runPreparation(files, UUID_ONE, {
        createResourceGuard: () => createExportResourceGuard({
          limits: { maximumSourceBytes: 1 },
        }),
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "export_too_large",
    );
    assert.deepEqual(await readdir(files.reviewArchiveDirectory), []);
    assert.deepEqual(await readdir(files.preparedSpoolDirectory), []);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a resource-bounded failure names the bound that stopped it", async () => {
  const files = await fixture();
  try {
    // Two different ceilings, both reported as export_too_large. The point of
    // the detail is that these two are told apart, so both are asserted.
    for (const [limits, expected] of [
      [{ maximumSourceBytes: 1 }, "export_resource_source_bytes"],
      [{ maximumOutputRecords: 1 }, "export_resource_output_records"],
    ]) {
      await assert.rejects(
        runPreparation(files, UUID_ONE, {
          createResourceGuard: () => createExportResourceGuard({ limits }),
        }),
        (error) => {
          assert.equal(error.code, "export_too_large");
          assert.equal(error.detail?.code, expected);
          const projected = projectLocalContributionPreparationError(error);
          assert.equal(projected.errorCode, "export_too_large");
          assert.deepEqual(projected.detail, {
            code: expected,
            observed: error.detail.observed,
            limit: error.detail.limit,
          });
          // Numbers, not prose: the detail stays quotable into a receipt.
          assert.equal(Number.isSafeInteger(projected.detail.observed), true);
          assert.equal(Number.isSafeInteger(projected.detail.limit), true);
          assert.equal(projected.detail.observed > projected.detail.limit, true);
          assert.equal(JSON.stringify(projected).includes(files.root), false);
          return true;
        },
      );
    }

    // A detail is only ever a member of the closed vocabulary. Anything else,
    // including a code carrying a real path, is dropped rather than relayed.
    const forged = new LocalContributionPreparationError("export_too_large", {
      detail: { code: `leaked_${files.root}`, observed: 2, limit: 1 },
    });
    assert.equal(forged.detail, null);
    const forgedProjection = projectLocalContributionPreparationError(forged);
    assert.equal(Object.hasOwn(forgedProjection, "detail"), false);
    assert.equal(JSON.stringify(forgedProjection).includes(files.root), false);

    // A failure with no bound behind it says nothing rather than guessing.
    assert.equal(
      Object.hasOwn(
        projectLocalContributionPreparationError(
          new LocalContributionPreparationError("no_safe_records"),
        ),
        "detail",
      ),
      false,
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("identical latest evidence produces identical prepared manifests and queue identities", async () => {
  const files = await fixture();
  try {
    await runPreparation(files, UUID_ONE);
    await runPreparation(files, UUID_TWO);
    const firstManifest = await readFile(
      join(
        files.preparedSpoolDirectory,
        `prepared-set-${UUID_ONE}`,
        PREPARED_CONTRIBUTION_SET_MANIFEST,
      ),
      "utf8",
    );
    const secondManifest = await readFile(
      join(
        files.preparedSpoolDirectory,
        `prepared-set-${UUID_TWO}`,
        PREPARED_CONTRIBUTION_SET_MANIFEST,
      ),
      "utf8",
    );
    assert.equal(secondManifest, firstManifest);
    const discovered = await discoverCommittedPreparedSets({
      directory: files.preparedSpoolDirectory,
    });
    assert.equal(discovered.length, 2);
    assert.equal(discovered[0].preparedSetId, discovered[1].preparedSetId);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("an injected preparation storage owns directory publication, recovery, and identity failures", async () => {
  const files = await fixture();
  const injected = injectedPreparationStorage(files);
  let crash = true;
  let overrideCalls = 0;
  try {
    assert.throws(
      () => createLocalContributionPreparationRunner({
        storage: { ...injected.storage },
        storageValidator: injected.isStorage,
      }),
      /local contribution preparation storage is invalid/u,
    );
    assert.throws(
      () => createLocalContributionPreparationRunner({
        storage: {},
        storageValidator: () => true,
      }),
      /local contribution preparation storage/u,
    );

    const runner = injectedPreparationRunner(files, injected, {
      failpoint: async (name) => {
        if (crash && name === "after_review_pair") {
          throw new Error("simulated process interruption");
        }
      },
      renameDirectory: async () => {
        overrideCalls += 1;
        throw new Error("untrusted rename override");
      },
      syncParentDirectory: async () => {
        overrideCalls += 1;
        throw new Error("untrusted sync override");
      },
    });

    await assert.rejects(
      runner(),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed",
    );
    assert.equal(overrideCalls, 0);
    assert.ok(injected.calls.some(([name]) => name === "prepareOwnerOnlyDirectory"));
    assert.ok(injected.calls.some(([name]) => name === "syncDirectory"));

    crash = false;
    const recovered = await runner();
    assert.equal(recovered.status, "prepared");
    assert.ok(injected.calls.some(([name]) => name === "createOwnerOnlyDirectory"));
    assert.ok(injected.calls.some(([name]) => name === "renameDirectory"));
    assert.equal(overrideCalls, 0);

    const outsideRunner = injectedPreparationRunner(files, injected, {
      reviewArchiveDirectory: join(tmpdir(), "outside-review-root"),
    });
    await assert.rejects(
      outsideRunner(),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "review_archive_invalid",
    );

    injected.swapIdentity();
    const identityRunner = injectedPreparationRunner(files, injected, {
      preparationId: UUID_TWO,
    });
    await assert.rejects(
      identityRunner(),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_failed",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("coverage, owner-only directories, runner injection, and public errors fail closed", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      prepareLatestHourLocalContribution({
        coveredAt: { startAt: null, endAt: null },
      }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "coverage_unavailable",
    );

    await mkdir(files.preparedSpoolDirectory, {
      recursive: true,
      mode: 0o700,
    });
    if (process.platform !== "win32") {
      await chmod(files.preparedSpoolDirectory, 0o755);
      await assert.rejects(
        runPreparation(files, UUID_ONE),
        (error) => error instanceof LocalContributionPreparationError
          && error.code === "prepared_spool_invalid",
      );
    }

    const hostile = new Error(
      `${files.root} private-session-that-must-not-leak`,
    );
    hostile.code = "SOME_PRIVATE_UPSTREAM_CODE";
    const projected = projectLocalContributionPreparationError(hostile);
    assert.equal(projected.errorCode, "preparation_failed");
    assert.equal(JSON.stringify(projected).includes(files.root), false);
    assert.equal(
      JSON.stringify(projected).includes(
        "private-session-that-must-not-leak",
      ),
      false,
    );

    let coverageCalls = 0;
    const runner = createLocalContributionPreparationRunner({
      async coverageProvider() {
        coverageCalls += 1;
        throw new Error("private coverage provider failure");
      },
    });
    await assert.rejects(
      runner(),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "coverage_unavailable",
    );
    assert.equal(coverageCalls, 1);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    coverageCalls = 0;
    await assert.rejects(
      runner({ signal: alreadyAborted.signal }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_aborted",
    );
    assert.equal(coverageCalls, 0);

    let preparationStarted = false;
    const cooperativeRunner = createLocalContributionPreparationRunner({
      async coverageProvider() {
        return COVERAGE;
      },
      async prepare({ signal }) {
        preparationStarted = true;
        await new Promise((resolveAbort) => {
          signal.addEventListener("abort", resolveAbort, { once: true });
        });
        signal.throwIfAborted();
      },
    });
    const inFlightAbort = new AbortController();
    const inFlightPreparation = cooperativeRunner({
      signal: inFlightAbort.signal,
    });
    while (!preparationStarted) {
      await new Promise((resolveWait) => setImmediate(resolveWait));
    }
    inFlightAbort.abort();
    await assert.rejects(
      inFlightPreparation,
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "preparation_aborted",
    );

    const selected = [];
    const boundedRunner = createLocalContributionPreparationRunner({
      async coverageProvider() {
        return COVERAGE;
      },
      async prepare(options) {
        selected.push(options);
        return options;
      },
    });
    assert.equal((await boundedRunner()).lookbackHours, 24);
    assert.equal((await boundedRunner({ lookbackHours: 1 })).lookbackHours, 1);
    assert.equal(
      (await boundedRunner({ lookbackHours: 7 * 24 })).lookbackHours,
      7 * 24,
    );
    assert.deepEqual(
      selected.map((value) => value.coveredAt),
      [COVERAGE, COVERAGE, COVERAGE],
    );
    await assert.rejects(
      boundedRunner({ lookbackHours: 2 }),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "coverage_invalid",
    );
  } finally {
    await chmod(files.preparedSpoolDirectory, 0o700).catch(() => {});
    await rm(files.root, { recursive: true });
  }
});
