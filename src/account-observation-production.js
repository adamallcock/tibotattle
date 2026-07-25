import {
  createAccountObservationSecretLoader,
  createDevelopmentAccountObservationSecretLoader,
  defaultAccountObservationOperationLockFile,
} from "./account-observation-secret.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./export-identity-keychain.js";

function fail(code) {
  const error = new Error("Production account observation credential selection failed");
  error.code = code;
  throw error;
}

export function selectProductionAccountObservationSecret({
  platform = process.platform,
  architecture = process.arch,
  operationLockFile = defaultAccountObservationOperationLockFile(),
  createKeychainBackend = createExportIdentityKeychainBackend,
  keychainCapability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
  developmentSecret = null,
} = {}) {
  if (developmentSecret !== null) {
    return Object.freeze({
      mode: "injected_development_secret",
      loadAccountObservationSecret: createDevelopmentAccountObservationSecretLoader(developmentSecret),
    });
  }
  if (platform !== "darwin" || architecture !== "arm64") {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  if (typeof createKeychainBackend !== "function"
      || keychainCapability !== EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_INVALID");
  }
  let backend;
  try {
    backend = createKeychainBackend();
  } catch {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  return Object.freeze({
    mode: "macos_keychain_account_observation",
    loadAccountObservationSecret: createAccountObservationSecretLoader({
      backend,
      capability: keychainCapability,
      operationLockFile,
    }),
  });
}
