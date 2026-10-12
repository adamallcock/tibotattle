import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { computeAnalyticsV2, analyticsV2RequiredOccurrenceRange } from "../src/analytics-v2/compute";
import { analyticsV2EvidenceOf, type AnalyticsV2OwnerEmission } from "../src/analytics-v2/compute-owner";
import { computeAnalyticsV2Owner as reference } from "./fixtures/model-blocks-inline-reference";
import { composeProofCorpus, oneDevicePerOwner, NOW_MS, TODAY } from "./fixtures/synthetic-occurrences.mjs";

it("MODEL-BLOCKS digest-only observer matches an independent rolling digest and is inert when disabled", async () => {
  const corpus = composeProofCorpus(), queuedDays = { days: [TODAY], lastSequence: 42 };
  const input = { ...corpus, occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays }),
    devicesByDay: oneDevicePerOwner(corpus.occurrencesByOwner, queuedDays.days), queuedDays, nowMs: NOW_MS, revisionSeed: 0 };
  const hashes: string[] = [], observed: string[] = [];
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  await computeAnalyticsV2({ ...input, emissionSequenceHash: (value) => { hashes.push(hash(value)); return hash(value); } });
  expect(hashes).toEqual([]);
  await computeAnalyticsV2({ ...input, emissionSequenceHash: hash, emissionSequenceDigest: (value) => { observed.push(value); } });
  const oracleEmissions = new Map<number, AnalyticsV2OwnerEmission[]>();
  // A pool facade delegates to the frozen owner oracle, but compute still
  // constructs the actual context and performs its original merge/account.
  await computeAnalyticsV2({ ...input, loadOwnerOccurrences: async (ownerDigest, span) =>
    new Map([...corpus.occurrencesByOwner.get(ownerDigest)!].filter(([day]) => day >= span.fromDay && day <= span.throughDay)),
    occurrencesByOwner: new Map(), ownerEvidence: new Map([...corpus.occurrencesByOwner].map(([owner, days]) => [owner, analyticsV2EvidenceOf(days)])),
    ownerPool: { workers: 2, abort: async () => {}, compute: async (task, context, io) => {
      const emissions: AnalyticsV2OwnerEmission[] = [];
      const computation = await reference({ context, owner: task.owner, evidence: new Map(task.evidence),
        load: async (span) => {
          const loaded = new Map();
          // The fake pool uses caller-held synthetic occurrences directly,
          // so no stream or private source is exposed to the observer.
          for (const [day, rows] of corpus.occurrencesByOwner.get(task.owner.ownerDigest)!) {
            if (day >= span.fromDay && day <= span.throughDay) loaded.set(day, rows);
          }
          return loaded;
        }, hooks: { emit: (emission) => { emissions.push(emission); }, accountBytes: () => 0,
          progress: io.progress, timed: async (_phase, work) => work() } });
      oracleEmissions.set(task.index, emissions);
      return { emissions, computation, timings: {} };
    } }, emissionSequenceHash: hash, emissionSequenceDigest: (value) => { observed.push(value); } });
  // Derive the expected sequence ONLY from the frozen pre-refactor owner
  // oracle. Production hash inputs cannot define what this test expects.
  let expected = hash(canonicalJson(["analytics-v2-emission-sequence-v1"]));
  let modelDates = 0;
  for (const [, emissions] of [...oracleEmissions].sort(([left], [right]) => left - right)) {
    for (const emission of emissions) {
      if (emission.kind === "modelDate") modelDates += 1;
      expected = hash(canonicalJson(["analytics-v2-emission-sequence-v1", expected, emission.kind,
        canonicalJson(emission.kind === "refusal" ? emission.refusal : emission.row)]));
    }
  }
  expect(modelDates).toBeGreaterThan(0);
  expect(observed).toEqual([expected, expected]);
  await expect(computeAnalyticsV2({ ...input, emissionSequenceHash: () => "not-a-digest", emissionSequenceDigest: () => {
    throw new Error("malformed digest must never reach observer");
  } })).rejects.toThrow("ANALYTICS_V2_INPUT_INVALID:emissionSequenceHash");
  expect(observed.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
});
