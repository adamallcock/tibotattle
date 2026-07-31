import {
  ClaudeCallbackCapabilityError,
  createClaudeCallbackCapabilityContext,
  selectProductionClaudeCallbackBackend,
} from "./application/claude-callback-capability.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createExportIdentityKeychainBackend,
} from "./platform/export-identity-keychain.js";

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
} = {}) {
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
