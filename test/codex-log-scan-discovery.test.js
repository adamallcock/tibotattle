import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  codexLogSourceFingerprint,
  discoverCodexRolloutInfos,
} from "../src/codex-log-scan.js";

const START_AT = "2026-07-30T10:00:00.000Z";
const END_AT = "2026-07-30T15:00:00.000Z";
const OLD_MTIME = new Date("2026-07-29T00:00:00.000Z");
const RECENT_MTIME = new Date("2026-07-30T14:00:00.000Z");

const CANARIES = Object.freeze({
  parentId: "private-parent-id-canary-067d2d93",
  childId: "private-child-id-canary-80f4b3d6",
  archivedId: "private-archived-id-canary-8173ca2e",
  orphanId: "private-orphan-id-canary-c1ddf61b",
  prompt: "private-prompt-canary-a2bccf35",
  title: "private-title-canary-793a82c1",
});

function rollout(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function sessionMeta({ id, parentId = null }) {
  return {
    timestamp: "2026-07-30T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      ...(parentId === null ? {} : { forked_from_id: parentId }),
      title: CANARIES.title,
    },
  };
}

function promptRecord() {
  return {
    timestamp: "2026-07-30T12:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: CANARIES.prompt,
    },
  };
}

async function writeRollout(path, records, mtime) {
  await writeFile(path, rollout(records), { mode: 0o600 });
  await utimes(path, mtime, mtime);
}

async function discoveryFixture() {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-discovery-privacy-canary-"));
  const activeDirectory = join(codexHome, "sessions", "2026", "07", "30");
  const archiveDirectory = join(codexHome, "archived_sessions");
  await mkdir(activeDirectory, { recursive: true });
  await mkdir(archiveDirectory, { recursive: true });

  const sharedBasename =
    "rollout-2026-07-30T12-00-00-active-wins-basename-canary-a54b47bd.jsonl";
  const childPath = join(activeDirectory, sharedBasename);
  const archivedShadowPath = join(archiveDirectory, sharedBasename);
  const parentPath = join(
    activeDirectory,
    "rollout-2026-07-30T13-00-00-old-parent-basename-canary-38d5c441.jsonl",
  );
  const orphanPath = join(
    activeDirectory,
    "rollout-2026-07-30T14-00-00-old-orphan-basename-canary-e547c58c.jsonl",
  );

  // Create the child before its parent and give the parent an older mtime. The
  // lineage order must not depend on creation, mtime, or rollout-key order.
  await writeRollout(childPath, [
    sessionMeta({ id: CANARIES.childId, parentId: CANARIES.parentId }),
    promptRecord(),
  ], RECENT_MTIME);
  await writeRollout(archivedShadowPath, [
    sessionMeta({ id: CANARIES.archivedId }),
    promptRecord(),
  ], RECENT_MTIME);
  await writeRollout(parentPath, [
    sessionMeta({ id: CANARIES.parentId }),
    promptRecord(),
  ], OLD_MTIME);
  await writeRollout(orphanPath, [
    sessionMeta({ id: CANARIES.orphanId }),
    promptRecord(),
  ], OLD_MTIME);

  return {
    codexHome,
    childPath,
    archivedShadowPath,
    parentPath,
    orphanPath,
    basenames: [
      basename(childPath),
      basename(parentPath),
      basename(orphanPath),
    ],
  };
}

test("Codex discovery and fingerprints are deterministic, lineage-aware, and path-free by default", async () => {
  const fixture = await discoveryFixture();
  try {
    const discoveryOptions = {
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    };
    const firstDiscovery = await discoverCodexRolloutInfos(discoveryOptions);
    const secondDiscovery = await discoverCodexRolloutInfos(discoveryOptions);

    assert.deepEqual(secondDiscovery, firstDiscovery);
    assert.equal(firstDiscovery.length, 2);
    assert.deepEqual(firstDiscovery.map((info) => info.path), [
      fixture.parentPath,
      fixture.childPath,
    ]);

    const [parent, child] = firstDiscovery;
    assert.equal(parent.mtimeMs < Date.parse(START_AT), true);
    assert.equal(child.mtimeMs >= Date.parse(START_AT), true);
    assert.equal(parent.rolloutKey.localeCompare(child.rolloutKey) > 0, true);
    assert.equal(parent.lineage.sessionId, CANARIES.parentId);
    assert.equal(parent.lineage.parentId, null);
    assert.equal(child.lineage.sessionId, CANARIES.childId);
    assert.equal(child.lineage.parentId, CANARIES.parentId);
    assert.equal(child.location, "active");
    assert.equal(firstDiscovery.some((info) => info.path === fixture.archivedShadowPath), false);
    assert.equal(firstDiscovery.some((info) => info.path === fixture.orphanPath), false);

    const fingerprintOptions = {
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    };
    const firstDefault = await codexLogSourceFingerprint(fingerprintOptions);
    const secondDefault = await codexLogSourceFingerprint(fingerprintOptions);
    const withPaths = await codexLogSourceFingerprint({
      ...fingerprintOptions,
      includeSourcePaths: true,
    });

    assert.deepEqual(secondDefault, firstDefault);
    assert.equal(Object.hasOwn(firstDefault, "sourcePathByKeyHash"), false);
    assert.deepEqual(
      Object.keys(withPaths.sourcePathByKeyHash).sort(),
      firstDefault.files.map((file) => file.keyHash).sort(),
    );
    assert.deepEqual(
      Object.values(withPaths.sourcePathByKeyHash).sort(),
      [fixture.childPath, fixture.parentPath].sort(),
    );
    const { sourcePathByKeyHash, ...withPathsSummary } = withPaths;
    assert.equal(sourcePathByKeyHash === undefined, false);
    assert.deepEqual(withPathsSummary, firstDefault);

    const serializedDefault = JSON.stringify([firstDefault, secondDefault]);
    for (const canary of [
      fixture.codexHome,
      fixture.childPath,
      fixture.parentPath,
      fixture.orphanPath,
      fixture.archivedShadowPath,
      ...fixture.basenames,
      ...Object.values(CANARIES),
    ]) {
      assert.equal(
        serializedDefault.includes(canary),
        false,
        `default fingerprint exposed private source data: ${canary}`,
      );
    }
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});
