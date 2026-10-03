// K-STAMP: the kernel registry's closed contract (src/analytics-v2/kernel.ts).
// A malformed registry is refused as a whole with
// ANALYTICS_V2_KERNEL_REGISTRY_INVALID, an identity no entry names with
// ANALYTICS_V2_KERNEL_UNREGISTERED, and the compatibility class moves with
// every field it covers. Synthetic digests only.
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_V2_KERNEL_REGISTRY_VERSION,
  ANALYTICS_V2_MAX_KERNEL_ID,
  analyticsV2BaselineRunStamp,
  analyticsV2CompatibilitySha256,
  analyticsV2KernelRegistry,
  resolveAnalyticsV2Kernel,
  validAnalyticsV2KernelEntry,
  type AnalyticsV2KernelEntry,
} from "../src/analytics-v2/kernel";

const entry = (kernelId: number, closure = String(kernelId % 10).repeat(64)): AnalyticsV2KernelEntry => ({
  kernelId,
  productionCommit: "d43c8f92a059d9c577776f7eca8a331eb305b8a6",
  vendorManifestSha256: "a".repeat(64),
  computeClosureSha256: closure,
  priceRegistrySha256: "b".repeat(64),
  priceRegistryVersion: "app-official-api-prices-v0.8",
  methodVersion: "analytics-v2-method-v1",
});
const registryOf = (kernels: unknown, schemaVersion: unknown = ANALYTICS_V2_KERNEL_REGISTRY_VERSION) =>
  ({ schemaVersion, rule: "synthetic", kernels });
const refusesRegistry = (value: unknown) =>
  expect(() => analyticsV2KernelRegistry(value)).toThrow("ANALYTICS_V2_KERNEL_REGISTRY_INVALID");

describe("kernel registry (K-STAMP)", () => {
  it("accepts ids 1..n with distinct identities, and the repository registry", () => {
    expect(analyticsV2KernelRegistry(registryOf([entry(1), entry(2)])).map((kernel) => kernel.kernelId)).toEqual([1, 2]);
    const repository = analyticsV2KernelRegistry();
    expect(repository.map((kernel) => kernel.kernelId)).toEqual(repository.map((_, index) => index + 1));
  });

  it("refuses a malformed registry as a whole", () => {
    refusesRegistry(null);
    refusesRegistry([entry(1)]);
    refusesRegistry(registryOf([entry(1)], "analytics-v2-kernel-registry-v0"));
    refusesRegistry(registryOf("kernels"));
    refusesRegistry(registryOf([]));
    // Ids are 1, 2, ... with no gap, in order.
    refusesRegistry(registryOf([entry(2)]));
    refusesRegistry(registryOf([entry(1), entry(3)]));
    refusesRegistry(registryOf([entry(2), entry(1)]));
    refusesRegistry(registryOf([entry(1), entry(1, "c".repeat(64))]));
    // Two entries may not name the same code.
    refusesRegistry(registryOf([entry(1, "c".repeat(64)), entry(2, "c".repeat(64))]));
    // One bad entry refuses the registry.
    refusesRegistry(registryOf([entry(1), { ...entry(2), extra: true }]));
  });

  it("refuses an entry outside its closed shape or the smallint range", () => {
    const refusesEntry = (value: unknown) =>
      expect(() => validAnalyticsV2KernelEntry(value)).toThrow("ANALYTICS_V2_KERNEL_REGISTRY_INVALID");
    expect(validAnalyticsV2KernelEntry(entry(ANALYTICS_V2_MAX_KERNEL_ID)).kernelId).toBe(32_767);
    for (const kernelId of [0, -1, 1.5, ANALYTICS_V2_MAX_KERNEL_ID + 1, Number.NaN, "1"]) {
      refusesEntry({ ...entry(1), kernelId });
    }
    const { methodVersion: _method, ...missing } = entry(1);
    refusesEntry(missing);
    refusesEntry({ ...entry(1), extra: "x" });
    refusesEntry(null);
    refusesEntry([entry(1)]);
    for (const [key, value] of [
      ["productionCommit", "d43c8f92"], ["productionCommit", "D".repeat(40)],
      ["vendorManifestSha256", "a".repeat(63)], ["computeClosureSha256", "A".repeat(64)],
      ["priceRegistrySha256", 5], ["priceRegistryVersion", "has space"], ["priceRegistryVersion", "x".repeat(65)],
      ["methodVersion", "analytics-v2-method-v0"], ["methodVersion", "analytics-v2-method"],
    ] as const) {
      refusesEntry({ ...entry(1), [key]: value });
    }
  });

  it("resolves an identity only to the entry that names it", () => {
    const registry = analyticsV2KernelRegistry(registryOf([entry(1), entry(2)]));
    const identity = { vendorManifestSha256: "a".repeat(64), computeClosureSha256: "2".repeat(64),
      methodVersion: "analytics-v2-method-v1" };
    expect(resolveAnalyticsV2Kernel(identity, registry).kernelId).toBe(2);
    for (const other of [{ ...identity, computeClosureSha256: "9".repeat(64) }, { ...identity, vendorManifestSha256: "f".repeat(64) },
      { ...identity, methodVersion: "analytics-v2-method-v2" }, null]) {
      expect(() => resolveAnalyticsV2Kernel(other, registry)).toThrow("ANALYTICS_V2_KERNEL_UNREGISTERED");
    }
    expect(analyticsV2BaselineRunStamp(entry(1))).toEqual({ kernel: entry(1), manifestVersion: 1 });
    expect(() => analyticsV2BaselineRunStamp({ ...entry(1), kernelId: 0 })).toThrow("ANALYTICS_V2_KERNEL_REGISTRY_INVALID");
  });

  it("moves the compatibility class with the closure, the method and every refusal-deciding resource", async () => {
    const configuration = { memoryModel: "m1", outputModel: "o1", memoryBudgetBytes: 1, maxDayOccurrences: 2,
      maxDayRecordBytes: 3 };
    const base = await analyticsV2CompatibilitySha256(entry(1), configuration);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    const changed = [
      await analyticsV2CompatibilitySha256(entry(1, "e".repeat(64)), configuration),
      await analyticsV2CompatibilitySha256({ ...entry(1), methodVersion: "analytics-v2-method-v2" }, configuration),
      ...await Promise.all((Object.keys(configuration) as Array<keyof typeof configuration>).map((key) =>
        analyticsV2CompatibilitySha256(entry(1), { ...configuration,
          [key]: typeof configuration[key] === "number" ? (configuration[key] as number) + 1 : "other" }))),
    ];
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    // The kernel id itself is not part of the class: the same code under another id is the same class.
    expect(await analyticsV2CompatibilitySha256({ ...entry(1), kernelId: 2 }, configuration)).toBe(base);
  });
});
