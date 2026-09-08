import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import {
  createLinuxQualificationSecretServiceHandover,
} from "./desktop-linux-secret-service.js";
import {
  assertLinuxNativeQualificationReceipt,
  createLinuxQualificationReceipt,
} from "./linux-qualification.js";

const CHILD_PATH = fileURLToPath(new URL(
  "./linux-secret-service-qualification-smoke-child.mjs",
  import.meta.url,
));

const CHILD_FAILURE_STAGES = new Map([
  [21, "create"], [22, "read"], [23, "replace"], [24, "delete"],
  [25, "absence"], [26, "channel"],
]);

function smokeFailure(stage = null) {
  const error = new Error("Linux Secret Service qualification smoke failed");
  error.code = stage === null ? "linux_secret_service_qualification_smoke_failed"
    : `linux_secret_service_qualification_smoke_${stage}_failed`;
  return error;
}

function assertIsolatedQualificationContext(context) {
  let receipt;
  try {
    // The private context brand proves only that this is a reviewed L0
    // context. It is not proof that a D-Bus session and its credential roots
    // are disposable. The outer qualification harness establishes that
    // containment before it creates this exact isolated-store context.
    receipt = assertLinuxNativeQualificationReceipt(
      createLinuxQualificationReceipt(context),
    );
  } catch {
    throw smokeFailure();
  }
  if (receipt.credentialStoreMode !== "isolated-secret-service") {
    throw smokeFailure();
  }
  return receipt;
}

/**
 * Run the fixed two-capability FD4 journey under ELECTRON_RUN_AS_NODE. The
 * caller must already hold an authentic qualification context; this helper
 * never creates one from environment strings or starts the normal Electron
 * shell. It is intended for an outer packaged-artifact harness only.
 */
export async function runLinuxSecretServiceQualificationSmoke({
  qualificationContext,
} = {}) {
  let handover;
  try {
    assertIsolatedQualificationContext(qualificationContext);
    handover = createLinuxQualificationSecretServiceHandover({ qualificationContext });
  } catch {
    throw smokeFailure();
  }
  let supervisor;
  let childExitCode = null;
  let backendSetupFailed = false;
  try {
    supervisor = createCompanionSupervisor({
      command: process.execPath,
      args: [CHILD_PATH],
      spawnChild(command, args, options) {
        const child = spawn(command, args, options);
        child.once("exit", (code) => { childExitCode = code; });
        return child;
      },
      attachLinuxSecretServiceBroker(stream) {
        try { return handover.attachLinuxSecretServiceBroker(stream); }
        catch { backendSetupFailed = true; throw smokeFailure("backend_setup"); }
      },
    });
    await supervisor.start();
  } catch {
    try { await supervisor?.stop?.(); } catch { /* Fixed smoke failure below is authoritative. */ }
    throw smokeFailure(backendSetupFailed ? "backend_setup"
      : CHILD_FAILURE_STAGES.get(childExitCode) ?? "child_execution");
  }
  try {
    await supervisor.stop();
  } catch {
    throw smokeFailure("shutdown");
  }
  return Object.freeze({ status: "passed" });
}
