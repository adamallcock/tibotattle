// KM-7: community allowance breakdowns v1.3 over the vendored d43c8f92
// projection. The metadata block is the catalog baseline's public roster
// (manifest_version 1); the relabel and the block are the only differences
// from the v1.1 bytes the vendored projectPublicAllowanceGraph returns.
// Synthetic, content-free inputs only.
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
import { REVIEWED_MODEL_CATALOG } from "../vendor/analytics-d43c8f92/apps/web/public/model-catalog.generated.js";
import { analyticsV2PublicModelMetadata } from "../src/analytics-v2/community-daily-route";
import {
  PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION,
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
const MANIFEST_1_METADATA_SHA256 = "c294cbf50857a70c10659a5a82a221ca6c85e82ac2bb4a564b8fff8a08452289";

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

  it("is the committed baseline's public roster, identical from the compiled and committed manifests", () => {
    expect(buildPublicModelMetadata(committedBaseline as never)).toEqual(metadata);
    expect(committedBaseline.version).toBe(1);
    const roster = committedBaseline.models.filter((model) => model.provider === "openai_codex"
      && model.allowanceTrack === "primary" && model.hidden === false);
    expect(metadata.map(({ id, label }) => ({ id, label })))
      .toEqual(roster.map(({ id, label }) => ({ id, label })));
    // Never a separate-track or other-provider model: the reader refuses a block that names one.
    expect(metadata.some((entry) => entry.id === "gpt-5.3-codex-spark" || entry.id.startsWith("claude-"))).toBe(false);
    expect(metadata).toHaveLength(41);
    expect(isPublicModelMetadataBlock(metadata)).toBe(true);
    expect(sha256(JSON.stringify(metadata))).toBe(MANIFEST_1_METADATA_SHA256);
    // The parity compare's declared block (scripts/analytics-v2-parity-compare.mjs) is this, byte for byte.
    expect(JSON.stringify(declaredFixture)).toBe(JSON.stringify(metadata));
  });

  it("names exactly what the d43c8f92 page's reviewed catalog draws as primary Codex models", () => {
    const pageRoster = (REVIEWED_MODEL_CATALOG as readonly { id: string; label: string; provider: string;
      allowanceTrack: string }[]).filter((model) => model.provider === "openai_codex"
      && model.allowanceTrack === "primary").map(({ id, label }) => ({ id, label }));
    expect(metadata.map(({ id, label }) => ({ id, label }))).toEqual(pageRoster);
  });

  it("keeps the d43c8f92 page's presentation: the seven pinned models first, then catalog order", () => {
    const pinned = PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION[1]!.pinned;
    expect(pinned.map(([id]) => id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra",
      "gpt-6-luna", "gpt-5.6-luna", "gpt-5.5"]);
    // d43c8f92 allowanceModelPresentation: preferred index, else 7 + catalog index.
    const pageOrder = (id: string, index: number) => {
      const preferred = pinned.findIndex(([pin]) => pin === id);
      return preferred < 0 ? pinned.length + index : preferred;
    };
    expect(metadata.map((entry) => entry.order)).toEqual(metadata.map((entry, index) => pageOrder(entry.id, index)));
    for (const entry of metadata) {
      const pin = pinned.find(([id]) => id === entry.id);
      expect(entry.family).toBe(pin === undefined ? "generic" : pin[1]);
    }
    expect([...metadata].sort((a, b) => a.order - b.order).slice(0, 8).map((entry) => entry.id))
      .toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna",
        "gpt-5.5", "codex-auto-review"]);
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
    const withModel = (index: number, change: Record<string, unknown>) =>
      ({ version: 1, models: models.map((model, at) => at === index ? { ...model, ...change } : model) });
    const sol = models.findIndex((model) => model.id === "gpt-6-sol");
    expect(code(withModel(sol, { label: "<b>GPT</b>" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(withModel(0, { id: "codex/auto" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code(withModel(1, { id: models[0]!.id }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // A pinned model that leaves the roster refuses the block rather than reordering it.
    expect(code(withModel(sol, { allowanceTrack: "spark" }))).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    expect(code({ version: 1, models: "x" })).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    const tooMany = { version: 1, models: [...models, ...Array.from({ length: 90 }, (_, index) => ({
      id: `synthetic-model-${index}`, label: `Synthetic ${index}`, provider: "openai_codex",
      allowanceTrack: "primary", hidden: false }))] };
    expect(code(tooMany)).toBe("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    // A hidden model is never named.
    const hidden = buildPublicModelMetadata(withModel(0, { hidden: true }) as never);
    expect(hidden.some((entry) => entry.id === models[0]!.id)).toBe(false);
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
