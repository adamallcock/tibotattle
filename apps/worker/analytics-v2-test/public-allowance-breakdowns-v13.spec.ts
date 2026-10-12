// KM-7: community allowance breakdowns v1.3 over the vendored d43c8f92
// projection. The metadata block is the catalog baseline's (manifest_version
// 1) public roster: exactly the six models the d43c8f92 public page charts,
// never a model the owner's selected comparison keeps off the page. The
// relabel and the block are the only differences from the v1.1 bytes the
// vendored projectPublicAllowanceGraph returns. Synthetic, content-free inputs
// only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import committedBaseline from "../catalog/manifest-0001.json";
import declaredFixture from "./fixtures/breakdowns-v13-declared-model-metadata.json";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
} from "../vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance";
import { projectPublicAllowanceGraph } from "../vendor/analytics-d43c8f92/entry";
import {
  ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay,
} from "../vendor/analytics-d43c8f92/packages/telemetry-contract/index.js";
import { PUBLIC_ALLOWANCE_MODEL_CONFIG } from "../vendor/analytics-d43c8f92/apps/web/public/community-data.js";
import { analyticsV2PublicModelMetadata } from "../src/analytics-v2/community-daily-route";
import {
  PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION,
  PUBLIC_MODEL_METADATA_MAX_ENTRIES,
  PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION,
  PublicModelMetadataError,
  buildPublicModelMetadata,
  isPublicModelMetadataBlock,
  reducePublicAllowanceBreakdownsV13,
  wrapPublicAllowanceBreakdownsV13,
} from "../src/analytics-v2/public-allowance-breakdowns-v13";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const YESTERDAY = "2026-09-06";
/** sha256 of JSON.stringify(the manifest_version 1 block): changing it is a public contract change. */
const MANIFEST_1_METADATA_SHA256 = "8c8034812a9ed782c0467eb30d7c1feb5dc5a1a1f65e56dc305e58d3b962bfae";
/**
 * The d43c8f92 public page's model cards, in order, with each model's
 * model-visuals.js theme (d43c8f92 apps/web/test/public-allowance-views.test.mjs
 * asserts this card order and that GPT-5.5 is not shown).
 */
const D43C8F92_PUBLIC_CARDS = [
  ["gpt-6-astra", "astra"], ["gpt-6-sol", "sol"], ["gpt-6-luna", "luna"],
  ["gpt-5.6-terra", "terra"], ["gpt-5.6-sol", "sol"], ["gpt-5.6-luna", "luna"],
] as const;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function v11Breakdowns(values: unknown[] = [["gpt-6-astra", 1_166, 1], ["gpt-5.4", 410.5, 1]]) {
  const modelDay = (day: string) => {
    const value = projectAdminModelHistoryDay({
      day, catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION, values,
      fittedParticipantCount: 1, unstableParticipantCount: 1, staleParticipantCount: 0,
      refusedParticipantCount: 1, v1ParticipantCount: 3, unsupportedSourceParticipantCount: 1,
    });
    if (value === null) throw new Error("invalid synthetic model day");
    return value;
  };
  const preview = buildAdminCommunityAllowancePreview([
    { participantId: "synthetic-pro", planType: "pro", capacityNanousd: 1_200_000_000_000,
      lastObservedAt: `${YESTERDAY}T12:00:00.000Z` },
    { participantId: "synthetic-plus", planType: "plus", capacityNanousd: 60_000_000_000,
      lastObservedAt: `${YESTERDAY}T12:00:00.000Z` },
  ], NOW, undefined, {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
    basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
    days: [modelDay(YESTERDAY), modelDay("2026-09-07")],
  });
  const graph = projectPublicAllowanceGraph(
    { generated_at: new Date(NOW).toISOString(), payload_json: JSON.stringify(preview) },
    { publishedDays: ["2026-09-05", YESTERDAY], nowMs: NOW },
  );
  if (graph === null) throw new Error("no synthetic graph");
  return graph.breakdowns;
}

