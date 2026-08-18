import {
  ClaudeCallbackCapabilityError,
  createClaudeCallbackCapabilityContext,
  selectProductionClaudeCallbackBackend,
} from "./application/claude-callback-capability.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./platform/export-identity-keychain.js";
import {
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
} from "./platform/index.js";

const CLAUDE_CALLBACK_CAPABILITY =
  createClaudeCallbackCapabilityContext({
    capability:
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
  });

export {
  ClaudeCallbackCapabilityError,
};

export function createProductionClaudeCallbackBackend({
  platform = process.platform,
  architecture = process.arch,
  createBackend = createExportIdentityKeychainBackend,
  windowsReadiness = null,
  createWindowsBackend = null,
} = {}) {
  if (platform === "win32") {
    if (architecture !== "x64" || typeof createWindowsBackend !== "function") {
      throw new ClaudeCallbackCapabilityError("invalid_configuration");
    }
    try {
      assertWindowsProductionReadiness({
        platform,
        architecture,
        readiness: windowsReadiness,
      });
      const windowsBackend = createWindowsBackend({ platform, architecture });
      return createWindowsProductionCapabilityBackend({
        backend: windowsBackend,
        capability: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
        readiness: windowsReadiness,
      });
    } catch {
      throw new ClaudeCallbackCapabilityError("invalid_configuration");
    }
  }
  return selectProductionClaudeCallbackBackend({
    platform,
    architecture,
    createBackend,
  });
}

export const {
  ensureClaudeCallbackCapability,
  planClaudeCallbackCapabilityRemoval,
  readClaudeCallbackCapability,
  removeClaudeCallbackCapability,
  rotateClaudeCallbackCapability,
} = CLAUDE_CALLBACK_CAPABILITY;
