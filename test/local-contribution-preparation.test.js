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
import { join } from "node:path";
import {
  LocalContributionPreparationError,
  createLocalContributionPreparationRunner,
  prepareLatestHourLocalContribution,
  projectLocalContributionPreparationError,
} from "../src/local-contribution-preparation.js";
import {
  verifyLocalMetadataBundleFiles,
} from "../src/bundle-verifier.js";
import {
  discoverCommittedPreparedSets,
} from "../src/contribution-sync-queue.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "../src/telemetry-contribution-builder.js";
import {
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  verifyPreparedContributionSet,
} from "../src/telemetry-prepared-set.js";

const COVERAGE = Object.freeze({
  startAt: "2026-07-24T21:00:00.000Z",
  endAt: "2026-07-24T23:02:00.000Z",
});
const UUID_ONE = "00000000-0000-4000-8000-000000000001";
const UUID_TWO = "00000000-0000-4000-8000-000000000002";

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
    assert.equal(result.networkActivity, false);
    assert.equal(result.includesContent, false);
    assert.equal(result.includesPaths, false);
    assert.equal(result.includesIdentifiers, false);
    assert.equal(result.includesCredentials, false);

    const serializedResult = JSON.stringify(result);
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
    assert.equal((await stat(bundleFile)).mode & 0o077, 0);
    assert.equal((await stat(receiptFile)).mode & 0o077, 0);

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
    assert.equal((await lstat(preparedDirectory)).mode & 0o077, 0);
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
    await chmod(files.preparedSpoolDirectory, 0o755);
    await assert.rejects(
      runPreparation(files, UUID_ONE),
      (error) => error instanceof LocalContributionPreparationError
        && error.code === "prepared_spool_invalid",
    );

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
  } finally {
    await chmod(files.preparedSpoolDirectory, 0o700).catch(() => {});
    await rm(files.root, { recursive: true });
  }
});
