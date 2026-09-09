import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CORRECTED_CURRENT_VERSION,
  CORRECTED_HANDOVER_SOURCE_REVISION,
  CORRECTED_NEXT_VERSION,
  CURRENT_VERSION,
  FOLLOW_UP_CURRENT_VERSION,
  FOLLOW_UP_HANDOVER_SOURCE_REVISION,
  FOLLOW_UP_NEXT_VERSION,
  HANDOVER_PREFIX,
  HANDOVER_SOURCE_REVISION,
  NEXT_VERSION,
  parseElectronHandoverFeedPublisherArguments,
  publishElectronHandoverRehearsalFeed,
} from "../scripts/publish-electron-handover-rehearsal-feed.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const TARGETS = Object.freeze(["darwin-arm64", "darwin-x64"]);

function yaml(version, files) {
  return Buffer.from([
    `version: ${version}`, "files:",
    ...files.flatMap((file) => [`  - url: ${file.name}`, `    sha512: ${sha512(file.bytes)}`, `    size: ${file.bytes.length}`]),
    `path: ${files[0].name}`, `sha512: ${sha512(files[0].bytes)}`, "releaseDate: '2026-09-09T00:00:00.000Z'", "",
  ].join("\n"));
}

async function writeCandidate({ root, directory, sourceRevision, kind, target, version }) {
  const arch = target.slice("darwin-".length);
  const relativeDirectory = `${directory}/${kind}/${target}`;
  const candidateDirectory = join(root, relativeDirectory);
  await mkdir(candidateDirectory, { recursive: true });
  const zip = { name: `TiboTattle-${version}-mac-${arch}.zip`, bytes: Buffer.from(`${directory}-${kind}-${arch}-zip`) };
  const dmg = { name: `TiboTattle-${version}-mac-${arch}.dmg`, bytes: Buffer.from(`${directory}-${kind}-${arch}-dmg`) };
  const manifest = yaml(version, [zip, dmg]);
  for (const file of [zip, dmg]) await writeFile(join(candidateDirectory, file.name), file.bytes);
  await writeFile(join(candidateDirectory, "native-to-electron-handover-mac.yml"), manifest);
  await writeFile(join(candidateDirectory, "production-finalization-receipt.json"), JSON.stringify({
    sourceRevision, version, candidate: kind, target, checks: { checked: true },
    artifacts: {
      dmg: { file: dmg.name, bytes: dmg.bytes.length, sha256: sha256(dmg.bytes) },
      zip: { file: zip.name, bytes: zip.bytes.length, sha256: sha256(zip.bytes) },
    },
  }));
  const object = (file, primaryForUpdater) => ({
    localPath: `${relativeDirectory}/${file.name}`,
    objectKey: `${HANDOVER_PREFIX}/${target}/${file.name}`,
    sha256: sha256(file.bytes),
    bytes: file.bytes.length,
    primaryForUpdater,
  });
  return {
    version,
    finalizationReceipt: `${relativeDirectory}/production-finalization-receipt.json`,
    finalizationChecksAllTrue: true,
    manifest: {
      localPath: `${relativeDirectory}/native-to-electron-handover-mac.yml`,
      objectKey: `${HANDOVER_PREFIX}/${target}/native-to-electron-handover-mac.yml`,
      sha256: sha256(manifest),
      bytes: manifest.length,
    },
    objects: [object(zip, true), object(dmg, false)],
  };
}

function selectedPublication(proposal, target, state) {
  if (state === "rollback") {
    const current = proposal.initialPublication[target];
    return { manifest: current.manifest, objects: current.objects };
  }
  const next = proposal.feedAdvance[target];
  return { manifest: next.replaceOnlyManifest, objects: next.prepositionImmutableObjects };
}

