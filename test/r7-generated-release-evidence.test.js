import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildR7ReleaseDecisionReceipt } from "../src/r7-release-decision.js";
import {
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
  validateR7ReleaseEvidenceReceipt,
} from "../src/r7-release-evidence-schema.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GENERATED = join(ROOT, "generated");
const RUNTIME_SUFFIXES = ["node24.14.0-v0.1.json", "node26.2.0-v0.1.json"];
const PROFILE_NAMES = [
  "synthetic-semantics",
  "synthetic-pressure",
  "materialized-boundaries",
  "real-local-history",
  "decision",
];
const EXPECTED_FILES = PROFILE_NAMES.flatMap((profile) => (
  RUNTIME_SUFFIXES.map((suffix) => `r7-release-${profile}-${suffix}`)
)).sort();

async function readReceipt(name) {
  return JSON.parse(await readFile(join(GENERATED, name), "utf8"));
}

function filename(profile, runtimeClass) {
  const suffix = runtimeClass === "pinned_candidate"
    ? RUNTIME_SUFFIXES[0] : RUNTIME_SUFFIXES[1];
  return `r7-release-${profile}-${suffix}`;
}

test("every retained R7 release receipt revalidates against current code and contract", async () => {
  const files = (await readdir(GENERATED))
    .filter((name) => name.startsWith("r7-release-") && name.endsWith(".json"))
    .sort();
  assert.deepEqual(files, EXPECTED_FILES);

  for (const name of files) {
    const receipt = await readReceipt(name);
    assert.deepEqual(validateR7ReleaseEvidenceReceipt(receipt), { valid: true, errors: [] }, name);
    assert.equal(
      receipt.contractProvenance.workloadCodeSha256,
      R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
      name,
    );
    assert.equal(
      receipt.contractProvenance.workloadCodeFileCount,
      R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
      name,
    );
  }
});

const currentRuntimeClass = process.versions.node === "24.14.0"
  ? "pinned_candidate"
  : process.versions.node === "26.2.0"
    ? "compatibility_crosscheck"
    : null;

test("retained decision receipt is rebuilt exactly from all eight runtime inputs", {
  skip: currentRuntimeClass === null ? "requires an exact R7 qualified runtime" : false,
}, async () => {
  const readPair = async (profile) => ({
    node24: await readReceipt(filename(profile, "pinned_candidate")),
    node26: await readReceipt(filename(profile, "compatibility_crosscheck")),
  });
  const inputReceiptPairs = {
    syntheticSemantics: await readPair("synthetic-semantics"),
    syntheticPressure: await readPair("synthetic-pressure"),
    materializedBoundaries: await readPair("materialized-boundaries"),
    realLocalHistory: await readPair("real-local-history"),
  };
  const rebuilt = buildR7ReleaseDecisionReceipt({ inputReceiptPairs });
  const retained = await readReceipt(filename("decision", currentRuntimeClass));
  assert.deepEqual(rebuilt, retained);
  assert.equal(rebuilt.outcome, "release_open");
  assert.equal(
    rebuilt.profileEvidence.decisions.every(({ decision }) => decision === "unresolved"),
    true,
  );
});
