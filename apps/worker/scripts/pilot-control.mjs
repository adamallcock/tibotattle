import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  activePilotHealth,
  bareHttpsOrigin,
  containedPilotHealth,
  fetchPilotJson,
  lifecycleReady,
  pilotReceipt,
  probeRemotePilotDatabase,
  probeRemotePilotReadiness,
  runPilotDeployment,
  runRemotePilotSql,
  validateNewOwnerOnlyFile,
  writePilotReceipt,
} from "./pilot-operations-lib.mjs";

export const PILOT_CONTROL_CONFIRMATIONS = Object.freeze({
  activate: "ACTIVATE_STAGING_INVITE_PILOT",
  pause: "PAUSE_STAGING_INVITE_PILOT",
  resume: "RESUME_STAGING_INVITE_PILOT",
  rollback: "ROLLBACK_STAGING_INVITE_PILOT",
});

const MUTATING_ACTIONS = new Set(Object.keys(PILOT_CONTROL_CONFIRMATIONS));
const ACTIONS = new Set(["inspect", ...MUTATING_ACTIONS]);

function canonicalInstant(epoch) {
  if (!Number.isFinite(epoch)) {
    throw new TypeError("invalid pilot operation time");
  }
  const value = new Date(epoch).toISOString();
  if (Date.parse(value) !== epoch) {
    throw new TypeError("invalid pilot operation time");
  }
  return value;
}

function selectControlsSql() {
  return `SELECT schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled,
       reason_code
  FROM collection_controls
 WHERE singleton = 1;
`;
}

function mutateControlsSql(active, expectedRevision) {
  const desired = active
    ? {
      enrollment: 1,
      uploadRegistration: 1,
      processing: 1,
      publication: 0,
      state: "degraded",
      reason: "drill_restore",
      priorPredicate: `enrollment_enabled = 0
   AND upload_registration_enabled = 0
   AND processing_enabled = 0
   AND publication_enabled = 0`,
    }
    : {
      enrollment: 0,
      uploadRegistration: 0,
      processing: 0,
      publication: 0,
      state: "contained",
      reason: "drill_containment",
      priorPredicate: `NOT (
     enrollment_enabled = 0
     AND upload_registration_enabled = 0
     AND processing_enabled = 0
     AND publication_enabled = 0
   )`,
    };
  return `UPDATE collection_controls
   SET enrollment_enabled = ${desired.enrollment},
       upload_registration_enabled = ${desired.uploadRegistration},
       processing_enabled = ${desired.processing},
       publication_enabled = ${desired.publication},
       control_state = '${desired.state}',
       revision = revision + 1,
       reason_code = '${desired.reason}',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1
   AND revision = ${expectedRevision}
   AND reason_code <> 'maintenance'
   AND ${desired.priorPredicate};
SELECT changes() AS changed,
       schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled,
       reason_code
  FROM collection_controls
 WHERE singleton = 1;
`;
}

function acquireRollbackFenceSql(expectedRevision) {
  return `UPDATE collection_controls
   SET enrollment_enabled = 0,
       upload_registration_enabled = 0,
       processing_enabled = 0,
       publication_enabled = 0,
       control_state = 'contained',
       revision = revision + 1,
       reason_code = 'maintenance',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1
   AND revision = ${expectedRevision}
   AND reason_code <> 'maintenance'
   AND control_state = 'degraded'
   AND enrollment_enabled = 1
   AND upload_registration_enabled = 1
   AND processing_enabled = 1
   AND publication_enabled = 0;
SELECT changes() AS changed,
       schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled,
       reason_code
  FROM collection_controls
 WHERE singleton = 1;
`;
}

function releaseRollbackFenceSql(fenceRevision) {
  return `UPDATE collection_controls
   SET reason_code = 'drill_containment',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1
   AND revision = ${fenceRevision}
   AND control_state = 'contained'
   AND enrollment_enabled = 0
   AND upload_registration_enabled = 0
   AND processing_enabled = 0
   AND publication_enabled = 0
   AND reason_code = 'maintenance';
SELECT changes() AS changed,
       schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled,
       reason_code
  FROM collection_controls
 WHERE singleton = 1;
`;
}

