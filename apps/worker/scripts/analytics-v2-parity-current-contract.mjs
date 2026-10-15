// Explicit current expectations for the immutable, synthetic Q1 oracle.
// This module never accepts actual output and never rewrites historical files.
// The four-plan expectation is valid only for these fully pinned inputs, whose
// complete corpus and dumps contain no Pro Max evidence. Retained v0.4/v1.4
// fixtures supply metadata only: their Pro 10x numeric values are never used.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const ANALYTICS_V2_Q1_CURRENT_CONTRACT = "q1-pro20-four-plan-v1";
const SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const CORPUS_SHA256 = "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e";
const NOW_MS = 1790856000000;
const OLD_CATALOG = "reviewed-model-catalog-2026-09-23.1";
const CURRENT_CATALOG = "reviewed-model-catalog-2026-09-29.1";
const OLD_BASIS = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
const CURRENT_BASIS = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax25";
const OLD_MODEL_BASIS = "seven_day_codex_pro20x_equivalent_per_model_composition";
const CURRENT_MODEL_BASIS = "seven_day_codex_pro20x_equivalent_per_model_composition_promax25";
const MODEL_GATE = "shared_composition_kernel_identification";
const OLD_PLANS = [
  { planType: "pro", label: "Pro 20x", multiplier: 1 },
  { planType: "prolite", label: "Pro 5x", multiplier: 4 },
  { planType: "plus", label: "Plus", multiplier: 20 },
];
const CURRENT_PLANS = [OLD_PLANS[0], OLD_PLANS[1],
  { planType: "promax", label: "Pro Max 25x", multiplier: 0.8 }, OLD_PLANS[2]];
const PUBLIC_MODEL_METADATA = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", family: "astra", order: 0 },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "sol", order: 1 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", family: "sol", order: 2 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", family: "luna", order: 3 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", family: "terra", order: 4 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", family: "sol", order: 5 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", family: "luna", order: 6 },
];
// Raw-byte pins include every source-data file in the historical SOURCE.json.
// The generator script named there is provenance, not an input to this loader.
const GOLDEN_PINS = {
  "SOURCE.json": "3c1b0e3d6140dfd3203db01f80e68d5103cea7fb767a7716397b2ff1e7e0e8e1",
  "manifest.json": "de9a2368f135121602640d0c2f1e2c1ad7e96a05b2bce5225ae54618c7303361",
  "community-daily-response.json": "4e818e3a38dd6ad61b90caecfe605688b87dd7f7c897d206dc49a7582afe8810",
  "preview.json": "8e7ee7f08d39b3b073490000eff85ae8f311f265ff18868d219cbbe6ca7a0d34",
  "corpus/corpus.json": "3919975a521edfea7a8265f00d698fe748afcc2b00e878f382de415c3733a418",
  "corpus/corpus-owner-a.json": "e36a0c0240af8574ccb3c1db4d1647c47f1367c3fd1576e2724f60b414f12b8e",
  "corpus/corpus-owner-b.json": "d6e99373246b0069ca475b992663985fde3d2d0d556368b7848594f1348ef5de",
  "corpus/corpus-owner-c.json": "4f4c107f2d1bd265cdc912137631c9a186ad17795022d607f1f66645dae621b8",
  "corpus/corpus-owner-d.json": "5b1c2875e6be009b7ecde2a4b919cb57d9fe785f5d037505e73716f8dbcc62e9",
  "dump/diagnostics.json": "6b9424a2ed2351e94e45a93647599d0b63d9d034d5bf14ac6c4ac7675f099904",
  "dump/storage-analytics-db.json": "1aa28113d46fa0c0deb283c7d8fa3dc07528c956c31092b1332a059b6ed3edce",
  "dump/usage-monitor-db.json": "5a935faddaa5070bb75ca2143448e72eee4940b7631eaa29b2897356c9097696",
};
const PER_DATE_PIN = "0b54182eace44ec8ec29dfb9e2c69ae6e391c22525528019d7628b92757f2d91";
const PER_DATE_SOURCE_PIN = "af16626b8d0893a4df2170457b9476f08a335d958413ff826c218f516a8cefdf";
const PUBLIC_KEYS = ["schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis",
  "modelGate", "generatedAt", "days"];
