import {
  createAccountObservationSecretLoader,
  createDevelopmentAccountObservationSecretLoader,
  defaultAccountObservationOperationLockFile,
} from "./account-observation-secret.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./export-identity-keychain.js";
import {
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
} from "./platform/index.js";

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
  windowsReadiness = null,
  createWindowsBackend = null,
} = {}) {
  if (developmentSecret !== null) {
    return Object.freeze({
      mode: "injected_development_secret",
      loadAccountObservationSecret: createDevelopmentAccountObservationSecretLoader(developmentSecret),
    });
  }
  if (platform === "win32") {
    if (architecture !== "x64"
        || typeof createWindowsBackend !== "function") {
      fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
    }
    try {
      assertWindowsProductionReadiness({
        platform,
        architecture,
        readiness: windowsReadiness,
      });
      const windowsBackend = createWindowsBackend({ platform, architecture });
      const backend = createWindowsProductionCapabilityBackend({
        backend: windowsBackend,
        capability: keychainCapability,
        readiness: windowsReadiness,
      });
      return Object.freeze({
        mode: "windows_credential_manager_account_observation",
        loadAccountObservationSecret: createAccountObservationSecretLoader({
          backend,
          capability: keychainCapability,
          operationLockFile,
        }),
      });
    } catch {
      fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
    }
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
