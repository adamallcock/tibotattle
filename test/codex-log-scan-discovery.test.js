import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
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
  codexRolloutDiscoveryReceipt,
  discoverCodexRolloutInfos,
  scanCodexLogEvents,
} from "../src/codex-log-scan.js";
import {
  readCodexSelectedRolloutNames,
} from "../src/platform/local-codex-thread-store.js";
import { DatabaseSync } from "node:sqlite";

const START_AT = "2026-07-30T10:00:00.000Z";
const END_AT = "2026-07-30T15:00:00.000Z";
const OLD_MTIME = new Date("2026-07-29T00:00:00.000Z");
const RECENT_MTIME = new Date("2026-07-30T14:00:00.000Z");

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const THREAD_C = "33333333-3333-4333-8333-333333333333";
const ROLLOUT_A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_A3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function canonicalName(timestamp, threadId, rolloutId = null, suffix = ".jsonl") {
  return `rollout-${timestamp}-${threadId}${rolloutId === null ? "" : `_${rolloutId}`}${suffix}`;
}

function canonicalMeta({
  id,
  ordinal = 0,
  historyBase = null,
  parentId = null,
}) {
  return {
    ordinal,
    timestamp: "2026-07-30T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      ...(historyBase === null ? {} : {
        history_mode: "paginated",
        history_base: {
          thread_id: historyBase.rolloutId,
          end_ordinal_exclusive: historyBase.endOrdinalExclusive,
          end_byte_offset: historyBase.endByteOffset,
        },
      }),
      ...(parentId === null ? {} : { forked_from_id: parentId }),
    },
  };
}

async function emptyCanonicalHome(prefix = "codex-generation-") {
  const codexHome = await mkdtemp(join(tmpdir(), prefix));
  const sessions = join(codexHome, "sessions", "2026", "07", "30");
  await mkdir(sessions, { recursive: true });
  return { codexHome, sessions };
}

async function writeRecent(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  await utimes(path, RECENT_MTIME, RECENT_MTIME);
}

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
    sessionMeta({ id: CANARIES.childId, parentId: CANARIES.parentId }),
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