function validControlRow(row) {
  return row?.schema_version === "collection-controls-v0.1"
    && ["operational", "degraded", "contained"].includes(row.control_state)
    && Number.isSafeInteger(row.revision)
    && row.revision >= 1
    && [
      "initial",
      "drill_containment",
      "drill_restore",
      "privacy_incident",
      "security_incident",
      "abuse_or_cost",
      "maintenance",
    ].includes(row.reason_code)
    && [
      row.enrollment_enabled,
      row.upload_registration_enabled,
      row.processing_enabled,
      row.publication_enabled,
    ].every((value) => value === 0 || value === 1);
}

function desiredControlRow(row, active) {
  if (!validControlRow(row)) return false;
  return row.reason_code !== "maintenance"
    && row.enrollment_enabled === Number(active)
    && row.upload_registration_enabled === Number(active)
    && row.processing_enabled === Number(active)
    && row.publication_enabled === 0
    && row.control_state === (active ? "degraded" : "contained");
}

function rollbackFenceRow(row, fenceRevision) {
  return validControlRow(row)
    && row.revision === fenceRevision
    && row.control_state === "contained"
    && row.enrollment_enabled === 0
    && row.upload_registration_enabled === 0
    && row.processing_enabled === 0
    && row.publication_enabled === 0
    && row.reason_code === "maintenance";
}

function collectSqlWarnings(warnings, result) {
  for (const warning of result.warnings ?? []) warnings.add(warning);
}

function withOperationalWarnings(result, warnings) {
  return warnings.size === 0
    ? result
    : {
      ...result,
      warnings: [...warnings].sort(),
    };
}

function readControls(options, warnings) {
  const result = runRemotePilotSql({
    ...options,
    sql: selectControlsSql(),
  });
  collectSqlWarnings(warnings, result);
  return result.ok && validControlRow(result.row) ? result.row : null;
}

function setControls(options, active, expectedRevision, warnings) {
  const result = runRemotePilotSql({
    ...options,
    sql: mutateControlsSql(active, expectedRevision),
  });
  collectSqlWarnings(warnings, result);
  if (!result.ok || !validControlRow(result.row)
      || !desiredControlRow(result.row, active)) {
    return null;
  }
  const expectedAfterMutation = expectedRevision + 1;
  const changed = result.row.changed;
  if (changed === 1 && result.row.revision === expectedAfterMutation) {
    return { row: result.row, replayed: false };
  }
  if (changed === 0
      && result.row.revision === expectedAfterMutation) {
    return { row: result.row, replayed: true };
  }
  return null;
}

function acquireRollbackFence(options, expectedRevision, warnings) {
  const result = runRemotePilotSql({
    ...options,
    sql: acquireRollbackFenceSql(expectedRevision),
  });
  collectSqlWarnings(warnings, result);
  const fenceRevision = expectedRevision + 1;
  return result.ok
      && result.row?.changed === 1
      && rollbackFenceRow(result.row, fenceRevision)
    ? result.row
    : null;
}

function releaseRollbackFence(options, fenceRevision, warnings) {
  const result = runRemotePilotSql({
    ...options,
    sql: releaseRollbackFenceSql(fenceRevision),
  });
  collectSqlWarnings(warnings, result);
  return result.ok
      && result.row?.changed === 1
      && result.row.revision === fenceRevision
      && desiredControlRow(result.row, false)
    ? result.row
    : null;
}

async function runtimeState(origin, fetchImpl) {
  const [health, readiness] = await Promise.all([
    fetchPilotJson(origin, "/api/health", fetchImpl),
    fetchPilotJson(origin, "/api/ready", fetchImpl),
  ]);
  let mode = "unverified";
  let controls = "unverified";
  if (health.ok && health.status === 200) {
    if (containedPilotHealth(health.value, "disabled")) {
      mode = "disabled";
      controls = "contained";
    } else if (containedPilotHealth(health.value, "invite_only")) {
      mode = "invite_only";
      controls = "contained";
    } else if (activePilotHealth(health.value)) {
      mode = "invite_only";
      controls = "active";
    }
  }
  return {
    health,
    readiness,
    mode,
    controls,
    lifecycleReady: lifecycleReady(readiness),
  };
}

