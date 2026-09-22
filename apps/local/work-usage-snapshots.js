import { createWorkUsageSnapshotStore as createSnapshotContext } from "../../src/application/index.js";
import { createValidatedSnapshotStore } from "../../src/platform/index.js";

export function createWorkUsageSnapshotStore(options) {
  return createSnapshotContext({ ...options, createStore: createValidatedSnapshotStore });
}