const SUMMARY_KEYS = ["centralUsd", "participantCount", "fitCount", "band80Usd"];
const SPEND_KEYS = ["basis", "coverage", "currency", "fullyPricedUsageEvents", "knownCostUsd",
  "partiallyPricedUsageEvents", "pricingMethodVersion", "registrySha256", "unpricedUsageEvents", "usageEvents"];
const MODEL_DAY_KEYS = ["day", "catalogVersion", "values", "fittedParticipantCount", "unstableParticipantCount",
  "staleParticipantCount", "refusedParticipantCount", "v1ParticipantCount", "unsupportedSourceParticipantCount"];
const contracts = new WeakMap();

function requireThat(condition, code = "HISTORICAL_SHAPE_INVALID") {
  if (!condition) throw new TypeError(`ANALYTICS_V2_Q1_CURRENT_${code}`);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function pinnedText(path, sha256, trimEnd = false) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch { throw new TypeError("ANALYTICS_V2_Q1_CURRENT_INPUT_UNAVAILABLE"); }
  if (trimEnd) text = text.trimEnd();
  requireThat(createHash("sha256").update(text).digest("hex") === sha256, "INPUT_HASH_MISMATCH");
  return text;
}

function currentModelDay(day) {
  requireThat(exactKeys(day, MODEL_DAY_KEYS) && day.catalogVersion === OLD_CATALOG);
  return { ...structuredClone(day), catalogVersion: CURRENT_CATALOG };
}

function currentPlanDay(day, publicDay) {
  requireThat(exactKeys(day, publicDay ? ["day", "combined", "byPlanType", "models"] : ["day", "combined", "byPlanType"])
    && exactKeys(day.byPlanType, ["pro", "prolite", "plus"]) && exactKeys(day.combined, SUMMARY_KEYS));
  for (const summary of Object.values(day.byPlanType)) requireThat(exactKeys(summary, SUMMARY_KEYS));
  const copy = structuredClone(day);
  copy.byPlanType = {
    pro: copy.byPlanType.pro,
    prolite: copy.byPlanType.prolite,
    promax: publicDay
      ? { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null }
      : { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null },
    plus: copy.byPlanType.plus,
  };
  return copy;
}

function currentBreakdowns(value, publicMetadata) {
  requireThat(exactKeys(value, PUBLIC_KEYS) && value.schemaVersion === "community-allowance-breakdowns-v1.1"
    && value.basis === OLD_BASIS && value.referencePlanType === "pro"
    && value.normalization === "pro_x1_prolite_x4_plus_x20" && value.modelBasis === OLD_MODEL_BASIS
    && value.modelGate === MODEL_GATE && value.generatedAt === "2026-10-01T12:00:00.000Z"
    && Array.isArray(value.days) && value.days.length === 69);
  // Current public wire order is the historical eight keys plus modelConfig.
  return {
    schemaVersion: "community-allowance-breakdowns-v1.5",
    basis: CURRENT_BASIS,
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_promax_x0_8_plus_x20",
    modelBasis: CURRENT_MODEL_BASIS,
    modelGate: MODEL_GATE,
    generatedAt: value.generatedAt,
    days: value.days.map((day) => currentPlanDay(day, true)),
    modelConfig: structuredClone(publicMetadata),
  };
}