function completedPublicationReceipt({ proposal, sourceRevision, state }) {
  return {
    schema: "tibotattle-electron-handover-feed-publication-receipt-v1",
    sourceRevision,
    stage: state,
    bucket: "tibotattle-updates",
    status: "completed",
    mutation: "wrangler-unconditional-put-with-exclusive-control-pre-post-readback",
    targets: Object.fromEntries(TARGETS.map((target) => {
      const selected = selectedPublication(proposal, target, state);
      return [target, {
        feedKey: selected.manifest.objectKey,
        feedSha256: selected.manifest.sha256,
        immutableKeys: selected.objects.map((object) => object.objectKey),
        phase: "feed_readback_passed",
      }];
    })),
  };
}

async function makeFamilyProposal({
  root,
  directory,
  sourceRevision,
  currentVersion,
  nextVersion,
  predecessor = null,
}) {
  const proposal = {
    schema: predecessor === null
      ? "tibotattle-private-updater-publication-proposal-v1"
      : "tibotattle-private-updater-publication-proposal-v2",
    disposition: "proposal-only-no-network-write",
    sourceRevision,
    r2Bucket: "tibotattle-updates",
    publicOrigin: "https://updates.tibotattle.com",
    feedPrefix: HANDOVER_PREFIX,
    channel: "native-to-electron-handover-rehearsal-v1",
    privacy: { namespaceIsolatedFromStable: true, accessControlProven: false, note: "fixture" },
    ...(predecessor === null ? {} : { predecessor }),
    initialPublication: {},
    feedAdvance: {},
    rollback: {},
    stableMustRemainUntouched: ["electron/stable/**", "appcast.xml", "intel/appcast.xml", "preview/**"],
  };
  for (const target of TARGETS) {
    const current = await writeCandidate({ root, directory, sourceRevision, kind: "current", target, version: currentVersion });
    const next = await writeCandidate({ root, directory, sourceRevision, kind: "next", target, version: nextVersion });
    const rollbackDirectory = join(root, directory, "rollback");
    const rollbackPath = join(rollbackDirectory, `${target}.yml`);
    await mkdir(rollbackDirectory, { recursive: true });
    await writeFile(rollbackPath, await readFile(join(root, current.manifest.localPath)));
    proposal.initialPublication[target] = current;
    proposal.feedAdvance[target] = {
      prepositionImmutableObjects: next.objects,
      replaceOnlyManifest: next.manifest,
      expectedPreviousManifestSha256: current.manifest.sha256,
    };
    proposal.rollback[target] = {
      restoreOnlyManifest: {
        localPath: `${directory}/rollback/${target}.yml`,
        objectKey: current.manifest.objectKey,
        sha256: current.manifest.sha256,
        bytes: current.manifest.bytes,
      },
      expectedCurrentManifestSha256: next.manifest.sha256,
      retainImmutableObjects: true,
    };
  }
  const proposalPath = join(root, `${directory}.proposal.json`);
  await writeFile(proposalPath, JSON.stringify(proposal));
  return { proposal, proposalPath };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-feed-"));
  try {
    const { proposal, proposalPath } = await makeFamilyProposal({
      root,
      directory: "signed",
      sourceRevision: HANDOVER_SOURCE_REVISION,
      currentVersion: CURRENT_VERSION,
      nextVersion: NEXT_VERSION,
    });
    const makeCorrected = async ({ predecessorState = "advance" } = {}) => {
      const predecessorReceiptPath = join(root, `legacy-${predecessorState}.receipt.json`);
      await writeFile(predecessorReceiptPath, JSON.stringify(completedPublicationReceipt({
        proposal,
        sourceRevision: HANDOVER_SOURCE_REVISION,
        state: predecessorState,
      })));
      const corrected = await makeFamilyProposal({
        root,
        directory: "corrected",
        sourceRevision: CORRECTED_HANDOVER_SOURCE_REVISION,
        currentVersion: CORRECTED_CURRENT_VERSION,
        nextVersion: CORRECTED_NEXT_VERSION,
        predecessor: {
          state: predecessorState,
          proposal: { localPath: "signed.proposal.json", sha256: sha256(await readFile(proposalPath)) },
          publicationReceipt: { localPath: `legacy-${predecessorState}.receipt.json`, sha256: sha256(await readFile(predecessorReceiptPath)) },
        },
      });
      return { ...corrected, predecessorReceiptPath };
    };
    const makeFollowUp = async ({ predecessorState = "advance" } = {}) => {
      const corrected = await makeCorrected({ predecessorState });
      const predecessorReceiptPath = join(root, `corrected-${predecessorState}.receipt.json`);
      await writeFile(predecessorReceiptPath, JSON.stringify(completedPublicationReceipt({
        proposal: corrected.proposal,
        sourceRevision: CORRECTED_HANDOVER_SOURCE_REVISION,
        state: predecessorState,
      })));
      const followUp = await makeFamilyProposal({
        root,
        directory: "follow-up",
        sourceRevision: FOLLOW_UP_HANDOVER_SOURCE_REVISION,
        currentVersion: FOLLOW_UP_CURRENT_VERSION,
        nextVersion: FOLLOW_UP_NEXT_VERSION,
        predecessor: {
          state: predecessorState,
          proposal: { localPath: "corrected.proposal.json", sha256: sha256(await readFile(corrected.proposalPath)) },
          publicationReceipt: { localPath: `corrected-${predecessorState}.receipt.json`, sha256: sha256(await readFile(predecessorReceiptPath)) },
        },
      });
      return { ...followUp, corrected, predecessorReceiptPath };
    };
    return await run({ root, proposal, proposalPath, makeCorrected, makeFollowUp });
  } finally { await rm(root, { recursive: true, force: true }); }
}
function fakeWrangler(objects, calls, { failPut = () => false } = {}) {
  return async (args) => {
    calls.push(args);
    const key = args[3]; const file = args[args.indexOf("--file") + 1];
    if (args[2] === "get") {
      const value = objects.get(key);
      if (!value) return { status: 1, stderr: "The specified key does not exist" };
      await writeFile(file, value); return { status: 0, stdout: "" };
    }
    if (args[2] === "put") { if (failPut(key)) return { status: 1, stderr: "synthetic write failure" }; objects.set(key, await readFile(file)); return { status: 0, stdout: "" }; }
    throw new Error("unexpected wrangler invocation");
  };
}

