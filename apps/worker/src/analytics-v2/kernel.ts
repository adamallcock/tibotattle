/**
 * analytics-v2 kernel stamps (K-STAMP, owner decision round 7: two integers).
 *
 * - kernel_id (smallint) names the code: the vendored kernels, the GCP compute
 *   closure and the orchestration method. Ids are assigned in
 *   kernel-registry.json (append-only), never by a database, so they are
 *   identical in every environment. A bundle carries its own identity (the
 *   vendored manifest digest and the compute-closure digest, stamped at build
 *   time by cloud-run/build.mjs through two esbuild defines); the Job resolves
 *   it to a registry entry and refuses ANALYTICS_V2_KERNEL_UNREGISTERED when
 *   none matches.
 * - manifest_version (int) names the configuration the kernels priced and
 *   classified with. 1 is the compiled baseline: the catalog and price
 *   registry vendored at productionCommit. It is never 0 or unknown. Until
 *   manifest-bound kernels exist (KM-4, the first change after cutover),
 *   every run is manifest version 1.
 * - The compatibility class of a run is the compute closure, the method and
 *   the resource configuration that decides which owners and days are
 *   refused (memory model and budget, output model, day backstops). It is
 *   recorded on the run row (compatibility_sha256) so a memo can tell when a
 *   stored result was computed under different resources.
 *
 * - The compute class (K-PERCARD, engine v2 section 5.3: compute_sha256) is
 *   the compute closure WITHOUT the vendored price registry (its cards and
 *   manifest), stamped at build time through a third define. Two kernels
 *   with the same compute class differ at most in their price cards, so a
 *   transition between them can be compatible once its proof over the
 *   stored price inputs holds (price-transition.ts). It is derived from the
 *   closure the registry entry pins, so it is not a registry field; the
 *   store records it per kernel (analytics_v2_kernel_prices) and refuses a
 *   kernel that states another one. A bundle that states none (a spec
 *   running the sources unbundled) records null: no compatibility claim.
 *
 * Every analytics_v2 row a run writes carries its kernel_id and
 * manifest_version (staged migration analytics_v2_run_stamps; the store
 * refuses ANALYTICS_V2_KERNEL_CONFLICT for a registry entry that disagrees
 * with the stored kernel row and ANALYTICS_V2_KERNEL_REGRESSION when a newer
 * kernel already wrote, so an older reader never mutates newer state).
 *
 * Pure apart from WebCrypto hashing; no I/O.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import registryJson from "./kernel-registry.json";

declare const __ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__: string | undefined;
declare const __ANALYTICS_V2_VENDOR_MANIFEST_SHA256__: string | undefined;
declare const __ANALYTICS_V2_COMPUTE_SHA256__: string | undefined;

/**
 * The GCP orchestration method (pin, digests, memo and owner-set rules). A
 * bump is a new kernel. v2: a published day folds its saved owner set
 * (E-OWNERSET, compute-community.ts).
 */
export const ANALYTICS_V2_METHOD_VERSION = "analytics-v2-method-v2" as const;
/** manifest_version of the compiled baseline (the catalog vendored with the kernels). */
export const ANALYTICS_V2_MANIFEST_BASELINE_VERSION = 1 as const;
export const ANALYTICS_V2_KERNEL_REGISTRY_VERSION = "analytics-v2-kernel-registry-v1" as const;
export const ANALYTICS_V2_COMPATIBILITY_METHOD = "analytics-v2-compatibility-v1" as const;
/** PostgreSQL smallint: the kernel id column's range. */
export const ANALYTICS_V2_MAX_KERNEL_ID = 32_767;

export type AnalyticsV2KernelErrorCode =
  | "ANALYTICS_V2_KERNEL_REGISTRY_INVALID"
  | "ANALYTICS_V2_KERNEL_UNREGISTERED";

export class AnalyticsV2KernelError extends Error {
  constructor(readonly code: AnalyticsV2KernelErrorCode) {
    super(code);
    this.name = "AnalyticsV2KernelError";
  }
}

/** One kernel-registry.json entry. */
export interface AnalyticsV2KernelEntry {
  readonly kernelId: number;
  readonly productionCommit: string;
  readonly vendorManifestSha256: string;
  readonly computeClosureSha256: string;
  readonly priceRegistrySha256: string;
  readonly priceRegistryVersion: string;
  readonly methodVersion: string;
}

/** What a bundle (or a spec) says it is. */
export interface AnalyticsV2KernelIdentity {
  readonly vendorManifestSha256: string;
  readonly computeClosureSha256: string;
  readonly methodVersion: string;
  /** The compute class (the closure without the vendored price registry); absent when unknown. */
  readonly computeSha256?: string;
}

