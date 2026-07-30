import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  bareHttpsOrigin,
  containedPilotHealth,
  fetchPilotJson,
  lifecycleReady,
  pilotReceipt,
  probeRemotePilotDatabase,
  readOwnerOnlyInvitation,
  runRemotePilotSql,
  unlinkExactOwnerOnlyFile,
  validateNewOwnerOnlyFile,
  writeNewOwnerOnlyFile,
  writePilotReceipt,
} from "./pilot-operations-lib.mjs";

export const INVITATION_CONFIRMATIONS = Object.freeze({
  issue: "ISSUE_STAGING_INVITATION",
  "resume-issue": "RESUME_STAGING_INVITATION_ISSUE",
  revoke: "REVOKE_STAGING_INVITATION",
  rollback: "ROLLBACK_STAGING_INVITATION",
});

const ACTIONS = new Set(Object.keys(INVITATION_CONFIRMATIONS));
const HOUR_MILLISECONDS = 60 * 60 * 1000;
const ISSUANCE_ACTIONS = new Set(["issue", "resume-issue"]);
const CONTAINED_ISSUANCE_REASONS = new Set([
  "initial",
  "drill_containment",
]);

function canonicalInstant(epoch) {
  if (!Number.isFinite(epoch)) {
    throw new TypeError("invalid invitation time");
  }
  const value = new Date(epoch).toISOString();
  if (Date.parse(value) !== epoch) {
    throw new TypeError("invalid invitation time");
  }
  return value;
}

