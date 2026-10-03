/** Local sampled JS allocation weights; never heap snapshots or object values. */
import { performance } from "node:perf_hooks";
import { analyticsRefreshFrameKey } from "./analytics-refresh-profile.mjs";
export const ALLOCATION_PROFILE_LIMITS = Object.freeze({ samplingIntervalBytes: 131072,
  maxNodes: 4096, maxDepth: 128, maxBytes: 768 * 1024 });
const fail = () => { throw Object.assign(new Error("ALLOCATION_PROFILE_INVALID_OR_LIMIT"), { code: "ALLOCATION_PROFILE_INVALID_OR_LIMIT" }); };
const keys = (value, names) => value !== null && typeof value === "object" && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const numeric = (value) => Number.isSafeInteger(value) && value >= 0;
const safeFrame = (frame) => typeof frame === "string" && frame.length <= 512 && !frame.startsWith("/")
  && /^[A-Za-z0-9@_.$<>()[\] :/+\-]+$/u.test(frame);

/** Iterative traversal rejects cycles, oversized breadth/depth and nonfinite byte weights before serialization. */
export function sanitizeAllocationTree(head, bundles = new Map()) {
  const seen = new WeakSet(), root = {}, stack = [{ input: head, output: root, depth: 0 }];
  let count = 0, estimatedBytes = 0;
  while (stack.length) {
    const { input, output, depth } = stack.pop();
    if (input === null || typeof input !== "object" || seen.has(input) || depth > ALLOCATION_PROFILE_LIMITS.maxDepth
        || ++count > ALLOCATION_PROFILE_LIMITS.maxNodes || !numeric(input.selfSize)
        || !Array.isArray(input.children) || input.children.length > ALLOCATION_PROFILE_LIMITS.maxNodes) fail();
    seen.add(input);
    estimatedBytes += input.selfSize;
    if (!numeric(estimatedBytes) || count + stack.length + input.children.length > ALLOCATION_PROFILE_LIMITS.maxNodes) fail();
    output.frame = analyticsRefreshFrameKey(input.callFrame, bundles);
    if (!safeFrame(output.frame)) fail();
    output.estimatedSelfBytes = input.selfSize;
    output.children = input.children.map(() => ({}));
    for (let index = input.children.length - 1; index >= 0; index--) {
      stack.push({ input: input.children[index], output: output.children[index], depth: depth + 1 });
    }
  }
  return { tree: root, nodeCount: count, estimatedAllocationBytes: estimatedBytes };
}
export function validateAllocationArtifact(artifact) {
  if (!keys(artifact, ["schemaVersion", "samplingIntervalBytes", "includeObjectsCollectedByMinorGC", "includeObjectsCollectedByMajorGC",
    "semantics", "startedAt", "stoppedAt", "elapsedMs", "nodeCount", "estimatedAllocationBytes", "tree"])
      || artifact.schemaVersion !== "analytics-local-allocation-v1" || artifact.samplingIntervalBytes !== ALLOCATION_PROFILE_LIMITS.samplingIntervalBytes
      || artifact.includeObjectsCollectedByMinorGC !== true || artifact.includeObjectsCollectedByMajorGC !== true
      || artifact.semantics !== "statistical sampled JS allocation including collected objects; not retained heap or peak RAM"
      || ![artifact.startedAt, artifact.stoppedAt].every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)))
      || Date.parse(artifact.stoppedAt) < Date.parse(artifact.startedAt)
      || typeof artifact.elapsedMs !== "number" || !Number.isFinite(artifact.elapsedMs) || artifact.elapsedMs < 0) fail();
  const seen = new WeakSet(), stack = [{ node: artifact.tree, depth: 0 }];
  let count = 0, estimatedBytes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!keys(node, ["frame", "estimatedSelfBytes", "children"]) || seen.has(node)
        || depth > ALLOCATION_PROFILE_LIMITS.maxDepth || ++count > ALLOCATION_PROFILE_LIMITS.maxNodes
        || !safeFrame(node.frame) || !numeric(node.estimatedSelfBytes) || !Array.isArray(node.children)
        || count + stack.length + node.children.length > ALLOCATION_PROFILE_LIMITS.maxNodes) fail();
    seen.add(node); estimatedBytes += node.estimatedSelfBytes;
    if (!numeric(estimatedBytes)) fail();
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  if (artifact.nodeCount !== count || artifact.estimatedAllocationBytes !== estimatedBytes
      || Buffer.byteLength(JSON.stringify(artifact)) > ALLOCATION_PROFILE_LIMITS.maxBytes) fail();
  return artifact;
}
export function startAllocationProfile({ enabled = false, post, bundles = new Map(), now = () => performance.now() } = {}) {
  if (!enabled) return null;
  let started = false, finished = false, error = null;
  const startedAt = new Date().toISOString(), startedMs = now();
  const params = { samplingInterval: ALLOCATION_PROFILE_LIMITS.samplingIntervalBytes,
    includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true };
  try { post("HeapProfiler.enable"); post("HeapProfiler.startSampling", params); started = true; }
  catch { error = "ALLOCATION_PROFILE_START_FAILED"; }
  const startInspectorMs = now() - startedMs;
  return {
    finish() {
      if (finished) return null;
      finished = true;
      const stoppingMs = now();
      let artifact = null;
      try {
        if (started) {
          started = false;
          const { profile } = post("HeapProfiler.stopSampling");
          artifact = validateAllocationArtifact({ schemaVersion: "analytics-local-allocation-v1",
            samplingIntervalBytes: ALLOCATION_PROFILE_LIMITS.samplingIntervalBytes,
            includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true,
            semantics: "statistical sampled JS allocation including collected objects; not retained heap or peak RAM",
            startedAt, stoppedAt: new Date().toISOString(), elapsedMs: now() - startedMs,
            ...sanitizeAllocationTree(profile.head, bundles) });
        }
      } catch { error = "ALLOCATION_PROFILE_CAPTURE_FAILED"; artifact = null; }
      finally { try { post("HeapProfiler.disable"); } catch { error ??= "ALLOCATION_PROFILE_CLOSE_FAILED"; } }
      return { artifact, error, startInspectorMs, stopAndSanitizeMs: now() - stoppingMs };
    },
  };
}