test("dry run validates the closed pair without invoking Wrangler", async () => fixture(async ({ root, proposalPath }) => {
  let calls = 0;
  const result = await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial", runWrangler: async () => { calls += 1; return {}; } });
  assert.equal(result.published, false); assert.equal(calls, 0);
  assert.equal(result.targets["darwin-arm64"].feedSha256.length, 64);
}));

test("interrupted advance journals per-target progress and rollback recovers the recorded pair", async () => fixture(async ({ root, proposal, proposalPath }) => {
  const objects = new Map(); const calls = []; const runner = fakeWrangler(objects, calls);
  const initialReceipt = join(root, "initial.receipt.json");
  await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: initialReceipt, runWrangler: runner });
  const advanceReceipt = join(root, "advance.receipt.json");
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root, proposalPath, stage: "advance", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: advanceReceipt,
    runWrangler: fakeWrangler(objects, calls, { failPut: (key) => key.endsWith("darwin-x64/native-to-electron-handover-mac.yml") }),
  }), { code: "ELECTRON_HANDOVER_FEED_R2_WRITE_FAILED" });
  const interrupted = JSON.parse(await readFile(advanceReceipt));
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.targets["darwin-arm64"].phase, "feed_readback_passed");
  assert.equal(interrupted.targets["darwin-x64"].phase, "assets_readback_passed");
  const rollbackReceipt = join(root, "rollback.receipt.json");
  const rollback = await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "rollback", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: rollbackReceipt, runWrangler: runner });
  assert.equal(rollback.published, true); assert.equal(JSON.parse(await readFile(rollbackReceipt)).status, "completed");
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const key = `tibotattle-updates/${proposal.initialPublication[target].manifest.objectKey}`;
    assert.deepEqual(objects.get(key), await readFile(join(root, proposal.rollback[target].restoreOnlyManifest.localPath)));
  }
  assert.equal([...objects.keys()].some((key) => key.includes("electron/stable")), false);
}));