function currentPreview(value, adminMetadata, modelDays) {
  requireThat(exactKeys(value, ["schemaVersion", "generatedAt", "from", "to", "basis", "referencePlanType",
    "trailingDays", "qualification", "spanFloorPp", "plans", "coverage", "days", "models"])
    && value.schemaVersion === "admin-community-allowance-preview-v0.3" && value.basis === `${OLD_BASIS}_preview`
    && value.referencePlanType === "pro" && value.generatedAt === "2026-10-01T12:00:00.000Z"
    && isDeepStrictEqual(value.plans, OLD_PLANS) && Array.isArray(value.days) && value.days.length === 70
    && exactKeys(value.models, ["modelConfig", "basis", "gate", "days"])
    && value.models.basis === OLD_MODEL_BASIS && value.models.gate === MODEL_GATE
    && isDeepStrictEqual(value.models.modelConfig, adminMetadata.slice(0, 42))
    && Array.isArray(value.models.days) && value.models.days.length === modelDays);
  return {
    ...structuredClone(value),
    schemaVersion: "admin-community-allowance-preview-v0.5",
    basis: `${CURRENT_BASIS}_preview`,
    plans: structuredClone(CURRENT_PLANS),
    days: value.days.map((day) => currentPlanDay(day, false)),
    models: {
      ...structuredClone(value.models),
      basis: CURRENT_MODEL_BASIS,
      modelConfig: structuredClone(adminMetadata),
      days: value.models.days.map(currentModelDay),
    },
  };
}

