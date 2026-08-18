import {
  defaultExportSecretFile,
} from "./export-identity.js";
import {
  assertWindowsProductionReadiness,
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
  createWindowsProductionCapabilityBackend,
} from "./platform/index.js";
import {
  selectProductionParticipantIdentity as selectParticipantIdentityPolicy,
} from "./application/index.js";

function failWindowsProductionSelection() {
  const error = new Error("Production participant identity backend selection failed");
  error.code = "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE";
  throw error;
}

/**
 * Select the participant identity storage contract without reading or creating
 * a credential. The returned options are passed unchanged to the injected
 * identity core. Explicit development overrides always win before native
 * backend construction, and conflicting overrides fail closed.
 */
export function selectProductionParticipantIdentity({
  explicitSecretFile = null,
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  platform = process.platform,
  architecture = process.arch,
  appStateSecretFile = defaultExportSecretFile(),
  createKeychainBackend = createExportIdentityKeychainBackend,
  keychainCapability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
  windowsReadiness = null,
  createWindowsBackend = null,
  windowsFilesystemAdapter = null,
} = {}) {
  // Development overrides retain their existing precedence on every host.
  // Only the production Windows path is routed through the shared gate.
  if (platform === "win32" && !environmentSecret && !explicitSecretFile) {
    if (architecture !== "x64"
        || typeof createWindowsBackend !== "function"
        || windowsFilesystemAdapter?.productionSafe !== true
        || windowsFilesystemAdapter?.pathWalkRaceSafe !== true
        || keychainCapability !== EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
      failWindowsProductionSelection();
    }
    try {
      assertWindowsProductionReadiness({
        platform,
        architecture,
        readiness: windowsReadiness,
      });
      const windowsBackend = createWindowsBackend({ platform, architecture });
      const participantSecretBackend = createWindowsProductionCapabilityBackend({
        backend: windowsBackend,
        capability: keychainCapability,
        readiness: windowsReadiness,
      });
      return Object.freeze({
        mode: "windows_credential_manager",
        identityOptions: Object.freeze({
          environmentSecret: null,
          secretFile: appStateSecretFile,
          participantSecretBackend,
          participantSecretCapability: keychainCapability,
          windowsFilesystemAdapter,
        }),
      });
    } catch {
      failWindowsProductionSelection();
    }
  }
  return selectParticipantIdentityPolicy({
    explicitSecretFile,
    environmentSecret,
    platform,
    architecture,
    appStateSecretFile,
    createKeychainBackend,
    keychainCapability,
    allowedKeychainCapability:
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
  });
}

export function renderParticipantIdentityBackendMode(mode) {
  if (mode === "macos_keychain") return "macos_keychain";
  if (mode === "windows_credential_manager") return "windows_credential_manager";
  if (mode === "owner_file_override") return "owner_only_file_development_override";
  if (mode === "external_environment_override") return "external_environment_development_override";
  return "invalid";
}

export function renderParticipantIdentitySourceState(inspection) {
  if (inspection?.conflict === true) return "conflict";
  if (inspection?.source === "environment") return "external_override";
  if (inspection?.source === "secret_backend") return "keychain";
  if (inspection?.source === "owner_only_file") return "owner_only_file";
  if (inspection?.source === "legacy_owner_only_file") return "legacy_owner_only_file";
  if (["ready", "missing"].includes(inspection?.status)) return inspection.status;
  return "invalid";
}

export function renderParticipantIdentityFileResidueState(state) {
  if (["missing", "retired_removed"].includes(state)) return "absent";
  if (["present", "retired_retained", "retired_retained_unverified"].includes(state)) return "retained";
  if (state === "disabled") return "not_applicable";
  return "invalid";
}
