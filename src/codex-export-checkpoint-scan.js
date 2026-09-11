import { localExportSourcePipeline as pipeline } from "./local-node-runtime.js";

export const {
  CODEX_CHECKPOINT_SCAN_VERSION,
  DEFAULT_CHECKPOINT_LINES_PER_BATCH,
  populateCheckpointedCodexSources,
} = pipeline.codexCheckpoint;
