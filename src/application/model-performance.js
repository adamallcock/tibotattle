import { createParser, digest, METHOD, MAX_STATE_BYTES } from '../providers/codex/logs.js';
import { modelPerformanceProjection } from '../reporting/index.js';

// Composition contract: the application selects diagnostic semantics; the
// companion supplies the private local storage adapter.
export function createModelPerformanceContext({ openStore }) {
  return {
    open: directory => openStore(directory, { createParser, digest, METHOD, MAX_STATE_BYTES }),
    project: modelPerformanceProjection,
  };
}
