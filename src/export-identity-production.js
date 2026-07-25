import {
  defaultExportSecretFile,
} from "./export-identity.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./export-identity-keychain.js";

function selectionError(code) {
  const error = new Error("Production participant identity backend selection failed");
  error.code = code;
  return error;
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
} = {}) {
  if (environmentSecret && explicitSecretFile) {
    throw selectionError("EXPORT_IDENTITY_OVERRIDE_CONFLICT");
  }
  if (environmentSecret) {
    return Object.freeze({
      mode: "external_environment_override",
      identityOptions: Object.freeze({
        environmentSecret,
        secretFile: appStateSecretFile,
        legacySecretFile: null,
      }),
    });
  }
  if (explicitSecretFile) {
    return Object.freeze({
      mode: "owner_file_override",
      identityOptions: Object.freeze({
        environmentSecret: null,
        secretFile: explicitSecretFile,
        legacySecretFile: null,
      }),
    });
  }
  if (platform !== "darwin" || architecture !== "arm64") {
    throw selectionError("EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  if (typeof createKeychainBackend !== "function"
      || keychainCapability !== EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
    throw selectionError("EXPORT_IDENTITY_PRODUCTION_BACKEND_INVALID");
  }

  let participantSecretBackend;
  try {
    participantSecretBackend = createKeychainBackend();
  } catch (upstream) {
    let upstreamCode;
    try {
      upstreamCode = upstream?.code;
    } catch {
      // Hostile upstream errors are collapsed below.
    }
    const safeCodes = new Set([
      "export_identity_keychain_unsupported_platform",
      "export_identity_keychain_unsupported_architecture",
      "export_identity_keychain_invalid_configuration",
      "export_identity_keychain_binding_unavailable",
      "export_identity_keychain_binding_integrity",
    ]);
    throw selectionError(safeCodes.has(upstreamCode)
      ? upstreamCode
      : "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  return Object.freeze({
    mode: "macos_keychain",
    identityOptions: Object.freeze({
      environmentSecret: null,
      secretFile: appStateSecretFile,
      participantSecretBackend,
      participantSecretCapability: keychainCapability,
    }),
  });
}

export function renderParticipantIdentityBackendMode(mode) {
  if (mode === "macos_keychain") return "macos_keychain";
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
