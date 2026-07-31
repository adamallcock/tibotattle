import { exportSourcePipelineCompatibility as pipeline } from "./export-source-pipeline-compatibility-internal.js";

export const {
  CLAUDE_STATUS_WORKSPACE_CURSOR_VERSION,
  CLAUDE_STATUS_WORKSPACE_SOURCE_VERSION,
  ClaudeStatusWorkspaceSourceError,
  DEFAULT_CLAUDE_STATUS_RECORDS_PER_BATCH,
  appendClaudeStatusWorkspaceSource,
  claudeStatusWorkspaceSourceKey,
  createClaudeStatusWorkspaceSource,
  populateClaudeStatusWorkspaceSource,
  resolveClaudeStatusWorkspaceSource,
} = pipeline.claudeStatusWorkspace;