function receiptForControl({
  operation,
  outcome,
  row,
  expectedRevision,
  runtimeMode,
  lifecycleIsReady,
  operationId,
  generatedAt,
  operationalWarnings,
}) {
  const active = desiredControlRow(row, true);
  return pilotReceipt({
    operation,
    outcome,
    activationState: active
      ? "active"
      : operation === "pilot_paused"
        ? "paused"
        : "rolled_back",
    collectionAuthorized: active,
    operationId,
    generatedAt,
    evidence: {
      expectedRevision,
      resultingRevision: row.revision,
      enrollment: row.enrollment_enabled === 1,
      uploadRegistration: row.upload_registration_enabled === 1,
      processing: row.processing_enabled === 1,
      publication: row.publication_enabled === 1,
      runtimeMode,
      lifecycleReady: lifecycleIsReady,
      accountScopedIngestAuthorized: false,
      resourceIdentifiersExcluded: true,
      ...(operationalWarnings.size > 0
        ? { operationalWarnings: [...operationalWarnings].sort() }
        : {}),
    },
  });
}

function writeControlReceipt(receiptFile, receipt) {
  return writePilotReceipt(receiptFile, receipt)
    ? null
    : {
      ok: false,
      code: "PILOT_RECEIPT_WRITE_FAILED",
      recoveryAction: "inspect_then_retry_with_new_receipt_file",
    };
}

async function disableRuntime({
  origin,
  wrangler,
  workerDirectory,
  spawn,
  fetchImpl,
}) {
  if (!runPilotDeployment({
    inviteOnly: false,
    origin,
    wrangler,
    workerDirectory,
    spawn,
  })) {
    return false;
  }
  const after = await runtimeState(origin, fetchImpl);
  return after.mode === "disabled" && after.controls === "contained";
}

async function completeRollbackFence({
  fenceRevision,
  origin,
  wrangler,
  workerDirectory,
  spawn,
  fileSystem,
  fetchImpl,
  operationalWarnings,
  beforeRollbackDeploy,
  afterRollbackDeploy,
}) {
  const confirmedFence = readControls(
    { wrangler, workerDirectory, spawn, fileSystem },
    operationalWarnings,
  );
  if (!rollbackFenceRow(confirmedFence, fenceRevision)) {
    return { status: "revision_conflict", row: null };
  }
  if (beforeRollbackDeploy) await beforeRollbackDeploy();
  const deployFence = readControls(
    { wrangler, workerDirectory, spawn, fileSystem },
    operationalWarnings,
  );
  if (!rollbackFenceRow(deployFence, fenceRevision)) {
    return { status: "revision_conflict", row: null };
  }
  const runtimeBefore = await runtimeState(origin, fetchImpl);
  if (!["disabled", "invite_only"].includes(runtimeBefore.mode)
      || runtimeBefore.controls !== "contained") {
    return { status: "runtime_unverified", row: null };
  }
  if (runtimeBefore.mode === "invite_only") {
    const runtimeDeployed = runPilotDeployment({
      inviteOnly: false,
      origin,
      wrangler,
      workerDirectory,
      spawn,
    });
    if (!runtimeDeployed) {
      return { status: "runtime_unverified", row: null };
    }
    if (afterRollbackDeploy) await afterRollbackDeploy();
  }
  const disabledRuntime = await runtimeState(origin, fetchImpl);
  if (disabledRuntime.mode !== "disabled"
      || disabledRuntime.controls !== "contained") {
    return { status: "runtime_unverified", row: null };
  }
  const released = releaseRollbackFence(
    { wrangler, workerDirectory, spawn, fileSystem },
    fenceRevision,
    operationalWarnings,
  );
  if (!released) return { status: "fence_release_unverified", row: null };
  const confirmed = readControls(
    { wrangler, workerDirectory, spawn, fileSystem },
    operationalWarnings,
  );
  if (!confirmed
      || confirmed.revision !== fenceRevision
      || !desiredControlRow(confirmed, false)) {
    return { status: "fence_release_unverified", row: null };
  }
  const runtime = await runtimeState(origin, fetchImpl);
  return runtime.mode === "disabled" && runtime.controls === "contained"
    ? { status: "rolled_back", row: confirmed }
    : { status: "runtime_unverified", row: null };
}

