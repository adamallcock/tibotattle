import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { prepareAnalyticsV2CurrentCorrectionHead, currentCorrectionNonSpend,
  validAnalyticsV2CurrentCorrectionStoredReceipt, ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS,
  type CurrentCorrectionMember, type CurrentCorrectionHead } from "../src/analytics-v2/current-correction";
import { prepareAnalyticsV2RepriceHead } from "../src/analytics-v2/reprice";
import { analyticsV2DailyContentSha256 } from "../src/analytics-v2/store-run";
import { analyticsV2PriceInput, analyticsV2PriceInputsBytes, encodeAnalyticsV2PriceInputs, priceAnalyticsV2Input } from "../src/analytics-v2/price-attribution";
import { createV11DailyProjectionValues, foldV11DailyProjectionValues, buildCommunityDailyPayload,
  publicInputs, type V11DailyProjectionValues } from "../vendor/analytics-d43c8f92/entry";
import { dayMs, syntheticOwner, usage } from "./fixtures/synthetic-occurrences.mjs";
const DAY = "2026-09-20", OLD = "11111111-1111-4111-8111-111111111111", CURRENT = "22222222-2222-4222-8222-222222222222";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function member(n = 1, count = 1, overrides: Record<string,unknown> = {}): Promise<CurrentCorrectionMember> {
  const rows = Array.from({ length: count }, (_, i) => ({
    ...JSON.parse(usage(syntheticOwner(n), i + 1, dayMs(DAY) + 1000 * (i + 1)).recordJson),
    ...(count > 1 ? { modelId: `synthetic-model-${String(i).padStart(3,"0")}` } : {}),
    ...overrides,
  }));
  let current = createV11DailyProjectionValues(DAY);
  for (let offset = 0; offset < rows.length; offset += 200) current = foldV11DailyProjectionValues(current,rows.slice(offset,offset+200));
  const events = rows.map(row => { const input = analyticsV2PriceInput(row); return { input,priced: priceAnalyticsV2Input(input) }; });
  const { inputs } = await encodeAnalyticsV2PriceInputs(events);
  const saved = structuredClone(current); saved.registrySha256 = "a".repeat(64); saved.pricingMethodVersion = "server-api-price-equivalent-v0.5";
  return { ownerDigest: n.toString(16).padStart(64,"0"),version: 1,devices: n,values: saved,valuesSha256: hash(saved),
    runId: OLD,priceKernelId: 11,manifestVersion: 1,participantLinked: true,excluded: false,
    priceRunId: CURRENT,inputKernelId: 23,inputs: { ...inputs,bytes: analyticsV2PriceInputsBytes(inputs.data) },
    archivePresent: false,archiveValuesSha256: null,current: { values: current,refusal: null,runId: CURRENT,kernelId: 23,
      manifestVersion: 1,priceManifestVersion: 1,usageEvents: count,runState: "complete",runMode: "full",
      runKernelId: 23,runManifestVersion: 1,runFinished: true } };
}
async function head(members: readonly CurrentCorrectionMember[]): Promise<CurrentCorrectionHead> {
  const active = [...members].filter(m => !m.excluded).sort((a,b) => a.ownerDigest.localeCompare(b.ownerDigest));
  const normalized = active.map(m => ({ ...structuredClone(m.values as V11DailyProjectionValues),
    registrySha256: createV11DailyProjectionValues(DAY).registrySha256,
    pricingMethodVersion: createV11DailyProjectionValues(DAY).pricingMethodVersion }));
  const payload = buildCommunityDailyPayload({ day: DAY,revision: 4,releasedAt: "2026-09-22T03:00:00.000Z",
    ...publicInputs(normalized,active.map(m => m.devices)) }) as unknown as Record<string,unknown>;
  (payload.apiEquivalentSpend as Record<string,unknown>).registrySha256 = "a".repeat(64);
  (payload.apiEquivalentSpend as Record<string,unknown>).pricingMethodVersion = "server-api-price-equivalent-v0.5";
  return { day: DAY,revision: 4,payload,payloadSha256: await analyticsV2DailyContentSha256(payload),recorded: true,members };
}
async function outcome(m: CurrentCorrectionMember) { return prepareAnalyticsV2CurrentCorrectionHead(await head([m]),23); }
describe("current source is a new contribution, never a saved-input association", () => {
  it("corrects target identity with identical complete non-spend values and original event times", async () => {
    const m = await member(), original = structuredClone(m), result = await outcome(m);
    expect(result.outcome).toBe("changed");
    expect(result.members[0]!.provenance).toMatchObject({ inputSource: "current-owner-day",priorVersion: 1,
      priorValuesSha256: m.valuesSha256,sourceRunId: CURRENT,sourceKernelId: 23,sourceInputsSha256: m.inputs!.sha256 });
    expect(currentCorrectionNonSpend(result.members[0]!.values)).toBe(currentCorrectionNonSpend(m.values as V11DailyProjectionValues));
    expect(result.members[0]!.events[0]!.input.eventTimeMs).toBe(dayMs(DAY)+1000);
    expect(m).toEqual(original);
    expect(await prepareAnalyticsV2RepriceHead(await head([m]))).toMatchObject({ outcome: "refused",refusal: "price_input_association_unproven" });
  });
  it("prefers a genuine archive even when current evidence is absent", async () => {
    const m = await member(); m.current = null; m.archivePresent = true; m.archiveValuesSha256 = m.valuesSha256;
    m.priceRunId = OLD; m.inputKernelId = 11;
    expect(await outcome(m)).toMatchObject({ outcome: "changed",members: [{ provenance: { inputSource: "archive",sourceRunId: OLD,sourceKernelId: 11 } }] });
  });
  it("retains a quota/session-only member without inputs, a new version or invented provenance", async () => {
    const active = await member(), quota = await member(2);
    const values = createV11DailyProjectionValues(DAY); values.counts.quota = 2; values.counts.session = 3;
    values.registrySha256 = "a".repeat(64); values.pricingMethodVersion = "server-api-price-equivalent-v0.5";
    quota.values = values; quota.valuesSha256 = hash(values); quota.current = null; quota.inputs = null;
    const result = await prepareAnalyticsV2CurrentCorrectionHead(await head([active,quota]),23);
    expect(result).toMatchObject({ outcome: "changed" });
    expect(result.members[1]).toMatchObject({ member: { version: 1,devices: 2 },provenance: null,events: [],
      values: { counts: { usage: 0,quota: 2,session: 3 } } });
  });
  it("preserves an in-grammar unknown model and partial token evidence", async () => {
    const modelId = "synthetic-unknown-model";
    const m = await member(1,1,{ modelId,components: { inputUncachedTokens: 3,inputCacheReadTokens: null,
      inputCacheWriteTokens: 0,outputTextTokens: 7,outputReasoningTokens: null,outputCombinedTokens: null } });
    const result = await outcome(m);
    expect(result).toMatchObject({ outcome: "changed" });
    expect(result.members[0]!.values.tokens).toMatchObject({ effectiveOutput: { knownSum: "7",unavailable: 1 },
      nonOverlappingTotal: { knownSum: "10",unavailable: 1 } });
  });
  it("does not invent a valid canonical model from an empty model name", async () => {
    await expect(member(1,1,{ modelId: "" })).rejects.toMatchObject({ code: "TYPED_TELEMETRY_INVALID" });
  });
  it.each(["values", "run", "kernel", "bytes"])("does not fall back from a present bad archive: %s", async kind => {
    const m = await member(); m.archivePresent = true; m.archiveValuesSha256 = m.valuesSha256; m.priceRunId = OLD; m.inputKernelId = 11;
    if (kind === "values") m.archiveValuesSha256 = "b".repeat(64);
    if (kind === "run") m.priceRunId = CURRENT;
    if (kind === "kernel") m.inputKernelId = 23;
    if (kind === "bytes") m.inputs = { ...m.inputs!,bytes: new Uint8Array([255,1]) };
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: kind === "bytes" ? "price_inputs_corrupt" : "price_input_association_unproven",members: [] });
  });
  it.each(["missing", "refused", "price", "run", "kernel", "manifest", "price-manifest", "run-state", "run-mode", "run-kernel", "run-manifest", "unfinished"])("refuses a current-source boundary failure: %s", async kind => {
    const m = await member(); let code = "current_source_binding_unproven";
    if (kind === "missing") { m.current = null; code = "current_source_unavailable"; }
    if (kind === "refused") { m.current!.refusal = "synthetic_refusal"; code = "current_source_unavailable"; }
    if (kind === "price") { m.inputs = null; code = "current_source_unavailable"; }
    if (kind === "run") m.priceRunId = OLD;
    if (kind === "kernel") m.current!.kernelId = 22;
    if (kind === "manifest") m.current!.manifestVersion = 2;
    if (kind === "price-manifest") m.current!.priceManifestVersion = 2;
    if (kind === "run-state") m.current!.runState = "failed";
    if (kind === "run-mode") m.current!.runMode = "incremental";
    if (kind === "run-kernel") m.current!.runKernelId = 22;
    if (kind === "run-manifest") m.current!.runManifestVersion = 2;
    if (kind === "unfinished") m.current!.runFinished = false;
    if (kind.startsWith("run-") || kind === "unfinished") code = "current_source_run_unproven";
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: code });
  });
  it("refuses a changed quota/session count despite equal usage and spend", async () => {
    const m = await member(); (m.current!.values as V11DailyProjectionValues).counts.session++;
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: "current_source_non_spend_drift" });
  });
  it("compares every token component rather than only total pricing", async () => {
    const m = await member(); const values = m.current!.values as V11DailyProjectionValues;
    for (const tokens of [values.tokens,values.cells[0]!.tokens]) {
      tokens.inputUncachedTokens.knownSum = String(BigInt(tokens.inputUncachedTokens.knownSum)+1n);
      tokens.nonOverlappingTotal.knownSum = String(BigInt(tokens.nonOverlappingTotal.knownSum)+1n);
    }
    m.values = { ...structuredClone(values),registrySha256: "a".repeat(64),pricingMethodVersion: "server-api-price-equivalent-v0.5" };
    m.valuesSha256 = hash(m.values);
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: "price_inputs_corrupt" });
  });
  it("keeps lexical cells, omitted tokens and unavailable components exact", async () => {
    const m = await member(1,205);
    expect(await outcome(m)).toMatchObject({ outcome: "changed" });
    const values = m.current!.values as V11DailyProjectionValues;
    values.tokens.outputCombinedTokens.unavailable--;
    values.omitted.tokens.outputCombinedTokens.unavailable--;
    m.values = { ...structuredClone(values),registrySha256: "a".repeat(64),pricingMethodVersion: "server-api-price-equivalent-v0.5" };
    m.valuesSha256 = hash(m.values);
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: "price_inputs_corrupt" });
  });
  it("refuses per-cell token drift even when the whole-day token totals are identical", async () => {
    const m = await member(1,2), values = m.current!.values as V11DailyProjectionValues;
    for (const [index,delta] of [[0,1n],[1,-1n]] as const) {
      const tokens = values.cells[index]!.tokens;
      tokens.inputUncachedTokens.knownSum = String(BigInt(tokens.inputUncachedTokens.knownSum)+delta);
      tokens.nonOverlappingTotal.knownSum = String(BigInt(tokens.nonOverlappingTotal.knownSum)+delta);
    }
    m.values = { ...structuredClone(values),registrySha256: "a".repeat(64),pricingMethodVersion: "server-api-price-equivalent-v0.5" };
    m.valuesSha256 = hash(m.values);
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: "price_inputs_corrupt" });
  });
  it("refuses byte-identical current target values rather than inventing a new version", async () => {
    const m = await member(); m.values = structuredClone(m.current!.values); m.valuesSha256 = hash(m.values);
    expect(await outcome(m)).toMatchObject({ outcome: "refused",refusal: "current_source_values_unchanged" });
  });
  it("preserves saved devices/exclusions and refuses an entire day for one bad member", async () => {
    const a = await member(1), b = await member(2); b.excluded = true; b.current = null;
    expect(await prepareAnalyticsV2CurrentCorrectionHead(await head([a,b]),23)).toMatchObject({ outcome: "changed",members: [{ member: { devices: 1 } }] });
    b.excluded = false;
    expect(await prepareAnalyticsV2CurrentCorrectionHead(await head([a,b]),23)).toMatchObject({ outcome: "refused",members: [] });
  });
  it("refuses a mismatched public cohort even though each member validates", async () => {
    const a = await member(), b = await member(2), h = await head([a,b]);
    expect(await prepareAnalyticsV2CurrentCorrectionHead({ ...h,members: [a] },23)).toMatchObject({ outcome: "refused",refusal: "reprice_membership_or_evidence_drift" });
  });
  it("keeps the existing member, compressed byte and event bounds", async () => {
    const m = await member(), h = await head([m]);
    for (const members of [Array(1001).fill(m),[{ ...m,inputs: { ...m.inputs!,bytes: new Uint8Array(16*1024*1024+1) } }],
      [{ ...m,inputs: { ...m.inputs!,events: 500001 } }]]) {
      await expect(prepareAnalyticsV2CurrentCorrectionHead({ ...h,members },23)).rejects.toMatchObject({ code: "ANALYTICS_V2_REPRICE_LIMIT" });
    }
  });
  it("validates a closed distinct receipt with exact count conservation", () => {
    const receipt = { schema: "analytics-v2-current-correction-execution-v1",status: "complete",inputSource: "current-owner-day",
      sourceKernelId: 23,planSha256: "a".repeat(64),replayed: false,
      counts: { planned: 1,changed: 1,unchanged: 0,refused: 0,contributionVersions: 2,currentSourceVersions: 1,archiveSourceVersions: 1 },
      refusals: Object.fromEntries(ANALYTICS_V2_CURRENT_CORRECTION_REFUSALS.map(code => [code,0])) };
    expect(validAnalyticsV2CurrentCorrectionStoredReceipt(receipt,receipt.planSha256,23)).toBe(true);
    for (const changed of [{ ...receipt,extra: true },{ ...receipt,schema: "analytics-v2-reprice-execution-v1" },
      { ...receipt,sourceKernelId: 24 },{ ...receipt,replayed: true },{ ...receipt,counts: { ...receipt.counts,currentSourceVersions: 0 } },
      { ...receipt,refusals: { ...receipt.refusals,unknown: 0 } }]) {
      expect(validAnalyticsV2CurrentCorrectionStoredReceipt(changed,receipt.planSha256,23)).toBe(false);
    }
  });
});
