import { createParser, createToolFreeParser, digest, METHOD, TOOL_FREE_METHOD, MAX_STATE_BYTES, INFERENCE_TIMING_PARSER_VERSION } from '../providers/codex/logs.js';
import { modelPerformanceProjection } from '../reporting/index.js';

// Composition contract: the application selects diagnostic semantics; the
// companion supplies the private local storage adapter.
export function createModelPerformanceContext({ openStore }) {
  return {
    parserVersion: INFERENCE_TIMING_PARSER_VERSION,
    open: directory => openStore(directory, { createParser, digest, METHOD, MAX_STATE_BYTES,
      parserVersion: INFERENCE_TIMING_PARSER_VERSION }),
    openSupplement: (directory, correlationKey) => openStore(directory, {
      createParser: createToolFreeParser, digest, METHOD: TOOL_FREE_METHOD, MAX_STATE_BYTES, correlationKey,
      parserVersion: INFERENCE_TIMING_PARSER_VERSION,
    }),
    project: modelPerformanceProjection,
  };
}