async function rollbackFailedEnable({
  expectedRevision,
  origin,
  wrangler,
  workerDirectory,
  spawn,
  fileSystem,
  fetchImpl,
  operationalWarnings,
  beforeRollbackDeploy,
  afterRollbackDeploy,
}) {
  const current = readControls(
    { wrangler, workerDirectory, spawn, fileSystem },
    operationalWarnings,
  );
  if (!current) return { status: "state_unverified", row: null };
  if (current.revision !== expectedRevision + 1
      || !desiredControlRow(current, true)) {
    return { status: "revision_conflict", row: null };
  }
  const fenceRevision = expectedRevision + 2;
  const fenced = acquireRollbackFence(
    { wrangler, workerDirectory, spawn, fileSystem },
    expectedRevision + 1,
    operationalWarnings,
  );
  if (!fenced || fenced.revision !== fenceRevision) {
    return { status: "revision_conflict", row: null };
  }
  return completeRollbackFence({
    fenceRevision,
    origin,
    wrangler,
    workerDirectory,
    spawn,
    fileSystem,
    fetchImpl,
    operationalWarnings,
    beforeRollbackDeploy,
    afterRollbackDeploy,
  });
}

export async function runRemotePilotControl({
  action,
  confirmation = null,
  config,
  origin,
  expectedRevision = null,
  receiptFile = null,
  wrangler,
  workerDirectory,
  spawn,
  fileSystem,
  fetchImpl = fetch,
  beforeRollbackDeploy = null,
  afterRollbackDeploy = null,
  nowEpoch = Date.now(),
  receiptOperationId = randomUUID,
}) {
  if (!ACTIONS.has(action)) {
    return { ok: false, code: "PILOT_ACTION_INVALID" };
  }
  if (action === "inspect") {
    if (confirmation !== null || expectedRevision !== null
        || receiptFile !== null) {
      return { ok: false, code: "INSPECTION_OPTIONS_INVALID" };
    }
  } else if (confirmation !== PILOT_CONTROL_CONFIRMATIONS[action]) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  } else if (!Number.isSafeInteger(expectedRevision)
      || expectedRevision < 1) {
    return { ok: false, code: "EXPECTED_REVISION_INVALID" };
  } else if (!validateNewOwnerOnlyFile(receiptFile)) {
    return { ok: false, code: "RECEIPT_FILE_INVALID" };
  }
  let generatedAt = null;
  if (action !== "inspect") {
    try {
      generatedAt = canonicalInstant(nowEpoch);
    } catch {
      return { ok: false, code: "PILOT_OPERATION_TIME_INVALID" };
    }
  }

  const parsedOrigin = bareHttpsOrigin(origin);
  if (!parsedOrigin) return { ok: false, code: "STAGING_ORIGIN_INVALID" };
  const operationalWarnings = new Set();
  const finish = (result) =>
    withOperationalWarnings(result, operationalWarnings);
  const admission = action === "inspect"
    ? probeRemotePilotDatabase({
      config,
      wrangler,
      workerDirectory,
      spawn,
    })
    : probeRemotePilotReadiness({
      config,
      wrangler,
      workerDirectory,
      spawn,
      allowActiveControls: true,
    });
  if (!admission.ok) {
    return {
      ok: false,
      code: action === "inspect"
        ? "STAGING_DATABASE_PREFLIGHT_BLOCKED"
        : "STAGING_LIVE_READINESS_BLOCKED",
      blockers: admission.blockers,
    };
  }
  const initialRow = readControls(
    { wrangler, workerDirectory, spawn, fileSystem },
    operationalWarnings,
  );
  if (!initialRow) {
    return finish({ ok: false, code: "PILOT_CONTROL_STATE_INVALID" });
  }
  const initialRuntime = await runtimeState(parsedOrigin, fetchImpl);

  if (action === "inspect") {
    const rollbackFencePending = rollbackFenceRow(
      initialRow,
      initialRow.revision,
    );
    const databaseControls = rollbackFencePending
      ? "contained"
      : desiredControlRow(initialRow, true)
        ? "active"
        : desiredControlRow(initialRow, false)
          ? "contained"
          : "unverified";
    const stateConsistent = databaseControls !== "unverified"
      && databaseControls === initialRuntime.controls;
    const inspected = initialRuntime.mode !== "unverified"
      && stateConsistent
      && !rollbackFencePending;
    return finish({
      ok: inspected,
      code: rollbackFencePending
        ? "STAGING_PILOT_ROLLBACK_FENCE_PENDING"
        : initialRuntime.mode === "unverified"
          ? "STAGING_PILOT_RUNTIME_UNVERIFIED"
        : stateConsistent
          ? "STAGING_PILOT_INSPECTED"
          : "STAGING_PILOT_STATE_MISMATCH",
      state: {
        revision: initialRow.revision,
        enrollment: initialRow.enrollment_enabled === 1,
        uploadRegistration: initialRow.upload_registration_enabled === 1,
        processing: initialRow.processing_enabled === 1,
        publication: initialRow.publication_enabled === 1,
        runtimeMode: initialRuntime.mode,
        runtimeControls: initialRuntime.controls,
        stateConsistent,
        rollbackFencePending,
        lifecycleReady: initialRuntime.lifecycleReady,
        accountScopedIngestAuthorized: false,
      },
    });
  }

  if (action === "rollback"
      && rollbackFenceRow(initialRow, expectedRevision)) {
    const recovered = await completeRollbackFence({
      fenceRevision: expectedRevision,
      origin: parsedOrigin,
      wrangler,
      workerDirectory,
      spawn,
      fileSystem,
      fetchImpl,
      operationalWarnings,
      beforeRollbackDeploy,
      afterRollbackDeploy,
    });
    if (recovered.status === "revision_conflict") {
      return finish({
        ok: false,
        code: "PILOT_ROLLBACK_FENCE_REVISION_CONFLICT",
        recoveryAction: "incident_manual_containment_required",
      });
    }
    if (recovered.status !== "rolled_back") {
      return finish({
        ok: false,
        code: "PILOT_ROLLBACK_FENCE_RECOVERY_UNVERIFIED",
        recoveryAction: "inspect_then_retry_exact_fence_revision",
      });
    }
    const receipt = receiptForControl({
      operation: "pilot_rolled_back",
      outcome: "verified_contained_fence_recovery",
      row: recovered.row,
      expectedRevision,
      runtimeMode: "disabled",
      lifecycleIsReady: initialRuntime.lifecycleReady,
      operationId: receiptOperationId(),
      generatedAt,
      operationalWarnings,
    });
    const receiptFailure = writeControlReceipt(receiptFile, receipt);
    return finish(receiptFailure ?? {
      ok: true,
      code: "STAGING_INVITE_PILOT_ROLLBACK_FENCE_RECOVERED",
      receipt,
    });
  }

  if (action === "activate" || action === "resume") {
    const alreadyApplied = desiredControlRow(initialRow, true)
      && initialRow.revision === expectedRevision + 1;
    if (!alreadyApplied
        && (!desiredControlRow(initialRow, false)
          || initialRow.revision !== expectedRevision)) {
      return finish({
        ok: false,
        code: "PILOT_CONTROL_REVISION_CONFLICT",
      });
    }
    if (!initialRuntime.lifecycleReady) {
      return finish({ ok: false, code: "PILOT_LIFECYCLE_NOT_READY" });
    }
    if (alreadyApplied) {
      if (initialRuntime.mode !== "invite_only"
          || initialRuntime.controls !== "active") {
        return finish({ ok: false, code: "PILOT_ENABLE_UNVERIFIED" });
      }
      const receipt = receiptForControl({
        operation: action === "activate"
          ? "pilot_activated"
          : "pilot_resumed",
        outcome: "verified_active_replay",
        row: initialRow,
        expectedRevision,
        runtimeMode: initialRuntime.mode,
        lifecycleIsReady: true,
        operationId: receiptOperationId(),
        generatedAt,
        operationalWarnings,
      });
      const receiptFailure = writeControlReceipt(receiptFile, receipt);
      return finish(receiptFailure ?? {
        ok: true,
        code: action === "activate"
          ? "STAGING_INVITE_PILOT_ACTIVATED"
          : "STAGING_INVITE_PILOT_RESUMED",
        receipt,
      });
    }

    if (action === "activate") {
      if (!["disabled", "invite_only"].includes(initialRuntime.mode)
          || initialRuntime.controls !== "contained") {
        return finish({ ok: false, code: "CONTAINED_STAGING_NOT_READY" });
      }
      if (initialRuntime.mode === "disabled") {
        const deployed = runPilotDeployment({
          inviteOnly: true,
          origin: parsedOrigin,
          wrangler,
          workerDirectory,
          spawn,
        });
        const deployedRuntime = deployed
          ? await runtimeState(parsedOrigin, fetchImpl)
          : null;
        if (!deployedRuntime
            || deployedRuntime.mode !== "invite_only"
            || deployedRuntime.controls !== "contained"
            || !deployedRuntime.lifecycleReady) {
          return finish({
            ok: false,
            code: "PILOT_RUNTIME_ACTIVATION_FAILED",
            recoveryAction: "inspect_then_run_reviewed_rollback",
          });
        }
      }
    } else if (initialRuntime.mode !== "invite_only"
        || initialRuntime.controls !== "contained") {
      return finish({ ok: false, code: "PAUSED_PILOT_NOT_READY" });
    }

    const enabled = setControls(
      { wrangler, workerDirectory, spawn, fileSystem },
      true,
      expectedRevision,
      operationalWarnings,
    );
    const activeRuntime = enabled
      ? await runtimeState(parsedOrigin, fetchImpl)
      : null;
    if (!enabled
        || !activeRuntime
        || activeRuntime.mode !== "invite_only"
        || activeRuntime.controls !== "active"
        || !activeRuntime.lifecycleReady) {
      const rolledBack = await rollbackFailedEnable({
        expectedRevision,
        origin: parsedOrigin,
        wrangler,
        workerDirectory,
        spawn,
        fileSystem,
        fetchImpl,
        operationalWarnings,
        beforeRollbackDeploy,
        afterRollbackDeploy,
      });
      if (rolledBack.status === "revision_conflict") {
        return finish({
          ok: false,
          code: "PILOT_ENABLE_ROLLBACK_REVISION_CONFLICT",
          recoveryAction: "incident_manual_containment_required",
        });
      }
      if (rolledBack.status !== "rolled_back") {
        return finish({
          ok: false,
          code: "PILOT_ENABLE_ROLLBACK_UNVERIFIED",
          recoveryAction: rolledBack.status === "state_unverified"
            ? "run_disabled_staging_preparation"
            : "inspect_then_retry_exact_fence_revision",
        });
      }
      const receipt = receiptForControl({
        operation: "pilot_enable_rolled_back",
        outcome: "verified_rolled_back",
        row: rolledBack.row,
        expectedRevision,
        runtimeMode: "disabled",
        lifecycleIsReady: false,
        operationId: receiptOperationId(),
        generatedAt,
        operationalWarnings,
      });
      const receiptFailure = writeControlReceipt(receiptFile, receipt);
      return finish(receiptFailure ?? {
        ok: false,
        code: "PILOT_ENABLE_FAILED_ROLLED_BACK",
        receipt,
      });
    }

    const receipt = receiptForControl({
      operation: action === "activate" ? "pilot_activated" : "pilot_resumed",
      outcome: enabled.replayed ? "verified_active_replay" : "verified_active",
      row: enabled.row,
      expectedRevision,
      runtimeMode: activeRuntime.mode,
      lifecycleIsReady: true,
      operationId: receiptOperationId(),
      generatedAt,
      operationalWarnings,
    });
    const receiptFailure = writeControlReceipt(receiptFile, receipt);
    return finish(receiptFailure ?? {
      ok: true,
      code: action === "activate"
        ? "STAGING_INVITE_PILOT_ACTIVATED"
        : "STAGING_INVITE_PILOT_RESUMED",
      receipt,
    });
  }

  const alreadyContained = desiredControlRow(initialRow, false)
    && [expectedRevision, expectedRevision + 1].includes(initialRow.revision);
  if (!alreadyContained
      && (!desiredControlRow(initialRow, true)
        || initialRow.revision !== expectedRevision)) {
    return finish({
      ok: false,
      code: "PILOT_CONTROL_REVISION_CONFLICT",
    });
  }
  const contained = alreadyContained
    ? { row: initialRow, replayed: true }
    : setControls(
      { wrangler, workerDirectory, spawn, fileSystem },
      false,
      expectedRevision,
      operationalWarnings,
    );
  if (!contained) {
    return finish({
      ok: false,
      code: action === "pause"
        ? "PILOT_PAUSE_UNVERIFIED"
        : "PILOT_ROLLBACK_UNVERIFIED",
    });
  }

  let finalRuntime = await runtimeState(parsedOrigin, fetchImpl);
  if (action === "pause"
      && (finalRuntime.mode !== "invite_only"
        || finalRuntime.controls !== "contained")) {
    const receipt = receiptForControl({
      operation: "pilot_paused",
      outcome: "contained_runtime_unverified",
      row: contained.row,
      expectedRevision,
      runtimeMode: finalRuntime.mode,
      lifecycleIsReady: finalRuntime.lifecycleReady,
      operationId: receiptOperationId(),
      generatedAt,
      operationalWarnings,
    });
    const receiptFailure = writeControlReceipt(receiptFile, receipt);
    return finish(receiptFailure ?? {
      ok: false,
      code: "PILOT_PAUSE_RUNTIME_UNVERIFIED",
      recoveryAction: "inspect_then_retry_with_new_receipt_file_or_rollback",
      receipt,
    });
  }
  if (action === "rollback") {
    const runtimeDisabled = await disableRuntime({
      origin: parsedOrigin,
      wrangler,
      workerDirectory,
      spawn,
      fetchImpl,
    });
    if (!runtimeDisabled) {
      const receipt = receiptForControl({
        operation: "pilot_rollback_contained",
        outcome: "contained_runtime_unverified",
        row: contained.row,
        expectedRevision,
        runtimeMode: finalRuntime.mode,
        lifecycleIsReady: finalRuntime.lifecycleReady,
        operationId: receiptOperationId(),
        generatedAt,
        operationalWarnings,
      });
      const receiptFailure = writeControlReceipt(receiptFile, receipt);
      return finish(receiptFailure ?? {
        ok: false,
        code: "PILOT_ROLLBACK_RUNTIME_UNVERIFIED",
        receipt,
      });
    }
    finalRuntime = await runtimeState(parsedOrigin, fetchImpl);
  }

  const operation = action === "pause" ? "pilot_paused" : "pilot_rolled_back";
  const receipt = receiptForControl({
    operation,
    outcome: contained.replayed
      ? "verified_contained_replay"
      : "verified_contained",
    row: contained.row,
    expectedRevision,
    runtimeMode: finalRuntime.mode,
    lifecycleIsReady: finalRuntime.lifecycleReady,
    operationId: receiptOperationId(),
    generatedAt,
    operationalWarnings,
  });
  const receiptFailure = writeControlReceipt(receiptFile, receipt);
  return finish(receiptFailure ?? {
    ok: true,
    code: action === "pause"
      ? "STAGING_INVITE_PILOT_PAUSED"
      : "STAGING_INVITE_PILOT_ROLLED_BACK",
    receipt,
  });
}

