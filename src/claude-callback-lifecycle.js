import { fileURLToPath } from "node:url";
import {
  ClaudeCallbackCapabilityError,
  createClaudeCallbackCapabilityContext,
} from "./application/claude-callback-capability.js";
import {
  ClaudeCallbackLifecycleError,
  buildClaudeCallbackRunnerInvocation,
  createClaudeCallbackLifecycleContext,
  selectClaudeCallbackRunner,
  validateClaudeCallbackRunner,
} from "./platform/claude-callback-lifecycle.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./platform/export-identity-keychain.js";

const CAPABILITY_OPERATIONS =
  createClaudeCallbackCapabilityContext({
    capability:
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
  });

const CLAUDE_CALLBACK_LIFECYCLE =
  createClaudeCallbackLifecycleContext({
    ClaudeCallbackCapabilityError,
    ensureClaudeCallbackCapability:
      CAPABILITY_OPERATIONS.ensureClaudeCallbackCapability,
    planClaudeCallbackCapabilityRemoval:
      CAPABILITY_OPERATIONS.planClaudeCallbackCapabilityRemoval,
    removeClaudeCallbackCapability:
      CAPABILITY_OPERATIONS.removeClaudeCallbackCapability,
    rotateClaudeCallbackCapability:
      CAPABILITY_OPERATIONS.rotateClaudeCallbackCapability,
    runtimeScript: fileURLToPath(
      new URL("./claude-callback-runtime.js", import.meta.url),
    ),
  });

export {
  buildClaudeCallbackRunnerInvocation,
  ClaudeCallbackLifecycleError,
  selectClaudeCallbackRunner,
  validateClaudeCallbackRunner,
};

export const {
  buildManagedClaudeStatusLine,
  defaultClaudeCallbackLifecycleDirectory,
  defaultClaudeSettingsFile,
  inspectClaudeCallbackLifecycle,
  installClaudeCallback,
  planManagedClaudeCallbackCapabilityRemoval,
  readClaudeCallbackRuntimeConfiguration,
  recoverClaudeCallbackLifecycle,
  removeManagedClaudeCallbackCapability,
  rotateManagedClaudeCallbackCapability,
  uninstallClaudeCallback,
} = CLAUDE_CALLBACK_LIFECYCLE;