function inviteSecretHash(id, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/enrollment-invite/v1\0${id}\0${secret}`)
    .digest("hex");
}

function issueSql({
  id,
  secretHash,
  issuedAt,
  expiresAt,
}) {
  return `INSERT INTO enrollment_grants (
  id, secret_hash, state, issued_at, expires_at
) SELECT
  '${id}', x'${secretHash}', 'issued', '${issuedAt}', '${expiresAt}'
 WHERE EXISTS (
   SELECT 1
     FROM collection_controls
    WHERE singleton = 1
      AND schema_version = 'collection-controls-v0.1'
      AND control_state = 'contained'
      AND revision >= 1
      AND enrollment_enabled = 0
      AND upload_registration_enabled = 0
      AND processing_enabled = 0
      AND publication_enabled = 0
      AND reason_code IN ('initial', 'drill_containment')
 );
SELECT changes() AS changed,
       EXISTS(
         SELECT 1 FROM enrollment_grants WHERE id = '${id}'
       ) AS identifier_exists,
       EXISTS(
         SELECT 1
           FROM enrollment_grants
          WHERE id = '${id}' AND secret_hash = x'${secretHash}'
       ) AS secret_matches,
       COALESCE((
         SELECT state FROM enrollment_grants WHERE id = '${id}'
       ), 'absent') AS grant_state,
       (
         SELECT expires_at FROM enrollment_grants WHERE id = '${id}'
       ) AS expires_at;
`;
}

function inspectSql(id, secretHash) {
  return `SELECT CASE WHEN secret_hash = x'${secretHash}'
                    THEN 1 ELSE 0 END AS secret_matches,
       state AS grant_state,
       expires_at
  FROM enrollment_grants
 WHERE id = '${id}';
`;
}

function removalSql(id, secretHash) {
  return `DELETE FROM enrollment_grants
 WHERE id = '${id}'
   AND secret_hash = x'${secretHash}'
   AND state = 'issued';
SELECT changes() AS removed,
       EXISTS(
         SELECT 1 FROM enrollment_grants WHERE id = '${id}'
       ) AS identifier_exists,
       EXISTS(
         SELECT 1
           FROM enrollment_grants
          WHERE id = '${id}' AND secret_hash = x'${secretHash}'
       ) AS matching_exists,
       COALESCE((
         SELECT state
           FROM enrollment_grants
          WHERE id = '${id}' AND secret_hash = x'${secretHash}'
       ), 'absent') AS matching_state;
`;
}

function invitationControlsSql() {
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

function containedIssuanceControls(row) {
  return row?.schema_version === "collection-controls-v0.1"
    && row.control_state === "contained"
    && Number.isSafeInteger(row.revision)
    && row.revision >= 1
    && row.enrollment_enabled === 0
    && row.upload_registration_enabled === 0
    && row.processing_enabled === 0
    && row.publication_enabled === 0
    && CONTAINED_ISSUANCE_REASONS.has(row.reason_code);
}

function issuedRow(row, expiresAt = null) {
  return (row?.changed === undefined || row.changed === 1)
    && (row?.identifier_exists === undefined || row.identifier_exists === 1)
    && row?.secret_matches === 1
    && row?.grant_state === "issued"
    && typeof row?.expires_at === "string"
    && Number.isFinite(Date.parse(row.expires_at))
    && (expiresAt === null || row.expires_at === expiresAt);
}

function controlBlockedBeforeInsert(row) {
  return row?.changed === 0
    && row.identifier_exists === 0
    && row.secret_matches === 0
    && row.grant_state === "absent"
    && row.expires_at === null;
}

function invitationReceipt(
  operation,
  outcome,
  expiresAt,
  operationId,
  generatedAt,
  operationalWarnings,
) {
  return pilotReceipt({
    operation,
    outcome,
    activationState: "unchanged",
    collectionAuthorized: false,
    operationId,
    generatedAt,
    evidence: {
      invitationCount: 1,
      remoteGrantState: outcome === "verified_issued" ? "issued" : "absent",
      ...(expiresAt ? { expiresAt } : {}),
      capabilityExcluded: true,
      resourceIdentifiersExcluded: true,
      ...(operationalWarnings.length > 0
        ? { operationalWarnings }
        : {}),
    },
  });
}

function withOperationalWarnings(result, ...sqlResults) {
  const warnings = [...new Set(
    sqlResults.flatMap((sqlResult) => sqlResult.warnings ?? []),
  )].sort();
  return warnings.length === 0
    ? result
    : {
      ...result,
      warnings,
    };
}

async function containedRuntimeReady(origin, fetchImpl) {
  const health = await fetchPilotJson(origin, "/api/health", fetchImpl);
  if (!health.ok || health.status !== 200
      || (!containedPilotHealth(health.value)
        && !containedPilotHealth(health.value, "disabled"))) {
    return false;
  }
  return lifecycleReady(
    await fetchPilotJson(origin, "/api/ready", fetchImpl),
  );
}

function preflightDatabase(options) {
  const result = probeRemotePilotDatabase(options);
  return result.ok
    ? null
    : {
      ok: false,
      code: "STAGING_DATABASE_PREFLIGHT_BLOCKED",
      blockers: result.blockers,
    };
}

function invitationFromFile(invitationFile) {
  const invitation = readOwnerOnlyInvitation(invitationFile);
  if (!invitation) return null;
  return {
    ...invitation,
    secretHash: inviteSecretHash(invitation.id, invitation.secret),
  };
}

export async function runRemoteInvitationOperation({
  action,
  confirmation,
  config,
  invitationFile,
  receiptFile,
  origin = null,
  expiresInHours = 72,
  wrangler,
  workerDirectory,
  spawn,
  fileSystem,
  fetchImpl = fetch,
  nowEpoch = Date.now(),
  randomId = randomUUID,
  randomSecret = () => randomBytes(32).toString("base64url"),
  receiptOperationId = randomUUID,
  beforeIssueInsert = null,
}) {
  if (!ACTIONS.has(action)
      || confirmation !== INVITATION_CONFIRMATIONS[action]) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  }
  if (!validateNewOwnerOnlyFile(receiptFile)
      || invitationFile === receiptFile) {
    return { ok: false, code: "RECEIPT_FILE_INVALID" };
  }

  const parsedOrigin = action === "issue" ? bareHttpsOrigin(origin) : null;
  if (action === "issue") {
    if (!parsedOrigin) return { ok: false, code: "STAGING_ORIGIN_INVALID" };
    if (!Number.isSafeInteger(expiresInHours)
        || expiresInHours < 1 || expiresInHours > 24 * 30) {
      return { ok: false, code: "INVITATION_EXPIRY_INVALID" };
    }
    if (!validateNewOwnerOnlyFile(invitationFile)) {
      return { ok: false, code: "INVITATION_FILE_INVALID" };
    }
  }
  const invitation = action === "issue"
    ? null
    : invitationFromFile(invitationFile);
  if (action !== "issue" && !invitation) {
    return { ok: false, code: "INVITATION_FILE_INVALID" };
  }
  let generatedAt;
  let expiresAt = null;
  try {
    generatedAt = canonicalInstant(nowEpoch);
    if (action === "issue") {
      expiresAt = canonicalInstant(
        nowEpoch + expiresInHours * HOUR_MILLISECONDS,
      );
    }
  } catch {
    return { ok: false, code: "INVITATION_TIME_INVALID" };
  }

  const databaseFailure = preflightDatabase({
    config,
    wrangler,
    workerDirectory,
    spawn,
  });
  if (databaseFailure) return databaseFailure;

  let controlsResult = null;
  if (ISSUANCE_ACTIONS.has(action)) {
    controlsResult = runRemotePilotSql({
      sql: invitationControlsSql(),
      wrangler,
      workerDirectory,
      spawn,
      fileSystem,
    });
    if (!controlsResult.ok
        || !containedIssuanceControls(controlsResult.row)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_ISSUANCE_CONTROL_BLOCKED",
      }, controlsResult);
    }
  }

  if (action === "issue") {
    if (!await containedRuntimeReady(parsedOrigin, fetchImpl)) {
      return withOperationalWarnings({
        ok: false,
        code: "CONTAINED_STAGING_NOT_READY",
      }, controlsResult);
    }

    const id = randomId();
    const secret = randomSecret();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(id)
        || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_GENERATION_FAILED",
      }, controlsResult);
    }
    const encoded = `um_invite_${id}.${secret}`;
    if (!writeNewOwnerOnlyFile(invitationFile, `${encoded}\n`)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_FILE_INVALID",
      }, controlsResult);
    }
    const writtenInvitation = readOwnerOnlyInvitation(invitationFile);
    if (!writtenInvitation
        || writtenInvitation.id !== id
        || writtenInvitation.secret !== secret) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_FILE_INVALID",
      }, controlsResult);
    }
    if (beforeIssueInsert) await beforeIssueInsert();

    const secretHash = inviteSecretHash(id, secret);
    const result = runRemotePilotSql({
      sql: issueSql({
        id,
        secretHash,
        issuedAt: generatedAt,
        expiresAt,
      }),
      wrangler,
      workerDirectory,
      spawn,
      fileSystem,
    });
    if (result.ok && controlBlockedBeforeInsert(result.row)) {
      const removed = unlinkExactOwnerOnlyFile(
        invitationFile,
        writtenInvitation.identity,
      );
      return withOperationalWarnings({
        ok: false,
        code: removed
          ? "INVITATION_ISSUANCE_CONTROL_BLOCKED"
          : "UNDISTRIBUTED_INVITATION_FILE_RETAINED",
        ...(!removed
          ? { recoveryAction: "remove_exact_undistributed_invitation_file" }
          : {}),
      }, controlsResult, result);
    }
    if (!result.ok || !issuedRow(result.row, expiresAt)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_ISSUE_UNVERIFIED",
        recoveryAction: "resume_or_rollback",
      }, controlsResult, result);
    }
    const operationalWarnings = [...new Set([
      ...(controlsResult.warnings ?? []),
      ...(result.warnings ?? []),
    ])].sort();
    const receipt = invitationReceipt(
      "invitation_issued",
      "verified_issued",
      expiresAt,
      receiptOperationId(),
      generatedAt,
      operationalWarnings,
    );
    if (!writePilotReceipt(receiptFile, receipt)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_RECEIPT_WRITE_FAILED",
        recoveryAction: "resume_issue",
      }, controlsResult, result);
    }
    return withOperationalWarnings({
      ok: true,
      code: "STAGING_INVITATION_ISSUED",
      receipt,
    }, controlsResult, result);
  }

  if (action === "resume-issue") {
    const result = runRemotePilotSql({
      sql: inspectSql(invitation.id, invitation.secretHash),
      wrangler,
      workerDirectory,
      spawn,
      fileSystem,
    });
    if (!result.ok) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_RESUME_UNVERIFIED",
      }, controlsResult, result);
    }
    if (!issuedRow(result.row)
        || Date.parse(result.row.expires_at) <= nowEpoch) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_NOT_RESUMABLE",
      }, controlsResult, result);
    }
    const operationalWarnings = [...new Set([
      ...(controlsResult.warnings ?? []),
      ...(result.warnings ?? []),
    ])].sort();
    const receipt = invitationReceipt(
      "invitation_issue_resumed",
      "verified_issued",
      result.row.expires_at,
      receiptOperationId(),
      generatedAt,
      operationalWarnings,
    );
    if (!writePilotReceipt(receiptFile, receipt)) {
      return withOperationalWarnings({
        ok: false,
        code: "INVITATION_RECEIPT_WRITE_FAILED",
      }, controlsResult, result);
    }
    return withOperationalWarnings({
      ok: true,
      code: "STAGING_INVITATION_ISSUE_RESUMED",
      receipt,
    }, controlsResult, result);
  }

  const removed = runRemotePilotSql({
    sql: removalSql(invitation.id, invitation.secretHash),
    wrangler,
    workerDirectory,
    spawn,
    fileSystem,
  });
  if (!removed.ok || !removed.row) {
    return withOperationalWarnings({
      ok: false,
      code: action === "revoke"
        ? "INVITATION_REVOCATION_UNVERIFIED"
        : "INVITATION_ROLLBACK_UNVERIFIED",
    }, removed);
  }
  if (removed.row.identifier_exists === 1
      && removed.row.matching_exists !== 1) {
    return withOperationalWarnings({
      ok: false,
      code: "INVITATION_IDENTITY_CONFLICT",
    }, removed);
  }
  if (removed.row.matching_state === "redeemed") {
    return withOperationalWarnings({
      ok: false,
      code: "INVITATION_ALREADY_REDEEMED",
    }, removed);
  }
  if (![0, 1].includes(removed.row.removed)
      || removed.row.identifier_exists !== 0
      || removed.row.matching_exists !== 0
      || removed.row.matching_state !== "absent") {
    return withOperationalWarnings({
      ok: false,
      code: action === "revoke"
        ? "INVITATION_REVOCATION_UNVERIFIED"
        : "INVITATION_ROLLBACK_UNVERIFIED",
    }, removed);
  }

  const operationalWarnings = [...new Set(removed.warnings ?? [])].sort();
  const receipt = invitationReceipt(
    action === "revoke" ? "invitation_revoked" : "invitation_issue_rolled_back",
    action === "revoke" ? "verified_revoked" : "verified_rolled_back",
    null,
    receiptOperationId(),
    generatedAt,
    operationalWarnings,
  );
  if (!writePilotReceipt(receiptFile, receipt)) {
    return withOperationalWarnings({
      ok: false,
      code: "INVITATION_RECEIPT_WRITE_FAILED",
      recoveryAction: action,
    }, removed);
  }
  if (!unlinkExactOwnerOnlyFile(invitationFile, invitation.identity)) {
    return withOperationalWarnings({
      ok: false,
      code: "REVOKED_INVITATION_FILE_RETAINED",
      receipt,
    }, removed);
  }
  return withOperationalWarnings({
    ok: true,
    code: action === "revoke"
      ? "STAGING_INVITATION_REVOKED"
      : "STAGING_INVITATION_ROLLED_BACK",
    receipt,
  }, removed);
}

function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: pilot-invitation.mjs --action issue|resume-issue|revoke|rollback "
      + "--invitation-file /owner-only/path --receipt-file /owner-only/path "
      + "[--origin https://HOST] [--expires-in-hours N] --confirm TOKEN\n",
  );
  process.exit(2);
}

function cliOptions(argv) {
  const values = new Map();
  const supported = new Set([
    "--action",
    "--invitation-file",
    "--receipt-file",
    "--origin",
    "--expires-in-hours",
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
  if (!ACTIONS.has(action)) usageError("A reviewed --action is required");
  if (!options.has("--invitation-file")
      || !options.has("--receipt-file")
      || !options.has("--confirm")
      || (action === "issue") !== options.has("--origin")
      || (action !== "issue" && options.has("--expires-in-hours"))) {
    usageError("The action-specific options are invalid");
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
  const result = await runRemoteInvitationOperation({
    action,
    confirmation: options.get("--confirm"),
    config,
    invitationFile: options.get("--invitation-file"),
    receiptFile: options.get("--receipt-file"),
    origin: options.get("--origin") ?? null,
    expiresInHours: options.has("--expires-in-hours")
      ? Number(options.get("--expires-in-hours"))
      : 72,
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
