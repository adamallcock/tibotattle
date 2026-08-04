import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INVITATION_CONFIRMATIONS,
  runRemoteInvitationOperation,
} from "./pilot-invitation.mjs";
import {
  PILOT_CONTROL_CONFIRMATIONS,
  runRemotePilotControl,
} from "./pilot-control.mjs";
import {
  PILOT_SQL_TEMP_CLEANUP_WARNING,
  runRemotePilotSql,
} from "./pilot-operations-lib.mjs";
import {
  checkedInConfig,
  provisionedConfig,
  workerDirectory,
} from "./staging-test-fixtures.mjs";
import { EXPECTED_STAGING_MIGRATIONS } from "./staging-readiness-lib.mjs";

const STAGING_ORIGIN =
  "https://app-usagemonitor-staging.test-account.workers.dev";
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const INVITATION_ID = "12345678-1234-4234-8234-1234567890ab";
const INVITATION_SECRET = "A".repeat(43);
const RECEIPT_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "ffffffff-ffff-4fff-8fff-ffffffffffff",
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function fakeRemote({
  runtimeMode = "invite_only",
  failIssueAfterCommit = false,
  failActiveHealth = false,
  failInviteOnlyContainedHealth = false,
  advanceRevisionOnFailedActiveHealth = false,
  missingDeletionLedger = false,
  missingR2Resource = false,
  missingRequiredSecrets = false,
  pendingDeletionLedgerMigration = false,
} = {}) {
  const config = provisionedConfig();
  const calls = [];
  const callOptions = [];
  const sqlBodies = [];
  const grants = new Map();
  const controls = {
    schema_version: "collection-controls-v0.1",
    control_state: "contained",
    revision: 1,
    enrollment_enabled: 0,
    upload_registration_enabled: 0,
    processing_enabled: 0,
    publication_enabled: 0,
    reason_code: "drill_containment",
  };
  let mode = runtimeMode;
  let issueFailurePending = failIssueAfterCommit;
  let containedHealthFailure = false;
  let revisionAdvancePending = advanceRevisionOnFailedActiveHealth;

  function d1Output(row) {
    return {
      status: 0,
      stdout: JSON.stringify([{ results: row ? [row] : [] }]),
      stderr: "",
    };
  }

  function invitationSql(sql) {
    const insert = /INSERT INTO enrollment_grants[\s\S]*?'([^']+)', x'([0-9a-f]+)', 'issued', '([^']+)', '([^']+)'/u
      .exec(sql);
    if (insert) {
      const [, id, secretHash, issuedAt, expiresAt] = insert;
      const controlsAllowIssuance = controls.control_state === "contained"
        && controls.revision >= 1
        && controls.enrollment_enabled === 0
        && controls.upload_registration_enabled === 0
        && controls.processing_enabled === 0
        && controls.publication_enabled === 0
        && ["initial", "drill_containment"].includes(controls.reason_code);
      if (!controlsAllowIssuance) {
        const existing = grants.get(id);
        return d1Output({
          changed: 0,
          identifier_exists: Number(Boolean(existing)),
          secret_matches: Number(existing?.secretHash === secretHash),
          grant_state: existing?.state ?? "absent",
          expires_at: existing?.expiresAt ?? null,
        });
      }
      if (grants.has(id)) return { status: 1, stdout: "", stderr: "conflict" };
      grants.set(id, {
        id,
        secretHash,
        issuedAt,
        expiresAt,
        state: "issued",
      });
      if (issueFailurePending) {
        issueFailurePending = false;
        return { status: 1, stdout: "", stderr: "lost response" };
      }
      return d1Output({
        changed: 1,
        identifier_exists: 1,
        secret_matches: 1,
        grant_state: "issued",
        expires_at: expiresAt,
      });
    }

    const id = /WHERE id = '([^']+)'/u.exec(sql)?.[1];
    const secretHash = /secret_hash = x'([0-9a-f]+)'/u.exec(sql)?.[1];
    if (!id || !secretHash) return null;
    const grant = grants.get(id);
    if (sql.startsWith("DELETE FROM enrollment_grants")) {
      let removed = 0;
      if (grant?.secretHash === secretHash && grant.state === "issued") {
        grants.delete(id);
        removed = 1;
      }
      const remaining = grants.get(id);
      return d1Output({
        removed,
        identifier_exists: Number(Boolean(remaining)),
        matching_exists: Number(remaining?.secretHash === secretHash),
        matching_state:
          remaining?.secretHash === secretHash ? remaining.state : "absent",
      });
    }
    return grant
      ? d1Output({
        secret_matches: Number(grant.secretHash === secretHash),
        grant_state: grant.state,
        expires_at: grant.expiresAt,
      })
      : d1Output(null);
  }

  function controlSql(sql) {
    if (!sql.includes("FROM collection_controls")) return null;
    if (!sql.startsWith("UPDATE collection_controls")) {
      return d1Output({ ...controls });
    }
    const expectedRevision = Number(
      /AND revision = ([0-9]+)/u.exec(sql)?.[1],
    );
    const active = sql.includes("SET enrollment_enabled = 1");
    const acquiringFence = sql.includes("reason_code = 'maintenance'");
    const releasingFence = sql.includes(
      "SET reason_code = 'drill_containment'",
    );
    const currentlyActive = controls.enrollment_enabled === 1
      && controls.upload_registration_enabled === 1
      && controls.processing_enabled === 1
      && controls.publication_enabled === 0
      && controls.control_state === "degraded";
    const currentlyContained = controls.enrollment_enabled === 0
      && controls.upload_registration_enabled === 0
      && controls.processing_enabled === 0
      && controls.publication_enabled === 0;
    let changed = 0;
    if (acquiringFence
        && controls.revision === expectedRevision
        && controls.reason_code !== "maintenance"
        && currentlyActive) {
      controls.enrollment_enabled = 0;
      controls.upload_registration_enabled = 0;
      controls.processing_enabled = 0;
      controls.publication_enabled = 0;
      controls.control_state = "contained";
      controls.reason_code = "maintenance";
      controls.revision += 1;
      changed = 1;
    } else if (releasingFence
        && controls.revision === expectedRevision
        && controls.reason_code === "maintenance"
        && currentlyContained) {
      controls.reason_code = "drill_containment";
      changed = 1;
    } else if (!acquiringFence
        && !releasingFence
        && controls.revision === expectedRevision
        && controls.reason_code !== "maintenance"
        && (active ? currentlyContained : !currentlyContained)) {
      controls.enrollment_enabled = Number(active);
      controls.upload_registration_enabled = Number(active);
      controls.processing_enabled = Number(active);
      controls.publication_enabled = 0;
      controls.control_state = active ? "degraded" : "contained";
      controls.reason_code = active ? "drill_restore" : "drill_containment";
      controls.revision += 1;
      changed = 1;
    }
    return d1Output({ changed, ...controls });
  }

  function spawn(_command, args, options) {
    calls.push([...args]);
    callOptions.push(options);
    const joined = args.join(" ");
    if (joined === "whoami") {
      return { status: 0, stdout: "authenticated", stderr: "" };
    }
    if (joined === "d1 list --json") {
      const databases = missingDeletionLedger
        ? config.env.staging.d1_databases.filter(
          (entry) => entry.binding === "USAGE_MONITOR_DB",
        )
        : config.env.staging.d1_databases;
      return {
        status: 0,
        stdout: JSON.stringify(databases.map((entry) => ({
          uuid: entry.database_id,
          name: entry.database_name,
        }))),
        stderr: "",
      };
    }
    if (joined === "r2 bucket list") {
      return { status: 0, stdout: "bucket list", stderr: "" };
    }
    if (joined.startsWith("r2 bucket info ")) {
      return missingR2Resource
        ? { status: 1, stdout: "", stderr: "not found" }
        : {
          status: 0,
          stdout: JSON.stringify({
            name: config.env.staging.r2_buckets[0].bucket_name,
          }),
          stderr: "",
        };
    }
    if (joined === "secret list --env staging --format json") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { name: "ENVELOPE_PRIVATE_JWK", type: "secret_text" },
          ...(!missingRequiredSecrets
            ? [{ name: "ENVELOPE_PUBLIC_JWK", type: "secret_text" }]
            : []),
        ]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 migrations list ")) {
      if (pendingDeletionLedgerMigration
          && joined.includes("DELETION_LEDGER")) {
        return {
          status: 0,
          stdout: "Migrations to apply: 0001_deletion_ledger.sql",
          stderr: "",
        };
      }
      return { status: 0, stdout: "No migrations to apply!", stderr: "" };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && args.includes("--command")) {
      const command = args[args.indexOf("--command") + 1];
      if (command.includes("FROM d1_migrations")) {
        return {
          status: 0,
          stdout: JSON.stringify([{
            results: EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB
              .map((name) => ({ name })),
          }]),
          stderr: "",
        };
      }
      if (command.includes("sqlite_master")) {
        return d1Output({
          admission_table: 1,
          admission_guard: 1,
          admission_counter: 1,
          quarantine_reconciliation: 1,
          lifecycle_status: 1,
          primary_cooldown_table: 1,
          primary_participant_cooldown_digest: 1,
          primary_cooldown_digest: 1,
          primary_cooldown_schema_version: 1,
          primary_cooldown_deleted_at: 1,
          primary_cooldown_retain_until: 1,
          primary_cooldown_retention_index: 1,
          primary_cooldown_retention_index_shape: 1,
          primary_cooldown_guard_trigger: 1,
        });
      }
      if (command.includes("FROM collection_controls")) {
        return d1Output({ ...controls });
      }
      return { status: 1, stdout: "", stderr: "unexpected probe" };
    }
    if (joined.startsWith("d1 execute DELETION_LEDGER ")
        && args.includes("--command")) {
      const command = args[args.indexOf("--command") + 1];
      if (command.includes("FROM d1_migrations")) {
        if (pendingDeletionLedgerMigration) {
          return {
            status: 0,
            stdout: JSON.stringify([{
              results: [{ name: "0001_deletion_tombstones.sql" }],
            }]),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{
            results: EXPECTED_STAGING_MIGRATIONS.DELETION_LEDGER
              .map((name) => ({ name })),
          }]),
          stderr: "",
        };
      }
      if (command.includes("sqlite_master")) {
        return d1Output({
          deletion_tombstone_table: 1,
          deletion_tombstone_participant_digest: 1,
          deletion_tombstone_schema_version: 1,
          deletion_tombstone_deleted_at: 1,
          deletion_tombstone_retain_until: 1,
          deletion_tombstone_retention_index: 1,
          deletion_tombstone_retention_index_shape: 1,
          deletion_cooldown_table: 1,
          deletion_cooldown_digest: 1,
          deletion_cooldown_schema_version: 1,
          deletion_cooldown_deleted_at: 1,
          deletion_cooldown_retain_until: 1,
          deletion_cooldown_retention_index: 1,
          deletion_cooldown_retention_index_shape: 1,
        });
      }
      return { status: 1, stdout: "", stderr: "unexpected probe" };
    }
    if (args[0] === "deploy") {
      mode = args.includes("ENROLLMENT_MODE:invite_only")
        ? "invite_only"
        : "disabled";
      return {
        status: 0,
        stdout: `Deployed ${STAGING_ORIGIN}`,
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")) {
      const sqlFile = args[args.indexOf("--file") + 1];
      const sql = readFileSync(sqlFile, "utf8");
      sqlBodies.push(sql);
      return invitationSql(sql) ?? controlSql(sql)
        ?? { status: 1, stdout: "", stderr: "unexpected SQL" };
    }
    throw new Error(`Unexpected fake Wrangler command: ${joined}`);
  }

  function health() {
    const active = controls.enrollment_enabled === 1;
    return {
      status: "ok",
      enrollmentMode: mode,
      collectionControls: {
        state: active ? "degraded" : "contained",
        enrollment: active && mode !== "disabled",
        uploadRegistration: active,
        processing: active,
        publication: false,
      },
      contracts: {
        accountScopedContribution: {
          externalParticipantsAuthorized: false,
        },
      },
      capabilities: {
        encryptedUpload: active,
        delayedAggregateStats: false,
        ongoingDeviceUploadRegistration: active,
      },
    };
  }

  function readiness() {
    return {
      status: "ready",
      checks: {
        lifecycle: "ready",
        lifecycleFresh: true,
        quarantineRetentionComplete: true,
        restoreReplayComplete: true,
        aggregateRebuildComplete: true,
        maintenanceCycleMatched: true,
        quarantineReconciliationComplete: true,
      },
    };
  }

  async function fetchImpl(url) {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/health") {
      if (failActiveHealth && controls.enrollment_enabled === 1) {
        if (revisionAdvancePending) {
          controls.revision += 1;
          revisionAdvancePending = false;
        }
        return jsonResponse({ status: "unavailable" }, 503);
      }
      if (containedHealthFailure && controls.enrollment_enabled === 0) {
        return jsonResponse({ status: "unavailable" }, 503);
      }
      if (failInviteOnlyContainedHealth
          && mode === "invite_only"
          && controls.enrollment_enabled === 0) {
        return jsonResponse({ status: "unavailable" }, 503);
      }
      return jsonResponse(health());
    }
    if (pathname === "/api/ready") return jsonResponse(readiness());
    throw new Error(`Unexpected URL: ${url}`);
  }

  return {
    callOptions,
    calls,
    config,
    controls,
    fetchImpl,
    grants,
    mode: () => mode,
    setContainedHealthFailure: (value) => {
      containedHealthFailure = value;
    },
    spawn,
    sqlBodies,
  };
}

