function selectionError(code) {
  const error = new Error(
    "Production participant identity backend selection failed",
  );
  error.code = code;
  return error;
}

export function selectProductionParticipantIdentity({
  explicitSecretFile = null,
  environmentSecret,
  platform,
  architecture,
  appStateSecretFile,
  createKeychainBackend,
  keychainCapability,
  allowedKeychainCapability,
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
  if (
    typeof createKeychainBackend !== "function"
    || allowedKeychainCapability === undefined
    || keychainCapability !== allowedKeychainCapability
  ) {
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
    throw selectionError(
      safeCodes.has(upstreamCode)
        ? upstreamCode
        : "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE",
    );
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