test("canonical replacement rollouts retain stable thread and immutable rollout identities", async () => {
  const fixture = await emptyCanonicalHome();
  try {
    const baseRecords = [
      canonicalMeta({ id: THREAD_A }),
      {
        timestamp: "2026-07-30T12:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
      {
        timestamp: "2026-07-30T12:00:02.000Z",
        type: "event_msg",
        payload: { type: "token_count" },
      },
    ];
    const base = rollout(baseRecords);
    const basePath = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_A),
    );
    const replacementPath = join(
      fixture.sessions,
      canonicalName("2026-07-30T13-00-00", THREAD_A, ROLLOUT_A2),
    );
    const replacement = rollout([
      canonicalMeta({
        id: THREAD_A,
        ordinal: baseRecords.length,
        historyBase: {
          rolloutId: THREAD_A,
          endOrdinalExclusive: baseRecords.length,
          endByteOffset: Buffer.byteLength(base),
        },
      }),
      {
        timestamp: "2026-07-30T13:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
    ]);
    await writeRecent(basePath, base);
    await writeRecent(replacementPath, replacement);

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
      selectedRolloutNames: new Map([[
        THREAD_A,
        canonicalName("2026-07-30T13-00-00", THREAD_A, ROLLOUT_A2),
      ]]),
    });
    assert.equal(infos.length, 2);
    assert.deepEqual(infos.map((info) => info.rolloutId), [THREAD_A, ROLLOUT_A2]);
    assert.deepEqual(infos.map((info) => info.threadId), [THREAD_A, THREAD_A]);
    assert.equal(infos[0].replacement, false);
    assert.equal(infos[1].replacement, true);
    assert.equal(infos[1].selectedHead, true);
    assert.deepEqual(infos[1].lineage.historyBase, {
      rolloutId: THREAD_A,
      endOrdinalExclusive: baseRecords.length,
      endByteOffset: Buffer.byteLength(base),
    });
    assert.deepEqual(codexRolloutDiscoveryReceipt(infos), {
      schemaVersion: "codex-rollout-discovery-v2",
      status: "complete",
      discoveredSourceCount: 2,
      discoveredSourceBytes: Buffer.byteLength(base) + Buffer.byteLength(replacement),
      acceptedSourceCount: 2,
      acceptedSourceBytes: Buffer.byteLength(base) + Buffer.byteLength(replacement),
      skippedSourceCount: 0,
      skippedSourceBytes: 0,
      skippedThreadCount: 0,
      duplicateRepresentationCount: 0,
      reasonCounts: {},
      diagnosticGroups: [],
      quarantined: [],
      fingerprint: codexRolloutDiscoveryReceipt(infos).fingerprint,
      quarantineFingerprint: codexRolloutDiscoveryReceipt(infos).quarantineFingerprint,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("UUID identities and logical parent references are case-insensitive", async () => {
  const fixture = await emptyCanonicalHome("codex-uppercase-identity-");
  try {
    const parent = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_A),
    );
    const child = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-01", THREAD_B),
    );
    await writeRecent(parent, rollout([
      canonicalMeta({ id: THREAD_A.toUpperCase() }),
    ]));
    await writeRecent(child, rollout([
      canonicalMeta({
        id: THREAD_B.toUpperCase(),
        parentId: THREAD_A.toUpperCase(),
      }),
    ]));

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(codexRolloutDiscoveryReceipt(infos).status, "complete");
    assert.equal(infos.length, 2);
    const childInfo = infos.find((info) => info.threadId === THREAD_B);
    assert.equal(childInfo.lineage.sessionId, THREAD_B);
    assert.equal(childInfo.lineage.parentId, THREAD_A);
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("exact duplicate rollout representations collapse deterministically while divergent ones quarantine only their thread", async () => {
  const fixture = await emptyCanonicalHome();
  try {
    const exact = rollout([canonicalMeta({ id: THREAD_A })]);
    const firstExact = join(
      fixture.sessions,
      canonicalName("2026-07-30T11-00-00", THREAD_A),
    );
    const secondExact = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_A),
    );
    await writeRecent(firstExact, exact);
    await writeRecent(secondExact, exact);
    let infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(infos.length, 1);
    assert.equal(infos[0].path, firstExact);
    assert.equal(codexRolloutDiscoveryReceipt(infos).duplicateRepresentationCount, 1);

    await writeRecent(secondExact, rollout([
      canonicalMeta({ id: THREAD_A }),
      { timestamp: "2026-07-30T12:00:01.000Z", type: "event_msg", payload: { type: "different" } },
    ]));
    const unrelatedPath = join(
      fixture.sessions,
      canonicalName("2026-07-30T13-00-00", THREAD_B),
    );
    await writeRecent(unrelatedPath, rollout([canonicalMeta({ id: THREAD_B })]));
    infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [unrelatedPath]);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.skippedSourceCount, 2);
    assert.equal(receipt.skippedThreadCount, 1);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_generation_ambiguous: 1,
    });
    assert.equal(JSON.stringify(receipt.diagnosticGroups).includes(THREAD_A), false);
    assert.equal(JSON.stringify(receipt.diagnosticGroups).includes(firstExact), false);
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("a divergent active/archive representation is quarantined instead of silently preferring active", async () => {
  const fixture = await emptyCanonicalHome("codex-divergent-location-");
  const archive = join(fixture.codexHome, "archived_sessions");
  await mkdir(archive, { recursive: true });
  try {
    const name = canonicalName("2026-07-30T11-00-00", THREAD_A);
    await writeRecent(
      join(fixture.sessions, name),
      rollout([canonicalMeta({ id: THREAD_A })]),
    );
    await writeRecent(join(archive, name), rollout([
      canonicalMeta({ id: THREAD_A }),
      {
        timestamp: "2026-07-30T11:00:01.000Z",
        type: "event_msg",
        payload: { type: "divergent" },
      },
    ]));
    const unrelated = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_B),
    );
    await writeRecent(
      unrelated,
      rollout([canonicalMeta({ id: THREAD_B })]),
    );

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [unrelated]);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.skippedSourceCount, 2);
    assert.equal(receipt.skippedThreadCount, 1);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_generation_ambiguous: 1,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("an immutable rollout identity cannot be owned by two logical threads", async () => {
  const fixture = await emptyCanonicalHome("codex-cross-thread-rollout-id-");
  try {
    const baseBRecords = [canonicalMeta({ id: THREAD_B })];
    const baseB = rollout(baseBRecords);
    await writeRecent(
      join(fixture.sessions, canonicalName("2026-07-30T10-00-00", THREAD_A)),
      rollout([canonicalMeta({ id: THREAD_A })]),
    );
    await writeRecent(
      join(fixture.sessions, canonicalName("2026-07-30T10-00-01", THREAD_B)),
      baseB,
    );
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T10-00-02", THREAD_B, THREAD_A),
    ), rollout([canonicalMeta({
      id: THREAD_B,
      ordinal: baseBRecords.length,
      historyBase: {
        rolloutId: THREAD_B,
        endOrdinalExclusive: baseBRecords.length,
        endByteOffset: Buffer.byteLength(baseB),
      },
    })]));

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(infos.length, 0);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.skippedSourceCount, 3);
    assert.equal(receipt.skippedThreadCount, 2);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_generation_ambiguous: 2,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("noncanonical basenames remain distinct when they do not contain rollout prefix text", async () => {
  const fixture = await emptyCanonicalHome("codex-noncanonical-name-");
  try {
    const first = join(fixture.sessions, "first.jsonl");
    const second = join(fixture.sessions, "second.jsonl");
    await writeRecent(first, rollout([sessionMeta({ id: "legacy-thread-first" })]));
    await writeRecent(second, rollout([sessionMeta({ id: "legacy-thread-second" })]));
    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.rolloutKey).sort(), [
      "first.jsonl",
      "second.jsonl",
    ]);
    assert.equal(codexRolloutDiscoveryReceipt(infos).status, "complete");
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("a rollout without session metadata is a bounded lineage quarantine", async () => {
  const fixture = await emptyCanonicalHome("codex-missing-session-meta-");
  try {
    await writeRecent(join(fixture.sessions, "damaged.jsonl"), rollout([{
      timestamp: "2026-07-30T12:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }]));
    const unrelated = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-01", THREAD_B),
    );
    await writeRecent(
      unrelated,
      rollout([canonicalMeta({ id: THREAD_B })]),
    );
    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [unrelated]);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.skippedSourceCount, 1);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_lineage_invalid: 1,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("old ambiguous groups outside the requested window do not poison a recent source", async () => {
  const fixture = await emptyCanonicalHome();
  try {
    const privateId = "old-private-noncanonical-thread";
    for (const suffix of ["a", "b"]) {
      const path = join(
        fixture.sessions,
        `rollout-2026-07-29T00-00-0${suffix === "a" ? "0" : "1"}-${suffix}.jsonl`,
      );
      await writeFile(path, rollout([sessionMeta({ id: privateId })]), { mode: 0o600 });
      await utimes(path, OLD_MTIME, OLD_MTIME);
    }
    const recentPath = join(
      fixture.sessions,
      canonicalName("2026-07-30T13-00-00", THREAD_B),
    );
    await writeRecent(recentPath, rollout([canonicalMeta({ id: THREAD_B })]));

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [recentPath]);
    assert.equal(codexRolloutDiscoveryReceipt(infos).status, "complete");
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("missing, out-of-bounds and cyclic history bases quarantine with one fixed lineage code", async (t) => {
  await t.test("missing base", async () => {
    const fixture = await emptyCanonicalHome("codex-missing-base-");
    try {
      const path = join(
        fixture.sessions,
        canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A2),
      );
      await writeRecent(path, rollout([canonicalMeta({
        id: THREAD_A,
        historyBase: {
          rolloutId: ROLLOUT_A3,
          endOrdinalExclusive: 1,
          endByteOffset: 1,
        },
      })]));
      const infos = await discoverCodexRolloutInfos({
        codexHome: fixture.codexHome,
        startAt: START_AT,
        endAt: END_AT,
      });
      assert.equal(infos.length, 0);
      assert.deepEqual(codexRolloutDiscoveryReceipt(infos).reasonCounts, {
        codex_rollout_lineage_invalid: 1,
      });
    } finally {
      await rm(fixture.codexHome, { recursive: true, force: true });
    }
  });

  await t.test("out of bounds", async () => {
    const fixture = await emptyCanonicalHome("codex-out-of-bounds-");
    try {
      const base = rollout([canonicalMeta({ id: THREAD_A })]);
      await writeRecent(join(
        fixture.sessions,
        canonicalName("2026-07-30T11-00-00", THREAD_A),
      ), base);
      await writeRecent(join(
        fixture.sessions,
        canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A2),
      ), rollout([canonicalMeta({
        id: THREAD_A,
        ordinal: 1,
        historyBase: {
          rolloutId: THREAD_A,
          endOrdinalExclusive: 1,
          endByteOffset: Buffer.byteLength(base) + 1,
        },
      })]));
      const infos = await discoverCodexRolloutInfos({
        codexHome: fixture.codexHome,
        startAt: START_AT,
        endAt: END_AT,
      });
      assert.equal(infos.length, 0);
      assert.deepEqual(codexRolloutDiscoveryReceipt(infos).reasonCounts, {
        codex_rollout_lineage_invalid: 1,
      });
    } finally {
      await rm(fixture.codexHome, { recursive: true, force: true });
    }
  });

  await t.test("cycle", async () => {
    const fixture = await emptyCanonicalHome("codex-cycle-");
    try {
      let firstBytes = 1;
      let secondBytes = 1;
      let first = "";
      let second = "";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        first = rollout([canonicalMeta({
          id: THREAD_A,
          historyBase: {
            rolloutId: ROLLOUT_A3,
            endOrdinalExclusive: 1,
            endByteOffset: secondBytes,
          },
        })]);
        second = rollout([canonicalMeta({
          id: THREAD_A,
          historyBase: {
            rolloutId: ROLLOUT_A2,
            endOrdinalExclusive: 1,
            endByteOffset: Buffer.byteLength(first),
          },
        })]);
        const nextFirst = Buffer.byteLength(first);
        const nextSecond = Buffer.byteLength(second);
        if (nextFirst === firstBytes && nextSecond === secondBytes) break;
        firstBytes = nextFirst;
        secondBytes = nextSecond;
      }
      await writeRecent(join(
        fixture.sessions,
        canonicalName("2026-07-30T11-00-00", THREAD_A, ROLLOUT_A2),
      ), first);
      await writeRecent(join(
        fixture.sessions,
        canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A3),
      ), second);
      const infos = await discoverCodexRolloutInfos({
        codexHome: fixture.codexHome,
        startAt: START_AT,
        endAt: END_AT,
      });
      assert.equal(infos.length, 0);
      assert.deepEqual(codexRolloutDiscoveryReceipt(infos).reasonCounts, {
        codex_rollout_lineage_invalid: 1,
      });
    } finally {
      await rm(fixture.codexHome, { recursive: true, force: true });
    }
  });
});

test("quarantine propagates through a physical history dependency without blocking unrelated threads", async () => {
  const fixture = await emptyCanonicalHome("codex-invalid-base-group-");
  try {
    const baseMeta = rollout([canonicalMeta({ id: THREAD_A })]);
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T10-00-00", THREAD_A),
    ), baseMeta);
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T10-00-01", THREAD_A),
    ), rollout([
      canonicalMeta({ id: THREAD_A }),
      {
        timestamp: "2026-07-30T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "divergent-copy" },
      },
    ]));
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T11-00-00", THREAD_B, ROLLOUT_A2),
    ), rollout([canonicalMeta({
      id: THREAD_B,
      ordinal: 1,
      historyBase: {
        rolloutId: THREAD_A,
        endOrdinalExclusive: 1,
        endByteOffset: Buffer.byteLength(baseMeta),
      },
    })]));
    const unrelatedPath = join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_C),
    );
    await writeRecent(
      unrelatedPath,
      rollout([canonicalMeta({ id: THREAD_C })]),
    );

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [unrelatedPath]);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.skippedSourceCount, 3);
    assert.equal(receipt.skippedThreadCount, 2);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_generation_ambiguous: 1,
      codex_rollout_lineage_invalid: 1,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("quarantine propagates through a deep logical chain without recursion", async () => {
  const fixture = await emptyCanonicalHome("codex-deep-quarantine-chain-");
  const depth = 128;
  try {
    await writeRecent(
      join(fixture.sessions, "ambiguous-root-a.jsonl"),
      rollout([sessionMeta({ id: "chain-0" })]),
    );
    await writeRecent(
      join(fixture.sessions, "ambiguous-root-b.jsonl"),
      rollout([sessionMeta({ id: "chain-0" })]),
    );
    for (let index = 1; index <= depth; index += 1) {
      await writeRecent(
        join(fixture.sessions, `chain-${String(index).padStart(3, "0")}.jsonl`),
        rollout([sessionMeta({
          id: `chain-${index}`,
          parentId: `chain-${index - 1}`,
        })]),
      );
    }

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(infos.length, 0);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.skippedSourceCount, depth + 2);
    assert.equal(receipt.skippedThreadCount, depth + 1);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_generation_ambiguous: 1,
      codex_rollout_lineage_invalid: depth,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("compressed and filename-mismatched rollouts are explicit bounded quarantines", async () => {
  const fixture = await emptyCanonicalHome();
  try {
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T11-00-00", THREAD_A, null, ".jsonl.zst"),
    ), "not-decompressed-private-bytes");
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_B),
    ), rollout([canonicalMeta({ id: ROLLOUT_A2 })]));
    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(infos.length, 0);
    assert.equal(receipt.skippedThreadCount, 2);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_compression_unsupported: 1,
      codex_rollout_filename_identity_mismatch: 1,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("an inline child cannot escape a filename-mismatched parent's quarantine", async () => {
  const fixture = await emptyCanonicalHome("codex-mismatched-parent-chain-");
  try {
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T11-00-00", THREAD_A),
    ), rollout([canonicalMeta({ id: ROLLOUT_A2 })]));
    await writeRecent(join(
      fixture.sessions,
      canonicalName("2026-07-30T12-00-00", THREAD_B),
    ), rollout([canonicalMeta({ id: THREAD_B, parentId: ROLLOUT_A2 })]));
    const healthyPath = join(
      fixture.sessions,
      canonicalName("2026-07-30T13-00-00", THREAD_C),
    );
    await writeRecent(
      healthyPath,
      rollout([canonicalMeta({ id: THREAD_C })]),
    );

    const infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.deepEqual(infos.map((info) => info.path), [healthyPath]);
    const receipt = codexRolloutDiscoveryReceipt(infos);
    assert.equal(receipt.skippedSourceCount, 2);
    assert.equal(receipt.skippedThreadCount, 2);
    assert.deepEqual(receipt.reasonCounts, {
      codex_rollout_filename_identity_mismatch: 1,
      codex_rollout_lineage_invalid: 1,
    });
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("complete-coverage consumers stop before emitting records from a mixed partial corpus", async () => {
  const fixture = await emptyCanonicalHome();
  let usageCallbacks = 0;
  try {
    await writeRecent(
      join(fixture.sessions, canonicalName("2026-07-30T11-00-00", THREAD_A)),
      rollout([
        canonicalMeta({ id: THREAD_A }),
        {
          timestamp: "2026-07-30T11:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" },
        },
        {
          timestamp: "2026-07-30T11:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
                total_tokens: 11,
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
                total_tokens: 11,
              },
            },
          },
        },
      ]),
    );
    const ambiguous = rollout([canonicalMeta({ id: "ambiguous-thread" })]);
    await writeRecent(
      join(fixture.sessions, "rollout-2026-07-30T12-00-00-ambiguous-a.jsonl"),
      ambiguous,
    );
    await writeRecent(
      join(fixture.sessions, "rollout-2026-07-30T12-00-01-ambiguous-b.jsonl"),
      ambiguous,
    );

    await assert.rejects(
      scanCodexLogEvents({
        codexHome: fixture.codexHome,
        startAt: START_AT,
        endAt: END_AT,
        requireCompleteDiscovery: true,
        onUsage() { usageCallbacks += 1; },
      }),
      (error) => error?.name === "CodexRolloutCoverageError"
        && error?.code === "codex_rollout_generation_ambiguous",
    );
    assert.equal(usageCallbacks, 0);
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});

