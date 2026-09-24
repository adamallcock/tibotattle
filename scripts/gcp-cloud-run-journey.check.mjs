#!/usr/bin/env node

/**
 * Focused local checks for the destructive/restore gates in
 * gcp-cloud-run-journey.mjs. These use a content-free HTTP double and only
 * exercise the runner's public refusal semantics; the live qualification still
 * requires the real Cloud Run host and restored deployment.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectAllowancePreview,
  expectErasedAllowancePreview,
  collectionControlsAlreadyEnabled,
  journeyTargetDay,
  legacyPartialCleanupSeedFixtureFromNow,
  runMaintenanceUntilPublished,
  targetBaseSlot,
} from "./gcp-cloud-run-journey.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "gcp-cloud-run-journey.mjs");
const TTL_MS = 30 * 60 * 1_000;
const DAY_MS = 86_400 * 1_000;
const JOURNEY_HISTORY_DAY_COUNT = 5;
const JOURNEY_POSITIVE_FIT_DAY_COUNT = 3;

function iso(epoch) {
  return new Date(epoch).toISOString();
}

function addDays(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS)
    .toISOString().slice(0, 10);
}

function journeyHistoryDays(targetDay) {
  return Array.from(
    { length: JOURNEY_HISTORY_DAY_COUNT },
    (_, index) => addDays(targetDay, -(JOURNEY_HISTORY_DAY_COUNT - 1 - index)),
  );
}

function journeyPositiveFitDays(targetDay) {
  return Array.from(
    { length: JOURNEY_POSITIVE_FIT_DAY_COUNT },
    (_, index) => addDays(targetDay, -(JOURNEY_POSITIVE_FIT_DAY_COUNT - 1 - index)),
  );
}

function journeyDay(now) {
  return journeyTargetDay(now);
}

function targetSlot(day, now) {
  return targetBaseSlot(day, now);
}

function fixture(now) {
  const issuedAt = now - 60_000;
  return {
    schemaVersion: "gcp-test-owner-fixture-v1",
    ownerLabel: "synthetic-admin-check",
    participantId: "participant:journey-owner-check",
    identityLinkKey: "a".repeat(64),
    ownerDigest: "b".repeat(64),
    attributionNamespace: "c".repeat(64),
    accessTokenId: "journey-access-check",
    accessTokenSecret: "A".repeat(43),
    recoveryTokenId: "journey-recovery-check",
    recoveryTokenSecret: "B".repeat(43),
    sessionId: "11111111-1111-4111-8111-111111111111",
    sessionSecret: "C".repeat(43),
    issuedAt: iso(issuedAt),
    expiresAt: iso(issuedAt + TTL_MS),
    consentVersion: "consent-v1",
  };
}

function ownerCookie(value) {
  return `__Host-usage_monitor_session=um_session_${value.sessionId}.${value.sessionSecret}`;
}

function seedState(now, baseOrigin, workloadExpiresAt) {
  const day = journeyDay(now);
  const ownerCreatedAt = iso(now - 7 * DAY_MS);
  const deviceExpiresAt = iso(now + 10 * 60_000);
  const participantId = "participant:journey-workload-check";
  return {
    schemaVersion: "gcp-http-journey-state-v1",
    phase: "erased",
    baseOrigin,
    seedFixture: {
      capturedAt: iso(now),
      day,
      baseSlot: targetSlot(day, now),
    },
    ownerCreatedAt,
    updatedAt: iso(now),
    workload: {
      participantId,
      cookie: "workload-cookie-check",
      csrfToken: "workload-csrf-check",
      participantCreatedAt: iso(now - 6 * DAY_MS),
      expiresAt: workloadExpiresAt,
      consentVersion: "privacy-safe-telemetry-v0.1",
    },
    device: {
      id: "22222222-2222-4222-8222-222222222222",
      secret: "D".repeat(43),
      pairingCode: "pairing-check",
      authorization: "Device journey-device-check",
      expiresAt: deviceExpiresAt,
    },
    deviceV12: {
      id: "33333333-3333-4333-8333-333333333333",
      secret: "E".repeat(43),
      pairingCode: "pairing-v12-check",
      authorization: "Device journey-device-v12-check",
      expiresAt: deviceExpiresAt,
    },
    v1: { day, chunk: {}, raw: "", first: {} },
    v11: { chunks: [], receipts: [], sync: {} },
    v12: { fixture: {}, chunks: [], receipts: [], raw: "", first: {}, replay: {} },
    erasureAt: iso(now - 2 * 60 * 60_000),
    uploadAuthorization: null,
  };
}

function json(response, status, value, headers = {}) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

async function startDouble(fixtureValue, { cleanup = false, controlsEnabled = false, enrollment = false } = {}) {
  const observed = {
    v1DeviceStateRequests: 0,
    v11CapabilityRequests: 0,
    v12CapabilityRequests: 0,
    allowancePreviewRequests: 0,
    healthRequests: 0,
    ownerSessionRequests: 0,
    enrollmentRequests: 0,
    adminActionRequests: 0,
    overviewRequests: 0,
    progressRequests: 0,
    emptyMaintenanceRequests: 0,
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const cookie = request.headers.cookie ?? "";
    if (path === "/api/ready") return json(response, 200, {
      status: "ready",
      provider: "postgres",
      checks: {
        schema: "compatible",
        primary: "reachable",
        independentLedger: "reconciled",
      },
    });
    if (path === "/api/health") {
      observed.healthRequests += 1;
      return json(response, 200, {
        status: "ok",
        mode: "synthetic-and-private-telemetry",
        provider: "postgres",
        checks: {
          database: "ok",
          deletionLedger: "ok",
          encryptedObjectStore: "reachable",
          lifecycle: "completed",
          schema: "compatible",
          independentLedger: "reconciled",
          quarantineRetentionComplete: true,
          restoreReplayComplete: true,
        },
        ...(controlsEnabled ? {
          collectionControls: {
            state: "operational",
            enrollment: true,
            uploadRegistration: true,
            processing: true,
            publication: true,
          },
        } : {}),
      });
    }
    if (path === "/api/v1/session" && cookie.includes(ownerCookie(fixtureValue))) {
      observed.ownerSessionRequests += 1;
      return json(response, 200, {
        participantId: fixtureValue.participantId,
        createdAt: fixtureValue.__ownerCreatedAt,
        expiresAt: fixtureValue.expiresAt,
        consentVersion: fixtureValue.consentVersion,
      });
    }
    if (path === "/api/v1/enroll" && enrollment) {
      observed.enrollmentRequests += 1;
      return json(response, 201, {
        participantId: "participant:journey-enrolled-check",
        csrfToken: "journey-enrollment-csrf-check",
      }, {
        "set-cookie": "__Host-usage_monitor_session=um_session_22222222-2222-4222-8222-222222222222.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
    }
    if (path === "/api/v1/community/daily") {
      return json(response, 200, {
        schemaVersion: "community-daily-read-v1.0",
        from: fixtureValue.__firstDay,
        to: fixtureValue.__lastDay,
        allowanceState: "ready",
        days: [],
      });
    }
    if (path === "/api/v1/admin/overview") {
      observed.overviewRequests += 1;
      return json(response, 200, {
        contributions: {
          contributingAccounts: {
            total: 0,
            bounded: false,
            acceptedLast24Hours: 0,
            acceptedLast7Days: 0,
            acceptedLast30Days: 0,
          },
          incrementalChunks: {
            total: 0,
            current: 0,
            bounded: false,
            acceptedLast24Hours: 0,
            acceptedLast7Days: 0,
          },
          acceptedLast24Hours: 0,
          acceptedLast7Days: 0,
          latestAcceptedAt: null,
          storedTelemetryRecords: 0,
          storedTelemetryRecordsBounded: false,
        },
        dailyPublication: {
          latestEvidenceDay: null,
          latestReleasedAt: null,
          pendingRebuilds: 0,
          pendingRebuildsBounded: false,
        },
        historicalPublication: {
          publishedDays: 0,
          publishedDaysBounded: false,
          latestEvidenceDay: null,
          latestComputedAt: null,
          previewState: "not_published",
          previewGeneratedAt: null,
        },
      });
    }
    if (path === "/api/v1/admin/action") {
      observed.adminActionRequests += 1;
      const actionNumber = observed.emptyMaintenanceRequests;
      observed.emptyMaintenanceRequests += 1;
      if (cleanup && actionNumber === 0) {
        return json(response, 200, {
          schemaVersion: "admin-action-v0.1",
          action: "run_maintenance",
          result: {
            task: "participant_erasure",
            operationId: "journey-cleanup-erasure",
            deleted: true,
            alreadyDeleted: false,
            contributionsDeleted: 0,
          },
        });
      }
      if (cleanup && actionNumber === 1) {
        return json(response, 200, {
          schemaVersion: "admin-action-v0.1",
          action: "run_maintenance",
          result: {
            task: "participant_erasure",
            operationId: "journey-cleanup-erasure",
            deleted: true,
            alreadyDeleted: true,
            contributionsDeleted: 0,
          },
        });
      }
      return json(response, 200, {
        schemaVersion: "admin-action-v0.1",
        action: "run_maintenance",
        result: {
          code: "ANALYTICS_REBUILD_EMPTY",
          lifecycleComplete: true,
          quarantineRetentionComplete: true,
          restoreReplayComplete: true,
          quarantineReconciliationComplete: true,
          aggregateRebuildComplete: true,
          aggregateRebuildDelegated: false,
          publicationEnabled: true,
        },
      });
    }
    if (path === "/api/v1/admin/reconstruction-progress") {
      observed.progressRequests += 1;
      return json(response, 200, {
        schemaVersion: "admin-reconstruction-progress-v0.1",
        observedAt: iso(Date.now()),
        mode: "resumable",
        status: "available",
        lookup: { complete: true, lastRecordId: 0, throughRecordId: 0 },
        calculations: {
          trackedAccounts: 0,
          completedAccounts: 0,
          preparingAccounts: 0,
          scanningAccounts: 0,
          finalizingAccounts: 0,
          sourceChangedAccounts: 0,
          checkpointsWritten: 0,
          bounded: false,
          newestResultAt: null,
        },
        maintenance: { running: false, lastRunAt: null, leaseExpiresAt: null },
        publication: {
          state: "ready",
          pendingDays: 0,
          pendingDaysBounded: false,
          publishedDays: 0,
          pricedDays: 0,
          latestPublishedAt: null,
        },
      });
    }
    if (path === "/api/v1/admin/community/allowance-preview") {
      observed.allowancePreviewRequests += 1;
      return json(response, 503, { error: { code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" } });
    }
    if (path === "/api/v1/device/sync/state") {
      observed.v1DeviceStateRequests += 1;
      return json(response, 401, { error: { code: "AUTH_INVALID" } });
    }
    if (path === "/api/v1/device/sync-capabilities") {
      observed.v11CapabilityRequests += 1;
      return json(response, 401, { error: { code: "AUTH_INVALID" } });
    }
    if (path === "/api/v1/device/sync-capabilities-v1.2") {
      observed.v12CapabilityRequests += 1;
      return json(response, 401, { error: { code: "AUTH_INVALID" } });
    }
    if (path === "/api/v1/me/export"
        || path === "/api/v1/session") {
      return json(response, 401, { error: { code: "AUTH_INVALID" } });
    }
    return json(response, 404, { error: { code: "NOT_FOUND" } });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && Number.isInteger(address.port));
  return { server, origin: `http://127.0.0.1:${address.port}`, observed };
}

async function runCase({ naturalExpiry }) {
  const now = Date.now();
  const ownerFixture = fixture(now);
  const day = journeyDay(now);
  const baseFixture = {
    ...ownerFixture,
    __ownerCreatedAt: iso(now - 7 * DAY_MS),
    __firstDay: addDays(day, -4),
    __lastDay: day,
  };
  const workloadExpiresAt = iso(now + (naturalExpiry ? -60_000 : 10 * 60_000));
  const stateValue = seedState(now, "http://127.0.0.1:0", workloadExpiresAt);
  const started = await startDouble(baseFixture);
  const stateDir = await mkdtemp(join(tmpdir(), "gcp-journey-check-"));
  await chmod(stateDir, 0o700);
  const fixturePath = join(stateDir, "fixture.json");
  const statePath = join(stateDir, "journey-state-v1.json");
  await writeFile(fixturePath, JSON.stringify(ownerFixture), { mode: 0o600 });
  await writeFile(statePath, JSON.stringify({ ...stateValue, baseOrigin: started.origin }), { mode: 0o600 });
  const environment = {
    ...process.env,
    JOURNEY_BASE_URL: started.origin,
    JOURNEY_RESTORED_BASE_URL: started.origin,
    JOURNEY_ID_TOKEN: "a.a.a",
    JOURNEY_PHASE: "verify",
    JOURNEY_STATE_DIR: stateDir,
    ADMIN_OWNER_FIXTURE_FILE: fixturePath,
  };
  delete environment.JOURNEY_GCLOUD_IAM_TOKEN;
  let child;
  try {
    child = await new Promise((resolve) => {
      const processValue = spawn(process.execPath, [RUNNER], {
        cwd: join(dirname(RUNNER), ".."),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      processValue.stdout.on("data", (chunk) => { stdout += chunk; });
      processValue.stderr.on("data", (chunk) => { stderr += chunk; });
      processValue.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, child.stderr);
    const result = JSON.parse(lines.at(-1));
    if (naturalExpiry) {
      assert.equal(child.code, 1, child.stdout);
      assert.equal(result.status, "inconclusive", child.stdout);
      assert.equal(result.qualified, false, child.stdout);
      assert.equal(result.phases.at(-1)?.name, "restored-owner-admission", child.stdout);
      assert.equal(result.phases.at(-1)?.status, "inconclusive", child.stdout);
      assert.equal(result.phases.at(-1)?.metadata?.credentialNaturallyExpired, true, child.stdout);
    } else {
      assert.equal(child.code, 0, `${child.stdout}\n${child.stderr}`);
      assert.equal(result.status, "ok", child.stdout);
      assert.equal(result.qualified, true, child.stdout);
      assert.equal(result.phases.at(-1)?.status, "passed", child.stdout);
      assert.equal(started.observed.v1DeviceStateRequests, 1, child.stdout);
      assert.equal(started.observed.v11CapabilityRequests, 1, child.stdout);
      assert.equal(started.observed.v12CapabilityRequests, 1, child.stdout);
      assert.equal(started.observed.allowancePreviewRequests, 1, child.stdout);
      assert.equal(started.observed.healthRequests, 2, child.stdout);
      assert.equal(started.observed.overviewRequests, 1, child.stdout);
      assert.equal(started.observed.progressRequests, 1, child.stdout);
      assert.equal(started.observed.emptyMaintenanceRequests, 1, child.stdout);
    }
    return result;
  } finally {
    started.server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function runPartialCleanupCase() {
  const now = Date.now();
  const ownerFixture = fixture(now);
  const day = journeyDay(now);
  const baseFixture = {
    ...ownerFixture,
    __ownerCreatedAt: iso(now - 7 * DAY_MS),
    __firstDay: addDays(day, -4),
    __lastDay: day,
  };
  // This mirrors the real interrupted seed: v1 has completed, v1.1 consent
  // is the last recorded phase, and no v1.1/v1.2 capability was persisted.
  // The workload session is expired, while the owner fixture remains live.
  const stateValue = seedState(now, "http://127.0.0.1:0", iso(now - 60_000));
  // This is the journal shape produced before the rich fixture widened from
  // a 10-hour to a 20-hour cadence. Cleanup must recover it without making
  // the stricter current seed/check/erase/verify readers permissive.
  const legacyCaptureAt = Date.parse(`${journeyDay(now)}T21:00:00.000Z`);
  stateValue.seedFixture = legacyPartialCleanupSeedFixtureFromNow(legacyCaptureAt);
  assert.notEqual(
    stateValue.seedFixture.baseSlot,
    targetSlot(stateValue.seedFixture.day, legacyCaptureAt),
    "legacy cleanup fixture must exercise the old cadence",
  );
  stateValue.phase = "seed-progress";
  stateValue.progress = "v11-consent";
  stateValue.deviceV12 = null;
  stateValue.v11 = null;
  stateValue.v12 = null;
  stateValue.erasureAt = null;
  const started = await startDouble(baseFixture, { cleanup: true });
  const stateDir = await mkdtemp(join(tmpdir(), "gcp-journey-cleanup-check-"));
  await chmod(stateDir, 0o700);
  const fixturePath = join(stateDir, "fixture.json");
  const statePath = join(stateDir, "journey-state-v1.json");
  await writeFile(fixturePath, JSON.stringify(ownerFixture), { mode: 0o600 });
  await writeFile(statePath, JSON.stringify({ ...stateValue, baseOrigin: started.origin }), { mode: 0o600 });
  const environment = {
    ...process.env,
    JOURNEY_BASE_URL: started.origin,
    JOURNEY_ID_TOKEN: "a.a.a",
    JOURNEY_PHASE: "cleanup",
    JOURNEY_STATE_DIR: stateDir,
    ADMIN_OWNER_FIXTURE_FILE: fixturePath,
  };
  delete environment.JOURNEY_RESTORED_BASE_URL;
  delete environment.JOURNEY_GCLOUD_IAM_TOKEN;
  let child;
  try {
    child = await new Promise((resolve) => {
      const processValue = spawn(process.execPath, [RUNNER], {
        cwd: join(dirname(RUNNER), ".."),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      processValue.stdout.on("data", (chunk) => { stdout += chunk; });
      processValue.stderr.on("data", (chunk) => { stderr += chunk; });
      processValue.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(child.code, 0, `${child.stdout}\n${child.stderr}`);
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, child.stderr);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.status, "ok", child.stdout);
    // Cleanup is a recovery operation, never a qualification claim. The
    // runner must finish it successfully while leaving the full journey gate
    // false because no restore phase was proven.
    assert.equal(result.qualified, false, child.stdout);
    assert.equal(result.phase, "cleanup", child.stdout);
    assert.equal(result.phases.at(-1)?.name, "ready-after", child.stdout);
    assert.equal(result.phases.at(-1)?.status, "passed", child.stdout);
    assert.equal(started.observed.v1DeviceStateRequests, 1, child.stdout);
    assert.equal(started.observed.v11CapabilityRequests, 0, child.stdout);
    assert.equal(started.observed.v12CapabilityRequests, 0, child.stdout);
    assert.equal(started.observed.allowancePreviewRequests, 1, child.stdout);
    assert.equal(started.observed.healthRequests, 1, child.stdout);
    assert.equal(started.observed.overviewRequests, 1, child.stdout);
    assert.equal(started.observed.progressRequests, 1, child.stdout);
    assert.equal(started.observed.emptyMaintenanceRequests, 3, child.stdout);
  } finally {
    started.server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function runAlreadyEnabledControlsSeedCase() {
  const now = Date.now();
  const ownerFixture = fixture(now);
  const baseFixture = {
    ...ownerFixture,
    __ownerCreatedAt: iso(now - 7 * DAY_MS),
    __firstDay: journeyDay(now),
    __lastDay: journeyDay(now),
  };
  const started = await startDouble(baseFixture, { controlsEnabled: true, enrollment: true });
  const stateDir = await mkdtemp(join(tmpdir(), "gcp-journey-enabled-controls-check-"));
  await chmod(stateDir, 0o700);
  const fixturePath = join(stateDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify(ownerFixture), { mode: 0o600 });
  const environment = {
    ...process.env,
    JOURNEY_BASE_URL: started.origin,
    JOURNEY_ID_TOKEN: "a.a.a",
    JOURNEY_PHASE: "seed",
    JOURNEY_STOP_AFTER: "workload-enroll",
    JOURNEY_STATE_DIR: stateDir,
    ADMIN_OWNER_FIXTURE_FILE: fixturePath,
  };
  delete environment.JOURNEY_RESTORED_BASE_URL;
  delete environment.JOURNEY_GCLOUD_IAM_TOKEN;
  let child;
  try {
    child = await new Promise((resolve) => {
      const processValue = spawn(process.execPath, [RUNNER], {
        cwd: join(dirname(RUNNER), ".."),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      processValue.stdout.on("data", (chunk) => { stdout += chunk; });
      processValue.stderr.on("data", (chunk) => { stderr += chunk; });
      processValue.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(child.code, 0, `${child.stdout}\n${child.stderr}`);
    const lines = child.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, child.stderr);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.status, "stopped", child.stdout);
    assert.equal(result.qualified, false, child.stdout);
    const ownerControls = result.phases.find((phase) => phase.name === "owner-controls");
    assert.equal(ownerControls?.status, "passed", child.stdout);
    assert.equal(ownerControls?.metadata?.controlUpdate, "skipped_already_enabled", child.stdout);
    assert.ok(result.phases.some((phase) => phase.name === "workload-enroll" && phase.status === "passed"), child.stdout);
    assert.equal(started.observed.healthRequests, 1, child.stdout);
    assert.equal(started.observed.ownerSessionRequests, 1, child.stdout);
    assert.equal(started.observed.adminActionRequests, 0, child.stdout);
    assert.equal(started.observed.enrollmentRequests, 1, child.stdout);
  } finally {
    started.server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function allowancePreview({ scalarDays, scalarHistory = true, currentModel = false }) {
  const targetDay = "2026-09-20";
  const previewToDay = addDays(targetDay, 1);
  const expectedDays = journeyHistoryDays(targetDay);
  const scalarDaysInPreview = [...expectedDays, previewToDay];
  const positiveDays = new Set(journeyPositiveFitDays(targetDay));
  const scalarPositiveDays = new Set(
    scalarDays && scalarHistory ? [targetDay, previewToDay]
      : scalarDays ? [previewToDay] : [],
  );
  const modelDay = (day) => positiveDays.has(day) ? ({
    day,
    catalogVersion: "admin-model-roster-v0.3",
    values: [["gpt-5.6-sol", 1_234, 1]],
    fittedParticipantCount: 1,
    unstableParticipantCount: 0,
    staleParticipantCount: 0,
    refusedParticipantCount: 0,
    v1ParticipantCount: 1,
    unsupportedSourceParticipantCount: 0,
  }) : ({
    day,
    catalogVersion: "admin-model-roster-v0.3",
    values: [],
    fittedParticipantCount: 0,
    unstableParticipantCount: 0,
    staleParticipantCount: 0,
    refusedParticipantCount: 0,
    v1ParticipantCount: 0,
    unsupportedSourceParticipantCount: 0,
  });
  const emptySummary = {
    fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null,
  };
  const positiveSummary = {
    fitCount: 1, participantCount: 1, centralUsd: 1_234, band80Usd: null,
  };
  return {
    status: 200,
    body: {
      schemaVersion: "admin-community-allowance-preview-v0.3",
      generatedAt: `${previewToDay}T23:59:59.999Z`,
      from: addDays(previewToDay, -69),
      to: previewToDay,
      coverage: {
        uploadingParticipantCount: 1,
        cachedParticipantCount: 1,
        recentFittedParticipantCount: 1,
        mergeEligibleParticipantCount: 1,
        noQualifyingFitParticipantCount: 0,
        noRecentFitParticipantCount: 0,
        unsupportedPlanParticipantCount: 0,
      },
      models: {
        basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
        gate: "shared_composition_kernel_identification",
        days: [
          ...expectedDays.map(modelDay),
          ...(currentModel ? [{ ...modelDay(targetDay), day: previewToDay }] : []),
        ],
      },
      days: scalarDaysInPreview.map((day) => scalarPositiveDays.has(day) ? ({
        day,
        combined: positiveSummary,
        byPlanType: { pro: positiveSummary, prolite: emptySummary, plus: emptySummary },
      }) : ({
        day,
        combined: emptySummary,
        byPlanType: { pro: emptySummary, prolite: emptySummary, plus: emptySummary },
      })),
    },
  };
}

function checkAllowanceScalarGate() {
  assert.throws(
    () => expectAllowancePreview(allowancePreview({ scalarDays: false }), "2026-09-20"),
    /OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE/u,
    "positive model tuples must not qualify an empty scalar day series",
  );
  assert.throws(
    () => expectAllowancePreview(
      allowancePreview({ scalarDays: true, scalarHistory: false }),
      "2026-09-20",
    ),
    /OWNER_ALLOWANCE_SCALAR_FIT_UNAVAILABLE/u,
    "a current scalar fit without a historical positive day must not qualify",
  );
  const metadata = expectAllowancePreview(allowancePreview({ scalarDays: true }), "2026-09-20");
  assert.equal(metadata.scalarDays, 2);
  assert.deepEqual(metadata.scalarPositiveDays, ["2026-09-20", "2026-09-21"]);
  const currentModelMetadata = expectAllowancePreview(
    allowancePreview({ scalarDays: true, currentModel: true }),
    "2026-09-20",
  );
  assert.equal(currentModelMetadata.modelDays, 4);
}

function checkErasedAllowanceGate() {
  const targetDay = "2026-09-20";
  const expectedDays = journeyHistoryDays(targetDay);
  const emptySummary = { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
  const empty = {
    status: 200,
    body: {
      schemaVersion: "admin-community-allowance-preview-v0.3",
      coverage: {
        uploadingParticipantCount: 0,
        cachedParticipantCount: 0,
        recentFittedParticipantCount: 0,
        mergeEligibleParticipantCount: 0,
        noQualifyingFitParticipantCount: 0,
        noRecentFitParticipantCount: 0,
        unsupportedPlanParticipantCount: 0,
      },
      models: {
        basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
        gate: "shared_composition_kernel_identification",
        days: expectedDays.map((day) => ({ day, values: [] })),
      },
      days: expectedDays.map((day) => ({
        day,
        combined: emptySummary,
        byPlanType: { pro: emptySummary, prolite: emptySummary, plus: emptySummary },
      })),
    },
  };
  assert.equal(expectErasedAllowancePreview(empty, targetDay).status, "empty");
  const cacheProof = {
    backendHealthy: true,
    cacheAbsent: true,
    cohortEmpty: true,
    progressComplete: true,
    emptyMaintenance: true,
  };
  assert.throws(
    () => expectErasedAllowancePreview({
      status: 503,
      body: { error: { code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" } },
    }, targetDay),
    /OWNER_ERASURE_ALLOWANCE_CACHE_PROOF_MISSING/u,
  );
  assert.equal(expectErasedAllowancePreview({
    status: 503,
    body: { error: { code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" } },
  }, targetDay, cacheProof).status, "unavailable");
  assert.throws(
    () => expectErasedAllowancePreview({
      status: 503,
      body: { error: { code: "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE" } },
    }, targetDay, cacheProof),
    /OWNER_ERASURE_ALLOWANCE_STORAGE_UNAVAILABLE/u,
  );
  assert.throws(
    () => expectErasedAllowancePreview(allowancePreview({ scalarDays: true }), targetDay),
    /OWNER_ERASURE_ALLOWANCE_REMAINS/u,
  );
}

const owner = Object.freeze({ cookie: "owner-cookie", csrfToken: "owner-csrf" });

function schedulerResponse(result) {
  return {
    status: 200,
    body: {
      schemaVersion: "admin-action-v0.1",
      action: "run_maintenance",
      result,
    },
  };
}

function progressResponse(overrides = {}) {
  return {
    status: 200,
    body: {
      schemaVersion: "admin-reconstruction-progress-v0.1",
      observedAt: "2026-09-22T00:00:00.000Z",
      mode: "resumable",
      status: "available",
      lookup: {
        complete: false,
        lastRecordId: 1,
        throughRecordId: 4,
      },
      calculations: {
        trackedAccounts: 1,
        completedAccounts: 0,
        preparingAccounts: 1,
        scanningAccounts: 0,
        finalizingAccounts: 0,
        sourceChangedAccounts: 0,
        checkpointsWritten: 1,
        bounded: false,
        newestResultAt: null,
      },
      maintenance: {
        running: false,
        lastRunAt: null,
        leaseExpiresAt: null,
      },
      publication: {
        state: "updating",
        pendingDays: 1,
        pendingDaysBounded: true,
        publishedDays: 1,
        pricedDays: 1,
        latestPublishedAt: null,
      },
      ...overrides,
    },
  };
}

const incompleteResult = Object.freeze({
  code: "ANALYTICS_REBUILD_DEFERRED",
  aggregateRebuildComplete: false,
  aggregateRebuildDelegated: false,
  publicationEnabled: true,
});
const completeResult = Object.freeze({
  code: "ANALYTICS_REBUILD_PUBLISHED",
  aggregateRebuildComplete: true,
  aggregateRebuildDelegated: false,
  publicationEnabled: true,
});

async function checkMaintenanceConvergence() {
  const calls = [];
  const progressing = [
    schedulerResponse(incompleteResult),
    progressResponse(),
    schedulerResponse(incompleteResult),
    progressResponse({
      lookup: { complete: false, lastRecordId: 2, throughRecordId: 4 },
      calculations: { ...progressResponse().body.calculations, checkpointsWritten: 2 },
    }),
    schedulerResponse(completeResult),
  ];
  const result = await runMaintenanceUntilPublished(async (path, options) => {
    calls.push({ path, options });
    return progressing.shift();
  }, owner, { maxAttempts: 3 });
  assert.equal(result.metadata.attempts.length, 3);
  assert.deepEqual(result.metadata.attempts.map((attempt) => attempt.code), [
    incompleteResult.code,
    incompleteResult.code,
    completeResult.code,
  ]);
  assert.equal(calls.filter((call) => call.path === "/api/v1/admin/reconstruction-progress").length, 2);
  assert.ok(calls.every((call) => call.options.cookie === owner.cookie));
  assert.ok(calls.filter((call) => call.path === "/api/v1/admin/action")
    .every((call) => call.options.csrf === owner.csrfToken));

  const unchangedProgress = progressResponse();
  let unchangedCalls = 0;
  await assert.rejects(
    () => runMaintenanceUntilPublished(async () => {
      unchangedCalls += 1;
      return unchangedCalls % 2 === 1
        ? schedulerResponse(incompleteResult)
        : unchangedProgress;
    }, owner, { maxAttempts: 3 }),
    (error) => error?.code === "OWNER_SCHEDULER_NO_PROGRESS",
  );
  assert.equal(unchangedCalls, 4);

  let unavailableCalls = 0;
  await assert.rejects(
    () => runMaintenanceUntilPublished(async () => {
      unavailableCalls += 1;
      return unavailableCalls === 1
        ? schedulerResponse(incompleteResult)
        : progressResponse({ status: "unavailable" });
    }, owner, { maxAttempts: 3 }),
    (error) => error?.code === "OWNER_SCHEDULER_PROGRESS_UNAVAILABLE",
  );

  let malformedCalls = 0;
  await assert.rejects(
    () => runMaintenanceUntilPublished(async () => {
      malformedCalls += 1;
      return malformedCalls === 1
        ? schedulerResponse(incompleteResult)
        : { status: 200, body: { schemaVersion: "admin-reconstruction-progress-v0.1" } };
    }, owner, { maxAttempts: 3 }),
    (error) => error?.code === "OWNER_SCHEDULER_PROGRESS_INVALID",
  );

  let exhaustedCalls = 0;
  await assert.rejects(
    () => runMaintenanceUntilPublished(async () => {
      exhaustedCalls += 1;
      return exhaustedCalls % 2 === 1
        ? schedulerResponse(incompleteResult)
        : progressResponse({
          lookup: { complete: false, lastRecordId: exhaustedCalls / 2, throughRecordId: 4 },
        });
    }, owner, { maxAttempts: 2 }),
    (error) => error?.code === "OWNER_SCHEDULER_HISTORY_INCOMPLETE",
  );
  assert.equal(exhaustedCalls, 4);
}

checkAllowanceScalarGate();
checkErasedAllowanceGate();
await checkMaintenanceConvergence();
await runCase({ naturalExpiry: true });
await runCase({ naturalExpiry: false });
await runPartialCleanupCase();
const enabledControlsHealth = {
  status: "ok",
  provider: "postgres",
  collectionControls: {
    state: "operational",
    enrollment: true,
    uploadRegistration: true,
    processing: true,
    publication: true,
  },
};
assert.equal(collectionControlsAlreadyEnabled(enabledControlsHealth), true);
for (const [field, value] of [
  ["state", "degraded"],
  ["enrollment", false],
  ["uploadRegistration", false],
  ["processing", false],
  ["publication", false],
]) {
  assert.equal(collectionControlsAlreadyEnabled({
    ...enabledControlsHealth,
    collectionControls: { ...enabledControlsHealth.collectionControls, [field]: value },
  }), false, `must not skip when ${field} differs`);
}
assert.equal(collectionControlsAlreadyEnabled({
  ...enabledControlsHealth,
  status: "unavailable",
}), false);
assert.equal(collectionControlsAlreadyEnabled({
  ...enabledControlsHealth,
  provider: "d1",
}), false);
await runAlreadyEnabledControlsSeedCase();
console.log("gcp-cloud-run-journey focused refusal/restore/control checks passed");
