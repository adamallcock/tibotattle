import { exportSourcePipelineCompatibility as pipeline } from "./export-source-pipeline-compatibility-internal.js";

export const {
  CLAUDE_TRANSCRIPT_WORKSPACE_SOURCE_VERSION,
  ClaudeTranscriptWorkspaceSourceError,
  DEFAULT_CLAUDE_TRANSCRIPT_RECORDS_PER_BATCH,
  appendClaudeTranscriptWorkspaceSources,
  createClaudeTranscriptWorkspaceSource,
  populateClaudeTranscriptWorkspaceSources,
} = pipeline.claudeTranscriptWorkspace;