/** The stamp one run writes on every row (kernel and manifest) and on its run row (compatibility). */
export interface AnalyticsV2RunStamp {
  readonly kernel: AnalyticsV2KernelEntry;
  readonly manifestVersion: number;
  /** K-PERCARD: the bundle's compute class, or null (absent) when it stated none. */
  readonly computeSha256?: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const METHOD = /^analytics-v2-method-v[1-9][0-9]{0,5}$/u;
const ENTRY_KEYS = "computeClosureSha256,kernelId,methodVersion,priceRegistrySha256,priceRegistryVersion,productionCommit,vendorManifestSha256";

function registryFail(): never {
  throw new AnalyticsV2KernelError("ANALYTICS_V2_KERNEL_REGISTRY_INVALID");
}

/** A registry entry with exactly the closed keys and well-formed values. */
export function validAnalyticsV2KernelEntry(value: unknown): AnalyticsV2KernelEntry {
  const entry = value as Record<string, unknown> | null;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== ENTRY_KEYS
      || !Number.isSafeInteger(entry.kernelId) || (entry.kernelId as number) < 1
      || (entry.kernelId as number) > ANALYTICS_V2_MAX_KERNEL_ID
      || typeof entry.productionCommit !== "string" || !COMMIT.test(entry.productionCommit)
      || typeof entry.vendorManifestSha256 !== "string" || !SHA256.test(entry.vendorManifestSha256)
      || typeof entry.computeClosureSha256 !== "string" || !SHA256.test(entry.computeClosureSha256)
      || typeof entry.priceRegistrySha256 !== "string" || !SHA256.test(entry.priceRegistrySha256)
      || typeof entry.priceRegistryVersion !== "string" || !TOKEN.test(entry.priceRegistryVersion)
      || typeof entry.methodVersion !== "string" || !METHOD.test(entry.methodVersion)) {
    registryFail();
  }
  return Object.freeze({ kernelId: entry.kernelId as number, productionCommit: entry.productionCommit as string,
    vendorManifestSha256: entry.vendorManifestSha256 as string,
    computeClosureSha256: entry.computeClosureSha256 as string,
    priceRegistrySha256: entry.priceRegistrySha256 as string,
    priceRegistryVersion: entry.priceRegistryVersion as string, methodVersion: entry.methodVersion as string });
}

/**
 * The validated registry: ids 1, 2, ... in order with no gap, and no two
 * entries naming the same code identity.
 */
export function analyticsV2KernelRegistry(value: unknown = registryJson): readonly AnalyticsV2KernelEntry[] {
  const registry = value as { schemaVersion?: unknown; kernels?: unknown } | null;
  if (registry === null || typeof registry !== "object" || registry.schemaVersion !== ANALYTICS_V2_KERNEL_REGISTRY_VERSION
      || !Array.isArray(registry.kernels) || registry.kernels.length < 1) {
    registryFail();
  }
  const entries = (registry.kernels as unknown[]).map(validAnalyticsV2KernelEntry);
  const identities = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.kernelId !== index + 1) registryFail();
    const identity = `${entry.vendorManifestSha256}:${entry.computeClosureSha256}:${entry.methodVersion}`;
    if (identities.has(identity)) registryFail();
    identities.add(identity);
  }
  return Object.freeze(entries);
}

/** The identity a bundle was built with, or null outside a build (sources run unbundled). */
export function analyticsV2BundledKernelIdentity(): AnalyticsV2KernelIdentity | null {
  const closure = typeof __ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__ === "string"
    ? __ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__ : null;
  const manifest = typeof __ANALYTICS_V2_VENDOR_MANIFEST_SHA256__ === "string"
    ? __ANALYTICS_V2_VENDOR_MANIFEST_SHA256__ : null;
  if (closure === null || manifest === null) return null;
  const compute = typeof __ANALYTICS_V2_COMPUTE_SHA256__ === "string" && SHA256.test(__ANALYTICS_V2_COMPUTE_SHA256__)
    ? __ANALYTICS_V2_COMPUTE_SHA256__ : null;
  return Object.freeze({ vendorManifestSha256: manifest, computeClosureSha256: closure,
    methodVersion: ANALYTICS_V2_METHOD_VERSION, ...(compute === null ? {} : { computeSha256: compute }) });
}

/** The registry entry naming `identity`; ANALYTICS_V2_KERNEL_UNREGISTERED when none does. */
export function resolveAnalyticsV2Kernel(identity: AnalyticsV2KernelIdentity | null,
  registry: readonly AnalyticsV2KernelEntry[] = analyticsV2KernelRegistry()): AnalyticsV2KernelEntry {
  if (identity === null || typeof identity !== "object") throw new AnalyticsV2KernelError("ANALYTICS_V2_KERNEL_UNREGISTERED");
  const entry = registry.find((candidate) => candidate.vendorManifestSha256 === identity.vendorManifestSha256
    && candidate.computeClosureSha256 === identity.computeClosureSha256
    && candidate.methodVersion === identity.methodVersion);
  if (entry === undefined) throw new AnalyticsV2KernelError("ANALYTICS_V2_KERNEL_UNREGISTERED");
  return entry;
}

/**
 * The stamp of a run on the compiled baseline (manifest version 1), with the
 * bundle's compute class when it stated one (K-PERCARD).
 */
export function analyticsV2BaselineRunStamp(kernel: AnalyticsV2KernelEntry,
  computeSha256: string | null = null): AnalyticsV2RunStamp {
  if (computeSha256 !== null && (typeof computeSha256 !== "string" || !SHA256.test(computeSha256))) registryFail();
  return Object.freeze({ kernel: validAnalyticsV2KernelEntry(kernel), manifestVersion: ANALYTICS_V2_MANIFEST_BASELINE_VERSION,
    ...(computeSha256 === null ? {} : { computeSha256 }) });
}

/**
 * The run's compatibility class: the code (compute closure and method) and
 * the resource configuration that decides refusals. Two runs with the same
 * class compute the same rows from the same evidence.
 */
export async function analyticsV2CompatibilitySha256(kernel: AnalyticsV2KernelEntry, configuration: {
  readonly memoryModel: string; readonly outputModel: string; readonly memoryBudgetBytes: number;
  readonly maxDayOccurrences: number; readonly maxDayRecordBytes: number;
}): Promise<string> {
  return sha256Hex(canonicalJson([ANALYTICS_V2_COMPATIBILITY_METHOD, kernel.computeClosureSha256, kernel.methodVersion,
    configuration.memoryModel, configuration.outputModel, configuration.memoryBudgetBytes,
    configuration.maxDayOccurrences, configuration.maxDayRecordBytes]));
}