test("receipt failures cause zero puts and tampered receipts are refused locally", async () => fixture(async ({ root, proposal, proposalPath }) => {
  const calls = []; const existingReceipt = join(root, "existing.json"); await writeFile(existingReceipt, "{}\n");
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: existingReceipt, runWrangler: fakeWrangler(new Map(), calls) }));
  assert.equal(calls.filter((args) => args[2] === "put").length, 0);
  const receiptPath = join(root, proposal.initialPublication["darwin-arm64"].finalizationReceipt);
  const receipt = JSON.parse(await readFile(receiptPath)); receipt.artifacts.zip.bytes += 1; await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial" }), { code: "ELECTRON_HANDOVER_FEED_RECEIPT_INVALID" });
}));

test("unknown existing feed and incomplete publish controls are refused", async () => fixture(async ({ root, proposal, proposalPath }) => {
  assert.throws(() => parseElectronHandoverFeedPublisherArguments(["--artifact-root", root, "--proposal", proposalPath, "--stage", "initial", "--publish"]));
  const objects = new Map([[`tibotattle-updates/${proposal.initialPublication["darwin-arm64"].manifest.objectKey}`, Buffer.from("unknown\n")]]);
  const receiptPath = join(root, "nope.json");
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath, runWrangler: fakeWrangler(objects, []) }), { code: "ELECTRON_HANDOVER_FEED_FEED_CONFLICT" });
  const refused = JSON.parse(await readFile(receiptPath));
  assert.equal(refused.status, "failed"); assert.equal(refused.targets["darwin-arm64"].phase, "pending");
}));

test("nested artifact object keys are outside the closed rehearsal layout", async () => fixture(async ({ root, proposal, proposalPath }) => {
  const target = "darwin-arm64";
  const object = proposal.initialPublication[target].objects[0];
  object.objectKey = `${HANDOVER_PREFIX}/${target}/nested/${object.objectKey.split("/").at(-1)}`;
  await writeFile(proposalPath, JSON.stringify(proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath, stage: "initial" }), /closed candidate filename/);
}));

test("corrected family advances only from its exact .12 predecessor and rolls back .14 to .13", async () => fixture(async ({ root, proposal, makeCorrected }) => {
  const corrected = await makeCorrected({ predecessorState: "advance" });
  const objects = new Map(); const calls = []; const runner = fakeWrangler(objects, calls);
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const oldManifest = proposal.feedAdvance[target].replaceOnlyManifest;
    objects.set(`tibotattle-updates/${oldManifest.objectKey}`, await readFile(join(root, oldManifest.localPath)));
  }
  await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: join(root, "corrected-initial.json"), runWrangler: runner });
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const key = `tibotattle-updates/${corrected.proposal.initialPublication[target].manifest.objectKey}`;
    assert.deepEqual(objects.get(key), await readFile(join(root, corrected.proposal.initialPublication[target].manifest.localPath)));
  }
  await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "advance", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: join(root, "corrected-advance.json"), runWrangler: runner });
  await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "rollback", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: join(root, "corrected-rollback.json"), runWrangler: runner });
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const key = `tibotattle-updates/${corrected.proposal.initialPublication[target].manifest.objectKey}`;
    assert.deepEqual(objects.get(key), await readFile(join(root, corrected.proposal.rollback[target].restoreOnlyManifest.localPath)));
  }
  assert.equal([...objects.keys()].some((key) => key.includes("electron/stable")), false);
}));