describe("the manifest_version 1 model-metadata block", () => {
  const metadata = analyticsV2PublicModelMetadata();
  const presentation = PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION[1]!;
  const primary = committedBaseline.models.filter((model) => model.provider === "openai_codex"
    && model.allowanceTrack === "primary");

  it("is the committed baseline's public roster, identical from the compiled and committed manifests", () => {
    expect(buildPublicModelMetadata(committedBaseline as never)).toEqual(metadata);
    expect(committedBaseline.version).toBe(1);
    const hidden = new Set(presentation.publicHidden);
    const roster = primary.filter((model) => model.hidden === false && !hidden.has(model.id));
    expect(metadata.map(({ id, label }) => ({ id, label })))
      .toEqual(roster.map(({ id, label }) => ({ id, label })));
    // Never a separate-track or other-provider model: the reader refuses a block that names one.
    expect(metadata.some((entry) => entry.id === "gpt-5.3-codex-spark" || entry.id.startsWith("claude-"))).toBe(false);
    expect(metadata).toHaveLength(6);
    expect(isPublicModelMetadataBlock(metadata)).toBe(true);
    expect(sha256(JSON.stringify(metadata))).toBe(MANIFEST_1_METADATA_SHA256);
    // The parity compare's declared block (scripts/analytics-v2-parity-compare.mjs) is this, byte for byte.
    expect(JSON.stringify(declaredFixture)).toBe(JSON.stringify(metadata));
  });

  it("names exactly the models the d43c8f92 public page charts, with its labels, in its card order", () => {
    const byOrder = [...metadata].sort((left, right) => left.order - right.order);
    expect(byOrder.map(({ id, label }) => ({ modelId: id, label })))
      .toEqual(PUBLIC_ALLOWANCE_MODEL_CONFIG.map(({ modelId, label }) => ({ modelId, label })));
    expect(byOrder.map(({ id, family, order }) => [id, family, order]))
      .toEqual(D43C8F92_PUBLIC_CARDS.map(([id, family], order) => [id, family, order]));
    expect(presentation.pinned.map(([id, family]) => [id, family])).toEqual(D43C8F92_PUBLIC_CARDS.map((card) => [...card]));
  });

  it("never names a model the owner's selected comparison keeps off the public page", () => {
    // The tolerant reader charts every model a valid block names, even one its
    // own hide list keeps off (claude/gcp-fp-w-web-onmain chartedModelsWith), so
    // the only guarantee is never naming one. GPT-5.5 is the case the owner's
    // 2026-09-28 change and the d43c8f92 page tests pin.
    const named = new Set(metadata.map((entry) => entry.id));
    expect(named.has("gpt-5.5")).toBe(false);
    expect(presentation.publicHidden.filter((id) => named.has(id))).toEqual([]);
    // The hide list is the d43c8f92 page's own: exactly the baseline's primary
    // models it does not chart (35), each listed once, none pinned.
    const charted = new Set(PUBLIC_ALLOWANCE_MODEL_CONFIG.map((model) => model.modelId));
    expect([...presentation.publicHidden].sort())
      .toEqual(primary.map((model) => model.id).filter((id) => !charted.has(id)).sort());
    expect(new Set(presentation.publicHidden).size).toBe(35);
    expect(presentation.publicHidden.some((id) => presentation.pinned.some(([pin]) => pin === id))).toBe(false);
  });

  it("fails closed on a manifest it cannot publish", () => {
    const models = committedBaseline.models;
    const code = (manifest: unknown) => {
      try {
        buildPublicModelMetadata(manifest as never);
      } catch (error) {
        return error instanceof PublicModelMetadataError ? error.code : "other";
      }
      return null;
    };
    expect(code({ version: 2, models })).toBe("PUBLIC_MODEL_METADATA_MANIFEST_UNSUPPORTED");
    expect(code({ version: "1", models })).toBe("PUBLIC_MODEL_METADATA_MANIFEST_UNSUPPORTED");
    expect(code(null)).toBe("PUBLIC_MODEL_METADATA_MANIFEST_UNSUPPORTED");
    const at = (id: string) => models.findIndex((model) => model.id === id);
    const withModel = (index: number, change: Record<string, unknown>) =>
      ({ version: 1, models: models.map((model, position) => position === index ? { ...model, ...change } : model) });
    const synthetic = (index: number, change: Record<string, unknown> = {}) => ({
      id: `synthetic-model-${index}`, label: `Synthetic ${index}`, provider: "openai_codex",
      allowanceTrack: "primary", hidden: false, ...change });
    const appended = (...extra: unknown[]) => ({ version: 1, models: [...models, ...extra] });
    const sol = at("gpt-6-sol");
    expect(code(withModel(sol, { label: "<b>GPT</b>" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(appended(synthetic(0, { id: "synthetic/model" })))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(appended({ ...models[sol]! }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // A pinned model that leaves the public roster refuses the block rather than reordering it.
    expect(code(withModel(sol, { allowanceTrack: "spark" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(withModel(sol, { hidden: true }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // A hide list that no longer matches the manifest refuses the block rather than naming less.
    expect(code({ version: 1, models: models.filter((model) => model.id !== "gpt-5.5") }))
      .toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(withModel(at("gpt-5.5"), { allowanceTrack: "spark" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code({ version: 1, models: "x" })).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // The reader's 128-entry bound, counted over named models only.
    const room = PUBLIC_MODEL_METADATA_MAX_ENTRIES - metadata.length;
    expect(code(appended(...Array.from({ length: room }, (_, index) => synthetic(index))))).toBeNull();
    expect(code(appended(...Array.from({ length: room + 1 }, (_, index) => synthetic(index)))))
      .toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // A roster model neither pinned nor hidden is named after the pinned ones,
    // at the pinned count plus its public roster index (six precede it); a
    // manifest-hidden one is never named.
    const extra = buildPublicModelMetadata(appended(synthetic(0)) as never);
    expect(extra.find((entry) => entry.id === "synthetic-model-0"))
      .toEqual({ id: "synthetic-model-0", label: "Synthetic 0", family: "generic", order: 6 + 6 });
    expect(buildPublicModelMetadata(appended(synthetic(0, { hidden: true })) as never)).toEqual(metadata);
  });
});

describe("v1.3 over the vendored v1.1 projection", () => {
  const metadata = analyticsV2PublicModelMetadata();

  it("differs from the v1.1 bytes by exactly the relabel and the trailing block", () => {
    const v11 = v11Breakdowns();
    const v11Text = JSON.stringify(v11);
    const v13 = wrapPublicAllowanceBreakdownsV13(v11, metadata);
    const v13Text = JSON.stringify(v13);
    expect(v13.schemaVersion).toBe(PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION);
    expect(Object.keys(v13)).toEqual([...Object.keys(v11), "modelConfig"]);
    const relabelled = v11Text.replace("\"community-allowance-breakdowns-v1.1\"",
      "\"community-allowance-breakdowns-v1.3\"");
    expect(v13Text).toBe(`${relabelled.slice(0, -1)},"modelConfig":${JSON.stringify(metadata)}}`);
    // Undone, it is the v1.1 block byte for byte, and the input was not mutated.
    const reduced = reducePublicAllowanceBreakdownsV13(JSON.parse(v13Text));
    expect(JSON.stringify(reduced.base)).toBe(v11Text);
    expect(reduced.metadata).toEqual(metadata);
    expect(JSON.stringify(v11)).toBe(v11Text);
    // A publicly hidden model's tuple (GPT-5.4 here) is served as the oracle
    // serves it, and is never named.
    expect(v13.days.some((day) => day.models.some(([id]) => id === "gpt-5.4"))).toBe(true);
    expect(v13.modelConfig.some((entry) => entry.id === "gpt-5.4")).toBe(false);
  });

  it("never names a model the manifest does not, and leaves its tuple to the reader", () => {
    const v11 = v11Breakdowns();
    // Unreachable through the vendored validation (it admits reviewed ids only);
    // forced here to show the wrapper neither names nor rewrites it.
    const forced = { ...v11, days: v11.days.map((day) => ({ ...day,
      models: [...day.models, ["synthetic-unseen-model", 12.5, 1] as const] })) };
    const v13 = wrapPublicAllowanceBreakdownsV13(forced, metadata);
    expect(v13.modelConfig.some((entry) => entry.id === "synthetic-unseen-model")).toBe(false);
    expect(v13.days).toEqual(forced.days);
    // The vendored projection itself refuses an unreviewed id upstream.
    expect(() => v11Breakdowns([["synthetic-unseen-model", 12.5, 1]])).toThrow();
  });

  it("refuses anything but the exact v1.1 envelope, and an invalid block", () => {
    const v11 = v11Breakdowns();
    const refused = (value: unknown, block: unknown = metadata) => {
      try {
        wrapPublicAllowanceBreakdownsV13(value as never, block as never);
      } catch (error) {
        return error instanceof PublicModelMetadataError ? error.code : "other";
      }
      return null;
    };
    expect(refused({ ...v11, schemaVersion: "community-allowance-breakdowns-v1.2" }))
      .toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
    expect(refused({ ...v11, extra: 1 })).toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
    const { days, ...noDays } = v11;
    expect(refused(noDays)).toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
    expect(refused({ days, ...noDays })).toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
    expect(refused(null)).toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
    expect(refused(v11, [{ ...metadata[0], tone: "x" }])).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(refused(v11, [metadata[0], metadata[0]])).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(refused(v11, [{ ...metadata[0], order: 10_000 }])).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(refused(v11, [{ ...metadata[0], family: "Sol" }])).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(refused(v11, null)).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(refused(v11, [])).toBeNull();
  });

  it("reduces only a v1.3 block in the declared shape", () => {
    const v13 = JSON.parse(JSON.stringify(wrapPublicAllowanceBreakdownsV13(v11Breakdowns(), metadata)));
    const reduceCode = (value: unknown) => {
      try {
        reducePublicAllowanceBreakdownsV13(value);
      } catch (error) {
        return error instanceof PublicModelMetadataError ? error.code : "other";
      }
      return null;
    };
    expect(reduceCode(v13)).toBeNull();
    const { modelConfig, ...withoutBlock } = v13;
    for (const candidate of [
      withoutBlock,
      { ...withoutBlock, schemaVersion: "community-allowance-breakdowns-v1.1", modelConfig },
      { ...v13, catalogManifestVersion: 1 },
      { modelConfig, ...withoutBlock },
      { ...v13, modelConfig: [...modelConfig, { ...modelConfig[0], id: "synthetic-x", order: modelConfig[0].order }] },
      { ...v13, modelConfig: "x" },
      null,
    ]) expect(reduceCode(candidate)).toBe("PUBLIC_ALLOWANCE_BREAKDOWNS_V13_INVALID");
  });
});
