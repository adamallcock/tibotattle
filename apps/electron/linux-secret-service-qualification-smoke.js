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

function smokeFailure() {
  const error = new Error("Linux Secret Service qualification smoke failed");
  error.code = "linux_secret_service_qualification_smoke_failed";
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
  try {
    supervisor = createCompanionSupervisor({
      command: process.execPath,
      args: [CHILD_PATH],
      attachLinuxSecretServiceBroker: handover.attachLinuxSecretServiceBroker,
    });
    await supervisor.start();
  } catch {
    try { await supervisor?.stop?.(); } catch { /* Fixed smoke failure below is authoritative. */ }
    throw smokeFailure();
  }
  try {
    await supervisor.stop();
  } catch {
    throw smokeFailure();
  }
  return Object.freeze({ status: "passed" });
}