async function ownerDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

function receiptIdSequence() {
  let index = 0;
  return () => RECEIPT_IDS[index++];
}

test("mutations require exact confirmations before commands or files", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-confirm-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  try {
    const invitation = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: "yes",
      config: remote.config,
      invitationFile: join(root, "invite.secret"),
      receiptFile: join(root, "invite.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.deepEqual(invitation, {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
    });

    const control = await runRemotePilotControl({
      action: "activate",
      confirmation: "yes",
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: join(root, "control.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.deepEqual(control, {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
    });
    assert.deepEqual(remote.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local path and configured-resource gates fail before remote inspection", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-local-gates-");
  const actual = join(root, "actual");
  const linked = join(root, "linked");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, linked, "dir");
  try {
    const unsafeRemote = fakeRemote({ runtimeMode: "disabled" });
    const unsafePath = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: unsafeRemote.config,
      invitationFile: join(linked, "invite.secret"),
      receiptFile: join(root, "unsafe-path.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: unsafeRemote.spawn,
      fetchImpl: unsafeRemote.fetchImpl,
    });
    assert.deepEqual(unsafePath, {
      ok: false,
      code: "INVITATION_FILE_INVALID",
    });
    assert.deepEqual(unsafeRemote.calls, []);

    const unprovisionedRemote = fakeRemote({ runtimeMode: "disabled" });
    const unprovisioned = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: checkedInConfig,
      invitationFile: join(root, "unprovisioned.secret"),
      receiptFile: join(root, "unprovisioned.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: unprovisionedRemote.spawn,
      fetchImpl: unprovisionedRemote.fetchImpl,
    });
    assert.deepEqual(unprovisioned, {
      ok: false,
      code: "STAGING_DATABASE_PREFLIGHT_BLOCKED",
      blockers: ["STAGING_CONFIGURATION_BLOCKED"],
    });
    assert.deepEqual(unprovisionedRemote.calls, []);
    await assert.rejects(access(join(root, "unprovisioned.secret")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid operation times fail before remote commands or local artifacts", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-time-gate-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  const invitationFile = join(root, "invalid-time.secret");
  const invitationReceipt = join(root, "invalid-time-invite.receipt.json");
  const controlReceipt = join(root, "invalid-time-control.receipt.json");
  try {
    const invitation = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: invitationReceipt,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: Number.NaN,
    });
    assert.deepEqual(invitation, {
      ok: false,
      code: "INVITATION_TIME_INVALID",
    });

    const control = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: controlReceipt,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: Number.NaN,
    });
    assert.deepEqual(control, {
      ok: false,
      code: "PILOT_OPERATION_TIME_INVALID",
    });
    assert.deepEqual(remote.calls, []);
    await assert.rejects(access(invitationFile));
    await assert.rejects(access(invitationReceipt));
    await assert.rejects(access(controlReceipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pilot widening requires every live secondary resource and migration", async (t) => {
  const cases = [
    {
      name: "deletion ledger resource",
      options: { missingDeletionLedger: true },
      blocker: "D1_RESOURCES_MISSING",
    },
    {
      name: "R2 quarantine resource",
      options: { missingR2Resource: true },
      blocker: "R2_RESOURCE_MISSING",
    },
    {
      name: "required envelope secret",
      options: { missingRequiredSecrets: true },
      blocker: "REQUIRED_STAGING_SECRETS_MISSING",
    },
    {
      name: "deletion ledger migration",
      options: { pendingDeletionLedgerMigration: true },
      blocker: "REMOTE_MIGRATIONS_PENDING",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await ownerDirectory("usage-monitor-pilot-readiness-");
      const remote = fakeRemote({
        runtimeMode: "disabled",
        ...scenario.options,
      });
      const receiptFile = join(root, "blocked.receipt.json");
      try {
        const result = await runRemotePilotControl({
          action: "activate",
          confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
          config: remote.config,
          origin: STAGING_ORIGIN,
          expectedRevision: 1,
          receiptFile,
          wrangler: "/fake/wrangler",
          workerDirectory,
          spawn: remote.spawn,
          fetchImpl: remote.fetchImpl,
          nowEpoch: NOW,
          receiptOperationId: receiptIdSequence(),
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, "STAGING_LIVE_READINESS_BLOCKED");
        assert.equal(result.blockers.includes(scenario.blocker), true);
        assert.equal(
          remote.calls.some((args) => args[0] === "deploy"),
          false,
        );
        assert.equal(
          remote.calls.some((args) =>
            args[0] === "d1"
              && args[1] === "execute"
              && args.includes("--file")),
          false,
        );
        await assert.rejects(access(receiptFile));
        for (const options of remote.callOptions) {
          assert.equal(options.env.WRANGLER_LOG_SANITIZE, "true");
          assert.equal(options.env.WRANGLER_WRITE_LOGS, "false");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("pilot SQL rejects unsafe temp modes before invoking Wrangler", async (t) => {
  const sql = `SELECT schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled
  FROM collection_controls
 WHERE singleton = 1;
`;
  await t.test("group-readable directory", async () => {
    const remote = fakeRemote();
    let temporaryDirectory;
    const result = runRemotePilotSql({
      sql,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fileSystem: {
        mkdtempSync(prefix) {
          temporaryDirectory = mkdtempSync(prefix);
          chmodSync(temporaryDirectory, 0o750);
          return temporaryDirectory;
        },
      },
    });
    assert.deepEqual(result, { ok: false, row: null, warnings: [] });
    assert.deepEqual(remote.calls, []);
    await assert.rejects(access(temporaryDirectory));
  });

  await t.test("group-readable SQL file", async () => {
    const remote = fakeRemote();
    let temporaryDirectory;
    const result = runRemotePilotSql({
      sql,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fileSystem: {
        mkdtempSync(prefix) {
          temporaryDirectory = mkdtempSync(prefix);
          return temporaryDirectory;
        },
        openSync(filename, flags) {
          const descriptor = openSync(filename, flags, 0o600);
          chmodSync(filename, 0o640);
          return descriptor;
        },
      },
    });
    assert.deepEqual(result, { ok: false, row: null, warnings: [] });
    assert.deepEqual(remote.calls, []);
    await assert.rejects(access(temporaryDirectory));
  });
});

test("SQL cleanup failure emits only a bounded actionable warning", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-cleanup-warning-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  const invitationFile = join(root, "invite-cleanup.secret");
  const receiptFile = join(root, "invite-cleanup.receipt.json");
  const temporaryDirectories = [];
  try {
    const result = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fileSystem: {
        mkdtempSync(prefix) {
          const directory = mkdtempSync(prefix);
          temporaryDirectories.push(directory);
          return directory;
        },
        unlinkSync() {
          const error = new Error("simulated cleanup refusal");
          error.code = "EACCES";
          throw error;
        },
      },
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, [PILOT_SQL_TEMP_CLEANUP_WARNING]);
    assert.deepEqual(
      result.receipt.evidence.operationalWarnings,
      [PILOT_SQL_TEMP_CLEANUP_WARNING],
    );
    assert.equal(temporaryDirectories.length, 2);
    for (const temporaryDirectory of temporaryDirectories) {
      assert.equal((await stat(temporaryDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(temporaryDirectory, "operation.sql"))).mode & 0o777,
        0o600,
      );
    }
    const serialized = JSON.stringify(result);
    for (const excluded of [
      ...temporaryDirectories,
      INVITATION_ID,
      INVITATION_SECRET,
      "INSERT INTO enrollment_grants",
      remote.config.env.staging.d1_databases[0].database_id,
    ]) {
      assert.equal(serialized.includes(excluded), false);
    }
  } finally {
    for (const temporaryDirectory of temporaryDirectories) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("remote issuance keeps the capability in an owner-only file and emits a bounded receipt", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-issue-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  const invitationFile = join(root, "invite-0001.secret");
  const receiptFile = join(root, "invite-0001-issued.receipt.json");
  try {
    const result = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile,
      origin: STAGING_ORIGIN,
      expiresInHours: 24,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, "STAGING_INVITATION_ISSUED");
    assert.equal(
      await readFile(invitationFile, "utf8"),
      `um_invite_${INVITATION_ID}.${INVITATION_SECRET}\n`,
    );
    assert.equal((await stat(invitationFile)).mode & 0o777, 0o600);
    assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);

    const receiptText = await readFile(receiptFile, "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(
      receipt.schemaVersion,
      "usage-monitor-pilot-operation-receipt-v0.1",
    );
    assert.equal(receipt.operation, "invitation_issued");
    assert.equal(receipt.collectionAuthorized, false);
    assert.equal(receipt.evidence.invitationCount, 1);
    for (const excluded of [
      INVITATION_ID,
      INVITATION_SECRET,
      `um_invite_${INVITATION_ID}`,
      remote.config.env.staging.d1_databases[0].database_id,
      remote.config.env.staging.r2_buckets[0].bucket_name,
      STAGING_ORIGIN,
    ]) {
      assert.equal(receiptText.includes(excluded), false);
      assert.equal(JSON.stringify(result).includes(excluded), false);
      assert.equal(remote.calls.flat().join(" ").includes(excluded), false);
    }
    const execute = remote.calls.find((args) => args[0] === "d1"
      && args[1] === "execute");
    assert.equal(execute.includes("--file"), true);
    assert.equal(execute.includes("--command"), false);
    await assert.rejects(access(execute[execute.indexOf("--file") + 1]));
    for (const options of remote.callOptions) {
      assert.equal(options.env.WRANGLER_LOG, "log");
      assert.equal(options.env.WRANGLER_LOG_SANITIZE, "true");
      assert.equal(options.env.WRANGLER_WRITE_LOGS, "false");
      assert.equal(
        Object.hasOwn(options.env, "WRANGLER_LOG_PATH"),
        false,
      );
      assert.equal(
        Object.hasOwn(options.env, "WRANGLER_OUTPUT_FILE_DIRECTORY"),
        false,
      );
      assert.equal(
        Object.hasOwn(options.env, "WRANGLER_OUTPUT_FILE_PATH"),
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lost issuance response resumes from the capability file and can roll back idempotently", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-resume-");
  const remote = fakeRemote({ failIssueAfterCommit: true });
  const invitationFile = join(root, "invite-0002.secret");
  try {
    const failed = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "failed.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(failed, {
      ok: false,
      code: "INVITATION_ISSUE_UNVERIFIED",
      recoveryAction: "resume_or_rollback",
    });
    assert.equal(remote.grants.size, 1);
    assert.equal(await readFile(invitationFile, "utf8"), `um_invite_${INVITATION_ID}.${INVITATION_SECRET}\n`);
    await assert.rejects(access(join(root, "failed.receipt.json")));

    const resumed = await runRemoteInvitationOperation({
      action: "resume-issue",
      confirmation: INVITATION_CONFIRMATIONS["resume-issue"],
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "resumed.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.code, "STAGING_INVITATION_ISSUE_RESUMED");

    const rolledBack = await runRemoteInvitationOperation({
      action: "rollback",
      confirmation: INVITATION_CONFIRMATIONS.rollback,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "rollback.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      nowEpoch: NOW + 2,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(rolledBack.ok, true);
    assert.equal(rolledBack.code, "STAGING_INVITATION_ROLLED_BACK");
    assert.equal(remote.grants.size, 0);
    await assert.rejects(access(invitationFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation refuses a redeemed invitation and retains its local recovery file", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-redeemed-");
  const remote = fakeRemote();
  const invitationFile = join(root, "invite-0003.secret");
  try {
    const issued = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "issued.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(issued.ok, true);
    remote.grants.get(INVITATION_ID).state = "redeemed";

    const revoked = await runRemoteInvitationOperation({
      action: "revoke",
      confirmation: INVITATION_CONFIRMATIONS.revoke,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "revoked.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(revoked, {
      ok: false,
      code: "INVITATION_ALREADY_REDEEMED",
    });
    assert.equal(remote.grants.get(INVITATION_ID).state, "redeemed");
    assert.equal((await stat(invitationFile)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation removes only the matching unredeemed grant and its exact capability file", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-revoke-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  const invitationFile = join(root, "invite-0004.secret");
  try {
    const issued = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "issued.receipt.json"),
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(issued.ok, true);

    const revoked = await runRemoteInvitationOperation({
      action: "revoke",
      confirmation: INVITATION_CONFIRMATIONS.revoke,
      config: remote.config,
      invitationFile,
      receiptFile: join(root, "revoked.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.code, "STAGING_INVITATION_REVOKED");
    assert.equal(revoked.receipt.operation, "invitation_revoked");
    assert.equal(revoked.receipt.evidence.remoteGrantState, "absent");
    assert.equal(remote.grants.size, 0);
    await assert.rejects(access(invitationFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pilot activation, pause, resume, and rollback preserve publication containment", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-control-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  const nextReceiptId = receiptIdSequence();
  try {
    const inspected = await runRemotePilotControl({
      action: "inspect",
      config: remote.config,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.deepEqual(inspected.state, {
      revision: 1,
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
      runtimeMode: "disabled",
      runtimeControls: "contained",
      stateConsistent: true,
      rollbackFencePending: false,
      lifecycleReady: true,
      accountScopedIngestAuthorized: false,
    });

    const activated = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: join(root, "activate.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(activated.ok, true);
    assert.equal(remote.mode(), "invite_only");
    assert.deepEqual(remote.controls, {
      schema_version: "collection-controls-v0.1",
      control_state: "degraded",
      revision: 2,
      enrollment_enabled: 1,
      upload_registration_enabled: 1,
      processing_enabled: 1,
      publication_enabled: 0,
      reason_code: "drill_restore",
    });
    assert.equal(activated.receipt.collectionAuthorized, true);
    assert.equal(activated.receipt.evidence.publication, false);
    const activationDeploy = remote.calls.find((args) =>
      args[0] === "deploy" && args.includes("ENROLLMENT_MODE:invite_only"));
    assert.deepEqual(activationDeploy, [
      "deploy", "--env", "staging", "--strict",
      "--var", "ENVIRONMENT:staging",
      "--var", "ENROLLMENT_MODE:invite_only",
      "--var", "ACCOUNT_SCOPED_INGEST_MODE:disabled",
    ]);

    const replayedActivation = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: join(root, "activate-replay.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(replayedActivation.ok, true);
    assert.equal(
      replayedActivation.receipt.outcome,
      "verified_active_replay",
    );
    assert.equal(remote.controls.revision, 2);

    const paused = await runRemotePilotControl({
      action: "pause",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.pause,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 2,
      receiptFile: join(root, "pause.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(paused.ok, true);
    assert.equal(remote.mode(), "invite_only");
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "contained");

    const replayedPause = await runRemotePilotControl({
      action: "pause",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.pause,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 2,
      receiptFile: join(root, "pause-replay.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 2,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(replayedPause.ok, true);
    assert.equal(
      replayedPause.receipt.outcome,
      "verified_contained_replay",
    );
    assert.equal(remote.controls.revision, 3);

    const resumed = await runRemotePilotControl({
      action: "resume",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.resume,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: join(root, "resume.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 2,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(resumed.ok, true);
    assert.equal(remote.controls.revision, 4);
    assert.equal(remote.controls.publication_enabled, 0);

    const replayedResume = await runRemotePilotControl({
      action: "resume",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.resume,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: join(root, "resume-replay.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 3,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(replayedResume.ok, true);
    assert.equal(replayedResume.receipt.outcome, "verified_active_replay");
    assert.equal(remote.controls.revision, 4);

    const rolledBack = await runRemotePilotControl({
      action: "rollback",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.rollback,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 4,
      receiptFile: join(root, "rollback.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 3,
      receiptOperationId: nextReceiptId,
    });
    assert.equal(rolledBack.ok, true);
    assert.equal(remote.mode(), "disabled");
    assert.equal(remote.controls.revision, 5);
    assert.equal(remote.controls.control_state, "contained");

    const allReceipts = (
      await Promise.all([
        "activate.receipt.json",
        "activate-replay.receipt.json",
        "pause.receipt.json",
        "pause-replay.receipt.json",
        "resume.receipt.json",
        "resume-replay.receipt.json",
        "rollback.receipt.json",
      ].map((name) => readFile(join(root, name), "utf8"))))
      .join("\n");
    for (const excluded of [
      STAGING_ORIGIN,
      remote.config.env.staging.d1_databases[0].database_id,
      remote.config.env.staging.r2_buckets[0].bucket_name,
    ]) {
      assert.equal(allReceipts.includes(excluded), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection rejects D1 and live-runtime control disagreement", async () => {
  const remote = fakeRemote({ runtimeMode: "invite_only" });
  remote.controls.control_state = "degraded";
  remote.controls.enrollment_enabled = 1;
  remote.controls.upload_registration_enabled = 1;
  remote.controls.processing_enabled = 1;
  const containedFetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        enrollmentMode: "invite_only",
        collectionControls: {
          state: "contained",
          enrollment: false,
          uploadRegistration: false,
          processing: false,
          publication: false,
        },
        contracts: {
          accountScopedContribution: {
            externalParticipantsAuthorized: false,
          },
        },
        capabilities: {
          encryptedUpload: false,
          delayedAggregateStats: false,
          ongoingDeviceUploadRegistration: false,
        },
      });
    }
    return remote.fetchImpl(url);
  };
  const inspected = await runRemotePilotControl({
    action: "inspect",
    config: remote.config,
    origin: STAGING_ORIGIN,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: remote.spawn,
    fetchImpl: containedFetch,
  });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.code, "STAGING_PILOT_STATE_MISMATCH");
  assert.equal(inspected.state.runtimeControls, "contained");
  assert.equal(inspected.state.stateConsistent, false);
});

test("pause reports failure until live containment is verified", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-pause-verify-");
  const remote = fakeRemote({ runtimeMode: "invite_only" });
  remote.controls.control_state = "degraded";
  remote.controls.revision = 2;
  remote.controls.enrollment_enabled = 1;
  remote.controls.upload_registration_enabled = 1;
  remote.controls.processing_enabled = 1;
  remote.setContainedHealthFailure(true);
  try {
    const unverified = await runRemotePilotControl({
      action: "pause",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.pause,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 2,
      receiptFile: join(root, "pause-unverified.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(unverified.ok, false);
    assert.equal(unverified.code, "PILOT_PAUSE_RUNTIME_UNVERIFIED");
    assert.equal(unverified.receipt.collectionAuthorized, false);
    assert.equal(
      unverified.receipt.outcome,
      "contained_runtime_unverified",
    );
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.revision, 3);

    remote.setContainedHealthFailure(false);
    const retried = await runRemotePilotControl({
      action: "pause",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.pause,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 2,
      receiptFile: join(root, "pause-retry.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.receipt.outcome, "verified_contained_replay");
    assert.equal(remote.controls.revision, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime activation failure requires reviewed rollback without an automatic redeploy", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-runtime-failure-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failInviteOnlyContainedHealth: true,
  });
  const receiptFile = join(root, "runtime-failure.receipt.json");
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(result, {
      ok: false,
      code: "PILOT_RUNTIME_ACTIVATION_FAILED",
      recoveryAction: "inspect_then_run_reviewed_rollback",
    });
    assert.equal(remote.mode(), "invite_only");
    assert.equal(remote.controls.revision, 1);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(
      remote.calls.filter((args) => args[0] === "deploy").length,
      1,
    );
    assert.equal(
      remote.calls.some((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")),
      false,
    );
    assert.equal(
      remote.sqlBodies.some((sql) =>
        sql.includes("SET enrollment_enabled = 1")),
      false,
    );
    await assert.rejects(access(receiptFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed post-enable verification automatically restores contained disabled staging", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-auto-rollback-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: join(root, "activation-failure.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PILOT_ENABLE_FAILED_ROLLED_BACK");
    assert.equal(result.receipt.operation, "pilot_enable_rolled_back");
    assert.equal(result.receipt.collectionAuthorized, false);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.publication_enabled, 0);
    assert.equal(remote.mode(), "disabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed-enable recovery never mutates or deploys across a newer revision", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-concurrent-enable-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
    advanceRevisionOnFailedActiveHealth: true,
  });
  const receiptFile = join(root, "concurrent.receipt.json");
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(result, {
      ok: false,
      code: "PILOT_ENABLE_ROLLBACK_REVISION_CONFLICT",
      recoveryAction: "incident_manual_containment_required",
    });
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "degraded");
    assert.equal(remote.controls.enrollment_enabled, 1);
    assert.equal(remote.controls.publication_enabled, 0);
    assert.equal(remote.mode(), "invite_only");
    assert.equal(
      remote.calls.filter((args) => args[0] === "deploy").length,
      1,
    );
    assert.equal(
      remote.calls.some((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")),
      false,
    );
    assert.equal(
      remote.sqlBodies.some((sql) =>
        sql.includes("SET enrollment_enabled = 0")),
      false,
    );
    await assert.rejects(access(receiptFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback fence aborts when a revision advances immediately before deploy", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-fenced-race-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  const receiptFile = join(root, "fenced-race.receipt.json");
  let raceInjected = false;
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      beforeRollbackDeploy: () => {
        assert.equal(remote.controls.revision, 3);
        assert.equal(remote.controls.reason_code, "maintenance");
        raceInjected = true;
        remote.controls.control_state = "degraded";
        remote.controls.enrollment_enabled = 1;
        remote.controls.upload_registration_enabled = 1;
        remote.controls.processing_enabled = 1;
        remote.controls.publication_enabled = 0;
        remote.controls.reason_code = "drill_restore";
        remote.controls.revision += 1;
      },
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(raceInjected, true);
    assert.deepEqual(result, {
      ok: false,
      code: "PILOT_ENABLE_ROLLBACK_REVISION_CONFLICT",
      recoveryAction: "incident_manual_containment_required",
    });
    assert.equal(remote.controls.revision, 4);
    assert.equal(remote.controls.control_state, "degraded");
    assert.equal(remote.controls.enrollment_enabled, 1);
    assert.equal(remote.mode(), "invite_only");
    assert.equal(
      remote.calls.filter((args) => args[0] === "deploy").length,
      1,
    );
    assert.equal(
      remote.calls.some((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")),
      false,
    );
    assert.equal(
      remote.sqlBodies.some((sql) =>
        sql.includes("SET reason_code = 'drill_containment'")),
      false,
    );
    await assert.rejects(access(receiptFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback fence survives a crash before disabled deploy and recovers exactly once", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-fence-before-deploy-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  const failedReceipt = join(root, "activation-failure.receipt.json");
  const recoveryReceipt = join(root, "recovery.receipt.json");
  try {
    await assert.rejects(
      runRemotePilotControl({
        action: "activate",
        confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
        config: remote.config,
        origin: STAGING_ORIGIN,
        expectedRevision: 1,
        receiptFile: failedReceipt,
        wrangler: "/fake/wrangler",
        workerDirectory,
        spawn: remote.spawn,
        fetchImpl: remote.fetchImpl,
        beforeRollbackDeploy: () => {
          throw new Error("simulated crash before disabled deploy");
        },
        nowEpoch: NOW,
        receiptOperationId: receiptIdSequence(),
      }),
      /simulated crash before disabled deploy/u,
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.reason_code, "maintenance");
    assert.equal(remote.mode(), "invite_only");
    assert.equal(
      remote.calls.some((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")),
      false,
    );
    await assert.rejects(access(failedReceipt));

    const inspected = await runRemotePilotControl({
      action: "inspect",
      config: remote.config,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, "STAGING_PILOT_ROLLBACK_FENCE_PENDING");
    assert.equal(inspected.state.revision, 3);
    assert.equal(inspected.state.rollbackFencePending, true);
    assert.equal(inspected.state.runtimeMode, "invite_only");
    assert.equal(inspected.state.runtimeControls, "contained");

    for (const action of ["activate", "pause", "resume"]) {
      const blockedReceipt = join(root, `blocked-${action}.receipt.json`);
      const blockedMutation = await runRemotePilotControl({
        action,
        confirmation: PILOT_CONTROL_CONFIRMATIONS[action],
        config: remote.config,
        origin: STAGING_ORIGIN,
        expectedRevision: 3,
        receiptFile: blockedReceipt,
        wrangler: "/fake/wrangler",
        workerDirectory,
        spawn: remote.spawn,
        fetchImpl: remote.fetchImpl,
        nowEpoch: NOW + 1,
        receiptOperationId: receiptIdSequence(),
      });
      assert.deepEqual(blockedMutation, {
        ok: false,
        code: "PILOT_CONTROL_REVISION_CONFLICT",
      });
      assert.equal(remote.controls.reason_code, "maintenance");
      await assert.rejects(access(blockedReceipt));
    }

    const recovered = await runRemotePilotControl({
      action: "rollback",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.rollback,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: recoveryReceipt,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 2,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(recovered.ok, true);
    assert.equal(
      recovered.code,
      "STAGING_INVITE_PILOT_ROLLBACK_FENCE_RECOVERED",
    );
    assert.equal(
      recovered.receipt.outcome,
      "verified_contained_fence_recovery",
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.reason_code, "drill_containment");
    assert.equal(remote.mode(), "disabled");
    assert.equal(
      remote.calls.filter((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending rollback fence blocks invitation issuance before capability creation", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-fence-invitation-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  const invitationFile = join(root, "blocked-invitation.secret");
  const invitationReceipt = join(root, "blocked-invitation.receipt.json");
  let generationAttempted = false;
  try {
    await assert.rejects(
      runRemotePilotControl({
        action: "activate",
        confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
        config: remote.config,
        origin: STAGING_ORIGIN,
        expectedRevision: 1,
        receiptFile: join(root, "activation-failure.receipt.json"),
        wrangler: "/fake/wrangler",
        workerDirectory,
        spawn: remote.spawn,
        fetchImpl: remote.fetchImpl,
        beforeRollbackDeploy: () => {
          throw new Error("simulated crash before disabled deploy");
        },
        nowEpoch: NOW,
        receiptOperationId: receiptIdSequence(),
      }),
      /simulated crash before disabled deploy/u,
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.reason_code, "maintenance");
    assert.equal(remote.mode(), "invite_only");

    const blockedIssue = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: invitationReceipt,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      randomId: () => {
        generationAttempted = true;
        return INVITATION_ID;
      },
      randomSecret: () => {
        generationAttempted = true;
        return INVITATION_SECRET;
      },
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(blockedIssue, {
      ok: false,
      code: "INVITATION_ISSUANCE_CONTROL_BLOCKED",
    });
    assert.equal(generationAttempted, false);
    assert.equal(
      remote.sqlBodies.some((sql) =>
        sql.includes("INSERT INTO enrollment_grants")),
      false,
    );
    assert.equal(remote.grants.size, 0);
    await assert.rejects(access(invitationFile));
    await assert.rejects(access(invitationReceipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invitation INSERT atomically rejects a fence acquired after preflight", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-issue-interleave-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  const invitationFile = join(root, "interleaved-invitation.secret");
  const invitationReceipt = join(root, "interleaved-invitation.receipt.json");
  let fenceInterleaved = false;
  try {
    const blockedIssue = await runRemoteInvitationOperation({
      action: "issue",
      confirmation: INVITATION_CONFIRMATIONS.issue,
      config: remote.config,
      invitationFile,
      receiptFile: invitationReceipt,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      beforeIssueInsert: async () => {
        await access(invitationFile);
        assert.equal(remote.controls.revision, 1);
        assert.equal(remote.controls.reason_code, "drill_containment");
        await assert.rejects(
          runRemotePilotControl({
            action: "activate",
            confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
            config: remote.config,
            origin: STAGING_ORIGIN,
            expectedRevision: 1,
            receiptFile: join(root, "activation-failure.receipt.json"),
            wrangler: "/fake/wrangler",
            workerDirectory,
            spawn: remote.spawn,
            fetchImpl: remote.fetchImpl,
            beforeRollbackDeploy: () => {
              throw new Error("simulated crash before disabled deploy");
            },
            nowEpoch: NOW,
            receiptOperationId: receiptIdSequence(),
          }),
          /simulated crash before disabled deploy/u,
        );
        fenceInterleaved = true;
        assert.equal(remote.controls.revision, 3);
        assert.equal(remote.controls.reason_code, "maintenance");
      },
      nowEpoch: NOW + 1,
      randomId: () => INVITATION_ID,
      randomSecret: () => INVITATION_SECRET,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(fenceInterleaved, true);
    assert.deepEqual(blockedIssue, {
      ok: false,
      code: "INVITATION_ISSUANCE_CONTROL_BLOCKED",
    });
    assert.equal(
      remote.sqlBodies.filter((sql) =>
        sql.includes("INSERT INTO enrollment_grants")).length,
      1,
    );
    assert.equal(remote.grants.size, 0);
    assert.equal(remote.controls.reason_code, "maintenance");
    await assert.rejects(access(invitationFile));
    await assert.rejects(access(invitationReceipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback fence recovers a crash after disabled deploy without redeploying", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-fence-after-deploy-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  const failedReceipt = join(root, "activation-failure.receipt.json");
  try {
    await assert.rejects(
      runRemotePilotControl({
        action: "activate",
        confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
        config: remote.config,
        origin: STAGING_ORIGIN,
        expectedRevision: 1,
        receiptFile: failedReceipt,
        wrangler: "/fake/wrangler",
        workerDirectory,
        spawn: remote.spawn,
        fetchImpl: remote.fetchImpl,
        afterRollbackDeploy: () => {
          throw new Error("simulated crash after disabled deploy");
        },
        nowEpoch: NOW,
        receiptOperationId: receiptIdSequence(),
      }),
      /simulated crash after disabled deploy/u,
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.reason_code, "maintenance");
    assert.equal(remote.mode(), "disabled");
    assert.equal(
      remote.calls.filter((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")).length,
      1,
    );
    await assert.rejects(access(failedReceipt));

    const inspected = await runRemotePilotControl({
      action: "inspect",
      config: remote.config,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, "STAGING_PILOT_ROLLBACK_FENCE_PENDING");
    assert.equal(inspected.state.rollbackFencePending, true);
    assert.equal(inspected.state.runtimeMode, "disabled");

    const recovered = await runRemotePilotControl({
      action: "rollback",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.rollback,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: join(root, "recovery.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(recovered.ok, true);
    assert.equal(
      recovered.code,
      "STAGING_INVITE_PILOT_ROLLBACK_FENCE_RECOVERED",
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.reason_code, "drill_containment");
    assert.equal(remote.mode(), "disabled");
    assert.equal(
      remote.calls.filter((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed disabled-runtime health retains the rollback fence until exact recovery", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-fence-health-");
  const remote = fakeRemote({
    runtimeMode: "disabled",
    failActiveHealth: true,
  });
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 1,
      receiptFile: join(root, "activation-failure.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      afterRollbackDeploy: () => {
        remote.setContainedHealthFailure(true);
      },
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(result, {
      ok: false,
      code: "PILOT_ENABLE_ROLLBACK_UNVERIFIED",
      recoveryAction: "inspect_then_retry_exact_fence_revision",
    });
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.controls.reason_code, "maintenance");
    assert.equal(remote.mode(), "disabled");
    assert.equal(
      remote.calls.filter((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")).length,
      1,
    );

    const inspected = await runRemotePilotControl({
      action: "inspect",
      config: remote.config,
      origin: STAGING_ORIGIN,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
    });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, "STAGING_PILOT_ROLLBACK_FENCE_PENDING");
    assert.equal(inspected.state.rollbackFencePending, true);
    assert.equal(inspected.state.runtimeMode, "unverified");

    const blockedResume = await runRemotePilotControl({
      action: "resume",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.resume,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: join(root, "blocked-resume.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 1,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(blockedResume, {
      ok: false,
      code: "PILOT_CONTROL_REVISION_CONFLICT",
    });
    assert.equal(remote.controls.reason_code, "maintenance");

    remote.setContainedHealthFailure(false);
    const recovered = await runRemotePilotControl({
      action: "rollback",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.rollback,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 3,
      receiptFile: join(root, "recovery.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW + 2,
      receiptOperationId: receiptIdSequence(),
    });
    assert.equal(recovered.ok, true);
    assert.equal(
      recovered.code,
      "STAGING_INVITE_PILOT_ROLLBACK_FENCE_RECOVERED",
    );
    assert.equal(remote.controls.revision, 3);
    assert.equal(remote.controls.reason_code, "drill_containment");
    assert.equal(
      remote.calls.filter((args) =>
        args[0] === "deploy"
          && args.includes("ENROLLMENT_MODE:disabled")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale expected revisions cannot deploy or widen controls", async () => {
  const root = await ownerDirectory("usage-monitor-pilot-revision-");
  const remote = fakeRemote({ runtimeMode: "disabled" });
  try {
    const result = await runRemotePilotControl({
      action: "activate",
      confirmation: PILOT_CONTROL_CONFIRMATIONS.activate,
      config: remote.config,
      origin: STAGING_ORIGIN,
      expectedRevision: 99,
      receiptFile: join(root, "stale.receipt.json"),
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: remote.spawn,
      fetchImpl: remote.fetchImpl,
      nowEpoch: NOW,
      receiptOperationId: receiptIdSequence(),
    });
    assert.deepEqual(result, {
      ok: false,
      code: "PILOT_CONTROL_REVISION_CONFLICT",
    });
    assert.equal(remote.controls.control_state, "contained");
    assert.equal(remote.mode(), "disabled");
    assert.equal(remote.calls.some((args) => args[0] === "deploy"), false);
    await assert.rejects(access(join(root, "stale.receipt.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
