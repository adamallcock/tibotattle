import { exportSourcePipelineCompatibility as pipeline } from "./export-source-pipeline-compatibility-internal.js";

export const {
  CODEX_CHECKPOINT_SCAN_VERSION,
  DEFAULT_CHECKPOINT_LINES_PER_BATCH,
  populateCheckpointedCodexSources,
} = pipeline.codexCheckpoint;