/** Load only the exact reviewed Q1 lane; unrelated, incomplete or changed inputs fail closed. */
export async function loadQ1CurrentContract(options) {
  requireThat(exactKeys(options, ["goldenDirectory", "perDateExpectedPath"])
    && typeof options.goldenDirectory === "string" && options.goldenDirectory.length > 0
    && typeof options.perDateExpectedPath === "string" && options.perDateExpectedPath.length > 0, "ARGUMENT_INVALID");
  const texts = Object.fromEntries(await Promise.all(Object.entries(GOLDEN_PINS).map(async ([path, pin]) =>
    [path, await pinnedText(join(options.goldenDirectory, path), pin)])));
  const [perDateText, perDateSourceText, adminText, publicText] = await Promise.all([
    pinnedText(options.perDateExpectedPath, PER_DATE_PIN),
    pinnedText(join(dirname(options.perDateExpectedPath), "SOURCE.json"), PER_DATE_SOURCE_PIN),
    pinnedText(new URL("../analytics-v2-test/fixtures/allowance-preview-v04.json", import.meta.url),
      "d4071f52424102e622c56b4fbe97d110aff179534a1872496d59021257653a3b", true),
    pinnedText(new URL("../analytics-v2-test/fixtures/allowance-breakdowns-v14-expected.json", import.meta.url),
      "cc7f6ed051aefcbe30af249532bb622bfd9cdae6d408c27d479cc9db304ac34d", true),
  ]);
  const manifest = JSON.parse(texts["manifest.json"]), source = JSON.parse(texts["SOURCE.json"]);
  const corpus = JSON.parse(texts["corpus/corpus.json"]), perDateSource = JSON.parse(perDateSourceText);
  requireThat(manifest.schemaVersion === "gcp-fastpath-oracle-manifest-v1" && manifest.sourceCommit === SOURCE_COMMIT
    && manifest.nowMs === NOW_MS && manifest.corpus?.sha256 === CORPUS_SHA256
    && source.schemaVersion === "gcp-fastpath-golden-source-v1" && source.oracleSourceCommit === SOURCE_COMMIT
    && corpus.schemaVersion === "gcp-fastpath-oracle-corpus-v1" && corpus.sourceCommit === SOURCE_COMMIT && corpus.synthetic === true
    && perDateSource.schemaVersion === "gcp-fastpath-dense-golden-source-v1" && perDateSource.sourceCommit === SOURCE_COMMIT
    && perDateSource.q1Corpus?.sha256 === CORPUS_SHA256, "SOURCE_IDENTITY_INVALID");
  // This predicate is supplementary to the fixed complete-byte pins, never
  // a general parser or a claim about an arbitrary corpus with hidden fields.
  requireThat(Object.values(texts).every((text) => !text.toLowerCase().includes("promax")), "SOURCE_IDENTITY_INVALID");
  const adminMetadata = JSON.parse(adminText).models.modelConfig;
  const publicMetadata = JSON.parse(publicText).modelConfig;
  requireThat(adminMetadata.length === 43
    && adminMetadata.every((entry) => exactKeys(entry, ["modelId", "label", "allowanceTrack", "pricingStatus"]))
    && isDeepStrictEqual(adminMetadata[42], { modelId: "gpt-6.1-sol", label: "GPT-6.1 Sol", allowanceTrack: "primary", pricingStatus: "published" })
    && isDeepStrictEqual(publicMetadata, PUBLIC_MODEL_METADATA), "METADATA_INVALID");
  const original = deepFreeze({ golden: JSON.parse(texts["community-daily-response.json"]),
    goldenPreview: JSON.parse(texts["preview.json"]), perDateExpected: JSON.parse(perDateText) });
  requireThat(original.perDateExpected.schemaVersion === "gcp-fastpath-dense-per-date-v1"
    && original.perDateExpected.nowMs === NOW_MS && Array.isArray(original.perDateExpected.unresolved)
    && original.perDateExpected.unresolved.length === 0 && original.perDateExpected.days.length === 70, "PER_DATE_INVALID");
  const golden = structuredClone(original.golden);
  requireThat(Array.isArray(golden.days) && golden.days.length === 168);
  for (const day of golden.days) {
    const spend = day.payload?.apiEquivalentSpend;
    requireThat(exactKeys(spend, SPEND_KEYS) && spend.pricingMethodVersion === "server-api-price-equivalent-v0.5"
      && spend.registrySha256 === "48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9");
    spend.pricingMethodVersion = "server-api-price-equivalent-v0.6";
    spend.registrySha256 = "d57a7443bb43a756f1458872897dfcfcafdde0893433fc83b1036d58184de78d";
  }
  golden.allowanceBreakdowns = currentBreakdowns(original.golden.allowanceBreakdowns, publicMetadata);
  const perDateExpected = structuredClone(original.perDateExpected);
  perDateExpected.allowanceBreakdowns = currentBreakdowns(original.perDateExpected.allowanceBreakdowns, publicMetadata);
  perDateExpected.preview = currentPreview(original.perDateExpected.preview, adminMetadata, 70);
  perDateExpected.days = original.perDateExpected.days.map((day) => ({ ...structuredClone(day), payload: currentModelDay(day.payload) }));
  const expected = { golden, goldenPreview: currentPreview(original.goldenPreview, adminMetadata, 56), perDateExpected };
  const contract = deepFreeze({ id: ANALYTICS_V2_Q1_CURRENT_CONTRACT, sourceCommit: SOURCE_COMMIT,
    corpusSha256: CORPUS_SHA256, nowMs: NOW_MS, expected });
  contracts.set(contract, original);
  return contract;
}

function originalFor(contract) {
  const original = contracts.get(contract);
  requireThat(original !== undefined, "CONTRACT_INVALID");
  return original;
}

/** Accept historical expectation inputs only. Actual output cannot enter the builder. */
export function currentQ1ComparisonInputs(contract, inputs) {
  const original = originalFor(contract);
  requireThat(exactKeys(inputs, ["golden", "goldenPreview", "perDateExpected"])
    && isDeepStrictEqual(inputs, original), "COMPARISON_INPUT_INVALID");
  return contract.expected;
}

/** The independent per-date comparator needs only its exact historical input. */
export function currentQ1PerDateExpected(contract, expected) {
  requireThat(isDeepStrictEqual(expected, originalFor(contract).perDateExpected), "PER_DATE_INPUT_INVALID");
  return contract.expected.perDateExpected;
}
