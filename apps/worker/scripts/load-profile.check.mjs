import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FULL_PROFILE,
  deriveLoadProfile,
  latencySummary,
  loopbackOrigin,
  mapConcurrent,
  percentile,
  readOwnerOnlyInvitation,
} from "./load-profile-lib.mjs";

const scriptPath = fileURLToPath(new URL("./load-http-backend.mjs", import.meta.url));

function configuration(overrides = {}) {
  return {
    participants: 25,
    attemptsPerParticipant: 4,
    recordsPerAttempt: 50,
    concurrency: 8,
    hotParticipantCount: 2,
    hotAttemptsPerParticipant: 20,
    enrollmentSpacingMilliseconds: 0,
    requestTimeoutMilliseconds: 30_000,
    allowFullProfile: false,
    ...overrides,
  };
}

test("full profile requires 100,000 attempts to process 20 million records", () => {
  assert.throws(
    () => deriveLoadProfile(configuration({
      ...FULL_PROFILE,
      hotParticipantCount: 0,
      hotAttemptsPerParticipant: FULL_PROFILE.attemptsPerParticipant,
      enrollmentSpacingMilliseconds: 3_100,
    })),
    /allow-full-profile/,
  );
  const profile = deriveLoadProfile(configuration({
    ...FULL_PROFILE,
    concurrency: 25,
    hotParticipantCount: 0,
    hotAttemptsPerParticipant: FULL_PROFILE.attemptsPerParticipant,
    enrollmentSpacingMilliseconds: 3_100,
    allowFullProfile: true,
  }));
  assert.equal(profile.bundleAttempts, 100_000);
  assert.equal(profile.expandedRecords, 20_000_000);
  assert.equal(profile.fullProfileSatisfied, true);
  assert.equal(profile.minimumFullBundleAttempts, 10_000);
});

test("hot participants are included in exact workload arithmetic", () => {
  const profile = deriveLoadProfile(configuration({
    enrollmentSpacingMilliseconds: 3_100,
  }));
  assert.equal(profile.bundleAttempts, 132);
  assert.equal(profile.expandedRecords, 6_600);
  assert.equal(profile.fullProfileSatisfied, false);
});

test("profile dimensions and request timeout fail closed at backend ceilings", () => {
  for (const [field, value] of [
    ["participants", 1_001],
    ["attemptsPerParticipant", 101],
    ["recordsPerAttempt", 201],
    ["concurrency", 51],
    ["hotParticipantCount", 26],
    ["hotAttemptsPerParticipant", 3],
    ["enrollmentSpacingMilliseconds", 60_001],
    ["requestTimeoutMilliseconds", 120_001],
  ]) {
    assert.throws(() => deriveLoadProfile(configuration({ [field]: value })));
  }
  assert.throws(
    () => deriveLoadProfile(configuration({
      participants: 21,
      enrollmentSpacingMilliseconds: 0,
    })),
    /pacing/,
  );
});

test("load origin accepts loopback HTTP only", () => {
  assert.equal(loopbackOrigin("http://127.0.0.1:8792/path?q=1").href, "http://127.0.0.1:8792/");
  assert.equal(loopbackOrigin("http://localhost:8787").href, "http://localhost:8787/");
  for (const value of [
    "https://127.0.0.1:8792",
    "http://192.168.1.10:8792",
    "http://example.com",
    "http://user:password@localhost:8792",
  ]) {
    assert.throws(() => loopbackOrigin(value), /loopback/);
  }
});

test("invitation reader accepts only owner-only regular files without symlink traversal", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-monitor-load-invite-test."));
  const valid = join(directory, "valid.secret");
  const linked = join(directory, "linked.secret");
  const invitation =
    `um_invite_00000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
  try {
    writeFileSync(valid, `${invitation}\n`, { mode: 0o600 });
    assert.equal(readOwnerOnlyInvitation(valid), invitation);
    if (process.platform !== "win32") {
      symlinkSync(valid, linked);
      assert.throws(() => readOwnerOnlyInvitation(linked), /invalid invitation/);
      chmodSync(valid, 0o644);
      assert.throws(() => readOwnerOnlyInvitation(valid), /invalid invitation/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("latency summaries use nearest-rank percentiles without retaining values", () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
  assert.deepEqual(latencySummary([5, 1, 4, 2, 3]), {
    count: 5,
    minimumMs: 1,
    medianMs: 3,
    p95Ms: 5,
    maximumMs: 5,
  });
  assert.deepEqual(latencySummary([]), {
    count: 0,
    minimumMs: null,
    medianMs: null,
    p95Ms: null,
    maximumMs: null,
  });
  assert.throws(() => latencySummary([1, Number.NaN]));
});

test("bounded concurrent mapping preserves order and never exceeds the ceiling", async () => {
  let active = 0;
  let maximumActive = 0;
  const result = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [8, 6, 4, 2]);
  assert.equal(maximumActive, 2);
});

test("profile-only command is deterministic, content-free, and performs no requests", () => {
  const run = spawnSync(process.execPath, [scriptPath, "--profile-only"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.status, "profile");
  assert.equal(receipt.participants, 1_000);
  assert.equal(receipt.bundleAttempts, 100_000);
  assert.equal(receipt.expandedRecords, 20_000_000);
  assert.equal(receipt.enrollmentSpacingMilliseconds, 3_100);
  assert.equal(receipt.minimumEnrollmentDurationMilliseconds, 3_096_900);
  assert.equal(receipt.executesNetworkRequests, false);
  assert.equal(run.stderr, "");
});

test("network run rejects unsafe admission before requests", () => {
  const unpaced = spawnSync(process.execPath, [
    scriptPath,
    "--participants", "21",
    "--attempts-per-participant", "1",
    "--records-per-attempt", "1",
    "--concurrency", "1",
    "--hot-participant-count", "0",
    "--hot-attempts-per-participant", "1",
  ], { encoding: "utf8" });
  assert.equal(unpaced.status, 1);
  assert.equal(
    unpaced.stderr,
    "The backend load runner stopped at a fixed configuration or receipt boundary\n",
  );
  assert.equal(unpaced.stdout, "");
});

test("runner source exposes only a privacy-bounded receipt output path", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/u);
  assert.doesNotMatch(source, /process\.(?:stdout|stderr)\.write\([^)]*(?:cookie|csrfToken|recoveryCode|uploadAuthorization|participantId)/u);
  assert.match(source, /publicResultsOnly: true/u);
  assert.match(source, /credentialsPrinted: false/u);
  assert.match(source, /participantIdentifiersPrinted: false/u);
});