test("corrected initial resumes a mixed .12/.13 interruption without rewriting .13", async () => fixture(async ({ root, proposal, makeCorrected }) => {
  const corrected = await makeCorrected({ predecessorState: "advance" });
  const objects = new Map(); const calls = [];
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const predecessor = proposal.feedAdvance[target].replaceOnlyManifest;
    objects.set(`tibotattle-updates/${predecessor.objectKey}`, await readFile(join(root, predecessor.localPath)));
  }
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "corrected-mixed-first.json"), runWrangler: fakeWrangler(objects, calls, { failPut: (key) => key.endsWith("darwin-x64/native-to-electron-handover-mac.yml") }),
  }), { code: "ELECTRON_HANDOVER_FEED_R2_WRITE_FAILED" });
  const interrupted = JSON.parse(await readFile(join(root, "corrected-mixed-first.json")));
  assert.equal(interrupted.targets["darwin-arm64"].phase, "feed_readback_passed");
  assert.equal(interrupted.targets["darwin-x64"].phase, "assets_readback_passed");
  const retryCalls = [];
  await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: join(root, "corrected-mixed-retry.json"), runWrangler: fakeWrangler(objects, retryCalls) });
  const retryFeedPuts = retryCalls.filter((args) => args[2] === "put" && args[3].endsWith("native-to-electron-handover-mac.yml"));
  assert.deepEqual(retryFeedPuts.map((args) => args[3]), [
    `tibotattle-updates/${corrected.proposal.initialPublication["darwin-x64"].manifest.objectKey}`,
  ]);
}));

test("corrected family refuses missing, unknown, or tampered predecessor evidence before puts", async () => fixture(async ({ root, proposal, proposalPath, makeCorrected }) => {
  const corrected = await makeCorrected({ predecessorState: "rollback" });
  const initialDryRun = await publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial" });
  assert.equal(initialDryRun.published, false);
  const calls = []; const receiptPath = join(root, "corrected-refusal.json");
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath, runWrangler: fakeWrangler(new Map(), calls) }), { code: "ELECTRON_HANDOVER_FEED_FEED_CONFLICT" });
  assert.equal(calls.filter((args) => args[2] === "put").length, 0);
  const legacyReceipt = JSON.parse(await readFile(corrected.predecessorReceiptPath));
  legacyReceipt.mutation = "synthetic-unconditional-put";
  await writeFile(corrected.predecessorReceiptPath, JSON.stringify(legacyReceipt));
  corrected.proposal.predecessor.publicationReceipt.sha256 = sha256(await readFile(corrected.predecessorReceiptPath));
  await writeFile(corrected.proposalPath, JSON.stringify(corrected.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: corrected.proposalPath, stage: "initial" }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });
  const immutableKeysProof = await makeCorrected({ predecessorState: "advance" });
  const immutableKeysReceipt = JSON.parse(await readFile(immutableKeysProof.predecessorReceiptPath));
  immutableKeysReceipt.targets["darwin-arm64"].immutableKeys.reverse();
  await writeFile(immutableKeysProof.predecessorReceiptPath, JSON.stringify(immutableKeysReceipt));
  immutableKeysProof.proposal.predecessor.publicationReceipt.sha256 = sha256(await readFile(immutableKeysProof.predecessorReceiptPath));
  await writeFile(immutableKeysProof.proposalPath, JSON.stringify(immutableKeysProof.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: immutableKeysProof.proposalPath, stage: "initial" }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });
  const crossFamily = await makeCorrected({ predecessorState: "advance" });
  const crossFamilyProof = join(root, "corrected-family-proof.json");
  await writeFile(crossFamilyProof, await readFile(crossFamily.proposalPath));
  crossFamily.proposal.predecessor.proposal = { localPath: "corrected-family-proof.json", sha256: sha256(await readFile(crossFamilyProof)) };
  await writeFile(crossFamily.proposalPath, JSON.stringify(crossFamily.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: crossFamily.proposalPath, stage: "initial" }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });
  const tamperedHistoricalProposal = join(root, "tampered-historical-proposal.json");
  const tamperedHistoricalValue = JSON.parse(await readFile(proposalPath));
  tamperedHistoricalValue.sourceRevision = "0".repeat(40);
  await writeFile(tamperedHistoricalProposal, JSON.stringify(tamperedHistoricalValue));
  const tamperedProposalProof = await makeCorrected({ predecessorState: "advance" });
  tamperedProposalProof.proposal.predecessor.proposal = { localPath: "tampered-historical-proposal.json", sha256: sha256(await readFile(tamperedHistoricalProposal)) };
  await writeFile(tamperedProposalProof.proposalPath, JSON.stringify(tamperedProposalProof.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: tamperedProposalProof.proposalPath, stage: "initial" }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });
  const unknown = new Map();
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const key = `tibotattle-updates/${proposal.initialPublication[target].manifest.objectKey}`;
    unknown.set(key, Buffer.from("unknown\n"));
  }
  const newCorrected = await makeCorrected({ predecessorState: "rollback" });
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({ artifactRoot: root, proposalPath: newCorrected.proposalPath, stage: "initial", publish: true, confirmExclusiveRehearsalControl: true, receiptPath: join(root, "corrected-unknown.json"), runWrangler: fakeWrangler(unknown, []) }), { code: "ELECTRON_HANDOVER_FEED_FEED_CONFLICT" });
}));

