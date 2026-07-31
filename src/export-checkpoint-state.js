import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  EXPORT_CHECKPOINT_PARSER_VERSION,
  createCodexCheckpointStateContext,
} from "./export/index.js";

// Exact legacy composition shim. Checkpoint validation is export-owned; Node
// hashing is supplied here rather than imported by the runtime-neutral owner.
const checkpointState = createCodexCheckpointStateContext({ createHash, isProxy });

export { EXPORT_CHECKPOINT_PARSER_VERSION };
export const createEmptyCodexCheckpointState =
  checkpointState.createEmptyCodexCheckpointState;
export const normalizeCodexCheckpointState =
  checkpointState.normalizeCodexCheckpointState;
export const serializeCodexCheckpointState =
  checkpointState.serializeCodexCheckpointState;
export const digestCodexCheckpointState =
  checkpointState.digestCodexCheckpointState;