function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: pilot-control.mjs --action inspect|activate|pause|resume|rollback "
      + "--origin https://HOST [--expected-revision N "
      + "--receipt-file /owner-only/path --confirm TOKEN]\n",
  );
  process.exit(2);
}

function cliOptions(argv) {
  const values = new Map();
  const supported = new Set([
    "--action",
    "--origin",
    "--expected-revision",
    "--receipt-file",
    "--confirm",
  ]);
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!supported.has(name) || !value || value.startsWith("--")
        || values.has(name)) {
      usageError("An unsupported or incomplete option was supplied");
    }
    values.set(name, value);
  }
  return values;
}

async function main() {
  const options = cliOptions(process.argv);
  const action = options.get("--action");
  if (!ACTIONS.has(action) || !options.has("--origin")) {
    usageError("A reviewed --action and exact --origin are required");
  }
  const mutationOptions = [
    "--expected-revision",
    "--receipt-file",
    "--confirm",
  ];
  if (action === "inspect") {
    if (mutationOptions.some((name) => options.has(name))) {
      usageError("Inspection does not accept mutation options");
    }
  } else if (!mutationOptions.every((name) => options.has(name))) {
    usageError("Mutations require revision, receipt, and confirmation");
  }

  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = parse(
    await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
  );
  const wrangler = join(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = await runRemotePilotControl({
    action,
    confirmation: options.get("--confirm") ?? null,
    config,
    origin: options.get("--origin"),
    expectedRevision: options.has("--expected-revision")
      ? Number(options.get("--expected-revision"))
      : null,
    receiptFile: options.get("--receipt-file") ?? null,
    wrangler,
    workerDirectory,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