test("follow-up family starts only from .14, then advances and rolls back without replacing historical archives", async () => fixture(async ({ root, makeFollowUp }) => {
  const followUp = await makeFollowUp();
  const objects = new Map(); const calls = []; const runner = fakeWrangler(objects, calls);
  for (const target of TARGETS) {
    const predecessor = followUp.corrected.proposal.feedAdvance[target].replaceOnlyManifest;
    objects.set(`tibotattle-updates/${predecessor.objectKey}`, await readFile(join(root, predecessor.localPath)));
  }
  const initialReceiptPath = join(root, "follow-up-initial.json");
  await publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: followUp.proposalPath,
    stage: "initial",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: initialReceiptPath,
    runWrangler: runner,
  });
  const initialReceipt = JSON.parse(await readFile(initialReceiptPath));
  assert.equal(initialReceipt.sourceRevision, FOLLOW_UP_HANDOVER_SOURCE_REVISION);
  for (const target of TARGETS) {
    const key = `tibotattle-updates/${followUp.proposal.initialPublication[target].manifest.objectKey}`;
    assert.deepEqual(objects.get(key), await readFile(join(root, followUp.proposal.initialPublication[target].manifest.localPath)));
  }
  await publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: followUp.proposalPath,
    stage: "advance",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "follow-up-advance.json"),
    runWrangler: runner,
  });
  await publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: followUp.proposalPath,
    stage: "rollback",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "follow-up-rollback.json"),
    runWrangler: runner,
  });
  for (const target of TARGETS) {
    const key = `tibotattle-updates/${followUp.proposal.initialPublication[target].manifest.objectKey}`;
    assert.deepEqual(objects.get(key), await readFile(join(root, followUp.proposal.rollback[target].restoreOnlyManifest.localPath)));
  }
  const historicalArchivePuts = calls.filter((args) => (
    args[2] === "put"
    && /native-to-electron-handover\.(?:11|12|13|14)-mac-/u.test(args[3])
  ));
  assert.deepEqual(historicalArchivePuts, []);
}));