test("Codex SQLite selected heads are owner-controlled hints and stale or missing hints fall back safely", async () => {
  const fixture = await emptyCanonicalHome();
  const databaseFile = join(fixture.codexHome, "state_5.sqlite");
  try {
    assert.equal(await readCodexSelectedRolloutNames(fixture.codexHome), null);
    if (process.platform === "win32") {
      // Windows has no owner-only POSIX mode proof. Do not create or chmod an
      // optional SQLite hint there; canonical metadata is the safe fallback.
      return;
    }
    const database = new DatabaseSync(databaseFile);
    database.exec("CREATE TABLE threads(id TEXT, rollout_path TEXT)");
    database.prepare("INSERT INTO threads(id, rollout_path) VALUES (?, ?)").run(
      THREAD_A,
      join(fixture.sessions, canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A2)),
    );
    database.prepare("INSERT INTO threads(id, rollout_path) VALUES (?, ?)").run(
      THREAD_B,
      join(fixture.sessions, canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A3)),
    );
    database.close();
    await chmod(databaseFile, 0o600);
    assert.deepEqual(await readCodexSelectedRolloutNames(fixture.codexHome), new Map([
      [
        THREAD_A,
        canonicalName("2026-07-30T12-00-00", THREAD_A, ROLLOUT_A2),
      ],
    ]));

    const baseRecords = [
      canonicalMeta({ id: THREAD_A }),
      {
        ordinal: 1,
        timestamp: "2026-07-30T11:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
    ];
    const base = rollout(baseRecords);
    await writeRecent(
      join(fixture.sessions, canonicalName("2026-07-30T11-00-00", THREAD_A)),
      base,
    );
    await writeRecent(
      join(fixture.sessions, canonicalName(
        "2026-07-30T12-00-00",
        THREAD_A,
        ROLLOUT_A2,
      )),
      rollout([canonicalMeta({
        id: THREAD_A,
        historyBase: {
          rolloutId: THREAD_A,
          endOrdinalExclusive: baseRecords.length,
          endByteOffset: Buffer.byteLength(base),
        },
      })]),
    );
    let infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(
      infos.find((info) => info.rolloutId === ROLLOUT_A2)?.selectedHead,
      true,
    );
    assert.equal(
      infos.find((info) => info.rolloutId === ROLLOUT_A2)?.resolvedHead,
      true,
    );

    const stale = new DatabaseSync(databaseFile);
    stale.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(
      join(
        fixture.sessions,
        canonicalName("2026-07-30T11-00-00", THREAD_A),
      ),
      THREAD_A,
    );
    stale.close();
    infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(
      infos.find((info) => info.rolloutId === THREAD_A)?.selectedHead,
      true,
    );
    assert.equal(
      infos.find((info) => info.rolloutId === ROLLOUT_A2)?.resolvedHead,
      true,
    );

    await chmod(databaseFile, 0o666);
    assert.equal(await readCodexSelectedRolloutNames(fixture.codexHome), null);
    infos = await discoverCodexRolloutInfos({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(
      infos.find((info) => info.rolloutId === ROLLOUT_A2)?.selectedHead,
      false,
    );
    assert.equal(
      infos.find((info) => info.rolloutId === ROLLOUT_A2)?.resolvedHead,
      true,
    );
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});
