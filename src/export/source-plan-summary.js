import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { stableJson } from "./canonical-json.js";

export const EXPORT_SOURCE_PLAN_VERSION = "codex-export-source-plan-v2";
const SAFE_SOURCE_PLAN_CODES = new Set([
  "source_missing", "source_type", "source_owner", "source_links", "source_changed",
  "source_prefix", "source_duplicate", "source_lineage",
]);
export class ExportSourcePlanError extends Error {
  constructor(code) {
    if (!SAFE_SOURCE_PLAN_CODES.has(code)) throw new TypeError("Unknown export source-plan failure code");
    super(`Local export source plan failed (${code})`);
    this.name = "ExportSourcePlanError";
    this.code = `export_source_${code}`;
  }
}
function fail(code) { throw new ExportSourcePlanError(code); }
function data(object, key, { optional = false } = {}) {
  if (!object || typeof object !== "object" || isProxy(object)) fail("source_changed");
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (optional && descriptor === undefined) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) fail("source_changed");
  return descriptor.value;
}
function snapshotSource(source) {
  return Object.freeze({
    ordinal: data(source, "ordinal"), sourceKey: data(source, "sourceKey"),
    prefixBytes: data(source, "prefixBytes"), prefixSha256: data(source, "prefixSha256"),
    // These lineage fields were added after the original public digest shape.
    // Preserve its absent-field defaults without ever evaluating a getter.
    parentSourceKey: data(source, "parentSourceKey", { optional: true }),
    isFork: data(source, "isFork", { optional: true }),
    parentMissing: data(source, "parentMissing", { optional: true }),
  });
}
function snapshotSources(sources) {
  if (!Array.isArray(sources) || isProxy(sources)) fail("source_changed");
  const names = Object.getOwnPropertyNames(sources);
  if (names.length !== sources.length + 1 || names.some((name) => name !== "length" && !/^\d+$/u.test(name))) fail("source_changed");
  if (Object.getOwnPropertySymbols(sources).length > 0) fail("source_changed");
  const result = [];
  for (let index = 0; index < sources.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(sources, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) fail("source_changed");
    result.push(snapshotSource(descriptor.value));
  }
  return Object.freeze(result);
}
function publicDigestRows(sources) {
  return snapshotSources(sources).map((safe) => {
    return { ordinal: safe.ordinal, sourceKey: safe.sourceKey,
    prefixBytes: safe.prefixBytes, prefixSha256: safe.prefixSha256,
    parentSourceKey: safe.parentSourceKey ?? null, isFork: Boolean(safe.isFork),
    parentMissing: Boolean(safe.parentMissing) };
  });
}
function planDigest(sources) {
  return createHash("sha256").update("app-usagemonitor/export-source-plan/v2\0")
    .update(stableJson(publicDigestRows(sources))).digest("hex");
}
export function summarizeExportSourcePlan(plan) {
  if (!plan || typeof plan !== "object" || isProxy(plan)) fail("source_changed");
  const sources = Object.getOwnPropertyDescriptor(plan, "sources");
  const digest = Object.getOwnPropertyDescriptor(plan, "sourcePlanSha256");
  if (!sources || !digest || !Object.hasOwn(sources, "value") || !Object.hasOwn(digest, "value")
      || !Array.isArray(sources.value) || isProxy(sources.value) || digest.value !== planDigest(sources.value)) fail("source_changed");
  const safeSources = snapshotSources(sources.value);
  return { schemaVersion: EXPORT_SOURCE_PLAN_VERSION, sourcePlanSha256: digest.value,
    sourceFiles: safeSources.length, sourceBytes: safeSources.reduce((sum, source) => sum + source.prefixBytes, 0) };
}
export function createSourcePlanSummaryContract() {
  return Object.freeze({ planDigest });
}