test("follow-up family refuses forged source or receipt, a .13 proof, and a .13 remote feed before puts", async () => fixture(async ({ root, makeFollowUp }) => {
  const calls = [];
  const forgedSource = await makeFollowUp();
  forgedSource.proposal.sourceRevision = "0".repeat(40);
  await writeFile(forgedSource.proposalPath, JSON.stringify(forgedSource.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: forgedSource.proposalPath,
    stage: "initial",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "forged-source.json"),
    runWrangler: fakeWrangler(new Map(), calls),
  }), { code: "ELECTRON_HANDOVER_FEED_INVALID" });
  assert.equal(calls.filter((args) => args[2] === "put").length, 0);

  const rollbackProof = await makeFollowUp({ predecessorState: "rollback" });
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: rollbackProof.proposalPath,
    stage: "initial",
  }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });

  const forgedPredecessorSource = await makeFollowUp();
  forgedPredecessorSource.corrected.proposal.sourceRevision = "f".repeat(40);
  await writeFile(forgedPredecessorSource.corrected.proposalPath, JSON.stringify(forgedPredecessorSource.corrected.proposal));
  forgedPredecessorSource.proposal.predecessor.proposal.sha256 = sha256(await readFile(forgedPredecessorSource.corrected.proposalPath));
  await writeFile(forgedPredecessorSource.proposalPath, JSON.stringify(forgedPredecessorSource.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: forgedPredecessorSource.proposalPath,
    stage: "initial",
  }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });

  const forgedReceipt = await makeFollowUp();
  const receipt = JSON.parse(await readFile(forgedReceipt.predecessorReceiptPath));
  receipt.targets["darwin-arm64"].immutableKeys.reverse();
  await writeFile(forgedReceipt.predecessorReceiptPath, JSON.stringify(receipt));
  forgedReceipt.proposal.predecessor.publicationReceipt.sha256 = sha256(await readFile(forgedReceipt.predecessorReceiptPath));
  await writeFile(forgedReceipt.proposalPath, JSON.stringify(forgedReceipt.proposal));
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: forgedReceipt.proposalPath,
    stage: "initial",
  }), { code: "ELECTRON_HANDOVER_FEED_PREDECESSOR_INVALID" });

  const valid = await makeFollowUp();
  const remoteObjects = new Map();
  for (const target of TARGETS) {
    const old = valid.corrected.proposal.initialPublication[target].manifest;
    remoteObjects.set(`tibotattle-updates/${old.objectKey}`, await readFile(join(root, old.localPath)));
  }
  const remoteCalls = [];
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: valid.proposalPath,
    stage: "initial",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "remote-.13.json"),
    runWrangler: fakeWrangler(remoteObjects, remoteCalls),
  }), { code: "ELECTRON_HANDOVER_FEED_FEED_CONFLICT" });
  assert.equal(remoteCalls.filter((args) => args[2] === "put").length, 0);
}));

test("follow-up initial retry writes only the target still at the bound .14 feed", async () => fixture(async ({ root, makeFollowUp }) => {
  const followUp = await makeFollowUp();
  const objects = new Map(); const calls = [];
  for (const target of TARGETS) {
    const predecessor = followUp.corrected.proposal.feedAdvance[target].replaceOnlyManifest;
    objects.set(`tibotattle-updates/${predecessor.objectKey}`, await readFile(join(root, predecessor.localPath)));
  }
  await assert.rejects(() => publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: followUp.proposalPath,
    stage: "initial",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "follow-up-mixed-first.json"),
    runWrangler: fakeWrangler(objects, calls, {
      failPut: (key) => key.endsWith("darwin-x64/native-to-electron-handover-mac.yml"),
    }),
  }), { code: "ELECTRON_HANDOVER_FEED_R2_WRITE_FAILED" });
  const retryCalls = [];
  await publishElectronHandoverRehearsalFeed({
    artifactRoot: root,
    proposalPath: followUp.proposalPath,
    stage: "initial",
    publish: true,
    confirmExclusiveRehearsalControl: true,
    receiptPath: join(root, "follow-up-mixed-retry.json"),
    runWrangler: fakeWrangler(objects, retryCalls),
  });
  const retryFeedPuts = retryCalls.filter((args) => (
    args[2] === "put" && args[3].endsWith("native-to-electron-handover-mac.yml")
  ));
  assert.deepEqual(retryFeedPuts.map((args) => args[3]), [
    `tibotattle-updates/${followUp.proposal.initialPublication["darwin-x64"].manifest.objectKey}`,
  ]);
}));
