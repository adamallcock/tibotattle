import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES,
  CLAUDE_DESKTOP_SHADOW_PROVIDER,
  openClaudeDesktopShadowStore,
} from "../src/claude-desktop-shadow-store.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const DIGEST_A = "c".repeat(64);
const DIGEST_B = "d".repeat(64);

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

function usageRecord({ eventTimeMs, recordKey = KEY_A, payloadDigest = DIGEST_A, revision = 1 }) {
  return {
    kind: "usage",
    sourceGeneration: 1,
    eventTimeMs,
    recordKey,
    payloadDigest,
    revision,
  };
}

test("shadow store is disabled without creating state or exposing a remote/UI lane", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-disabled-");
  try {
    const statePath = join(root, "shadow.sqlite");
    const store = openClaudeDesktopShadowStore({ statePath });
    assert.deepEqual(store.status(), {
      schemaVersion: "claude-desktop-shadow-store-v0.1",
      provider: CLAUDE_DESKTOP_SHADOW_PROVIDER,
      status: "disabled",
      enabled: false,
      localOnly: true,
      uiEnabled: false,
      uploadEnabled: false,
    });
    assert.deepEqual(store.ingest([usageRecord({ eventTimeMs: 100 })]), {
      status: "disabled",
      inserted: 0,
      duplicates: 0,
      tombstoned: 0,
    });
    await assert.rejects(stat(statePath), { code: "ENOENT" });
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadow namespace keeps immutable corrections, rejects content/path fields, and reopens owner-only", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-ledger-");
  try {
    const statePath = join(root, "shadow.sqlite");
    const store = openClaudeDesktopShadowStore({ statePath, enabled: true });
    assert.equal(store.status().uploadEnabled, false);
    assert.deepEqual(store.ingest([
      usageRecord({ eventTimeMs: 100 }),
      usageRecord({ eventTimeMs: 100, recordKey: KEY_B, payloadDigest: DIGEST_B, revision: 2 }),
    ], { acceptedAtMs: 500 }), {
      status: "enabled",
      inserted: 2,
      duplicates: 0,
      tombstoned: 0,
    });
    assert.deepEqual(store.ingest([usageRecord({ eventTimeMs: 100 })]), {
      status: "enabled",
      inserted: 0,
      duplicates: 1,
      tombstoned: 0,
    });
    assert.throws(
      () => store.ingest([{ ...usageRecord({ eventTimeMs: 300 }), content: "private-canary" }]),
      (error) => error.code === "claude_desktop_shadow_record",
    );
    assert.throws(
      () => store.ingest([{ ...usageRecord({ eventTimeMs: 300 }), provider: "openai_codex" }]),
      (error) => error.code === "claude_desktop_shadow_provider",
    );
    assert.throws(
      () => store.ingest([{
        ...usageRecord({ eventTimeMs: 300 }),
        kind: "quota",
      }]),
      (error) => error.code === "claude_desktop_shadow_record_kind",
    );
    assert.deepEqual(store.snapshot().counts, {
      records: 2,
      artifacts: 0,
      tombstones: 0,
      receipts: 0,
    });
    store.close();
    const reopened = openClaudeDesktopShadowStore({ statePath, enabled: true });
    try {
      assert.equal(reopened.snapshot().counts.records, 2);
      assert.equal(JSON.stringify(reopened.snapshot()).includes("private-canary"), false);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider/source-period purge removes logical and explicit physical artifacts and tombstones re-import", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-purge-");
  const artifactsRoot = join(root, "artifacts");
  await mkdir(artifactsRoot, { mode: 0o700 });
  await chmod(artifactsRoot, 0o700);
  try {
    const statePath = join(root, "shadow.sqlite");
    const store = openClaudeDesktopShadowStore({ statePath, enabled: true });
    try {
      assert.deepEqual(store.ingest([
        usageRecord({ eventTimeMs: 100 }),
        usageRecord({ eventTimeMs: 150, recordKey: KEY_B, payloadDigest: DIGEST_B }),
        usageRecord({ eventTimeMs: 300, recordKey: KEY_B, payloadDigest: DIGEST_A }),
      ]), {
        status: "enabled",
        inserted: 3,
        duplicates: 0,
        tombstoned: 0,
      });
      for (const [index, kind] of CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES.entries()) {
        await writeFile(join(artifactsRoot, `${kind}-${index}.bin`), "artifact", { mode: 0o600 });
      }
      await writeFile(join(artifactsRoot, "unrelated.bin"), "keep", { mode: 0o600 });
      const physical = CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES.map((kind, index) => ({
        kind,
        path: join(artifactsRoot, `${kind}-${index}.bin`),
      }));
      for (const [index, kind] of ["projection", "cache", "checkpoint"].entries()) {
        assert.deepEqual(store.putArtifact({
          kind,
          sourceGeneration: 1,
          eventTimeMs: 150,
          artifactKey: `${String(index + 1).repeat(64)}`.slice(0, 64),
          artifactDigest: `${String(index + 4).repeat(64)}`.slice(0, 64),
        }), {
          status: "enabled",
          inserted: 1,
          duplicate: false,
          tombstoned: 0,
        });
      }
      const receipt = store.purge({
        sourceGeneration: 1,
        startAtMs: 100,
        endAtMs: 200,
        createdAtMs: 600,
        artifactRoot: artifactsRoot,
        artifacts: physical,
      });
      assert.equal(receipt.provider, CLAUDE_DESKTOP_SHADOW_PROVIDER);
      assert.equal(receipt.logicalRecordsDeleted, 2);
      assert.equal(receipt.logicalArtifactsDeleted, 3);
      assert.equal(receipt.physicalRemoved, CLAUDE_DESKTOP_SHADOW_ARTIFACT_CLASSES.length);
      assert.equal(receipt.status, "purged");
      assert.equal(JSON.stringify(receipt).includes(artifactsRoot), false);
      for (const artifact of physical) await assert.rejects(stat(artifact.path), { code: "ENOENT" });
      assert.equal((await stat(join(artifactsRoot, "unrelated.bin")).then(() => true)), true);

      const exactReplay = store.purge({
        sourceGeneration: 1,
        startAtMs: 100,
        endAtMs: 200,
        createdAtMs: 600,
        artifactRoot: artifactsRoot,
        artifacts: physical,
      });
      assert.deepEqual(exactReplay, receipt);

      assert.deepEqual(store.ingest([
        usageRecord({ eventTimeMs: 150 }),
        usageRecord({ eventTimeMs: 300, recordKey: KEY_B, payloadDigest: DIGEST_A }),
      ]), {
        status: "enabled",
        inserted: 0,
        duplicates: 1,
        tombstoned: 1,
      });
      assert.equal(store.snapshot().counts.records, 1);
      assert.deepEqual(store.putArtifact({
        kind: "cache",
        sourceGeneration: 1,
        artifactKey: KEY_A,
        artifactDigest: DIGEST_A,
      }), {
        status: "enabled",
        inserted: 0,
        duplicate: false,
        tombstoned: 1,
      });

      const repeated = store.purge({
        sourceGeneration: 1,
        startAtMs: 100,
        endAtMs: 200,
        createdAtMs: 601,
        artifactRoot: artifactsRoot,
        artifacts: physical,
      });
      assert.equal(repeated.status, "purged");
      assert.equal(repeated.physicalRemoved, 0);
      assert.equal(repeated.physicalMissing, physical.length);
      assert.notEqual(repeated.receiptKey, receipt.receiptKey);

      const failedRoot = join(artifactsRoot, "locked");
      await mkdir(failedRoot, { mode: 0o700 });
      await chmod(failedRoot, 0o700);
      const failedPath = join(failedRoot, "cache.bin");
      await writeFile(failedPath, "must-remain", { mode: 0o600 });
      await chmod(failedRoot, 0o500);
      const partial = store.purge({
        sourceGeneration: 1,
        startAtMs: 300,
        endAtMs: 300,
        createdAtMs: 602,
        artifactRoot: artifactsRoot,
        artifacts: [{ kind: "cache", path: failedPath }],
      });
      assert.equal(partial.status, "partial");
      assert.equal(partial.physicalFailed, 1);
      assert.equal(JSON.stringify(partial).includes(failedPath), false);
      await chmod(failedRoot, 0o700);
      await rm(failedRoot, { recursive: true, force: true });
    } finally {
      store.close();
    }
    const reopened = openClaudeDesktopShadowStore({ statePath, enabled: true });
    try {
      assert.equal(reopened.snapshot().counts.tombstones, 2);
      assert.equal(reopened.snapshot().counts.receipts, 3);
      assert.equal(reopened.readPurgeReceipts().filter((item) => item.status === "partial").length, 1);
      assert.deepEqual(reopened.ingest([usageRecord({ eventTimeMs: 125, recordKey: KEY_B })]), {
        status: "enabled",
        inserted: 0,
        duplicates: 0,
        tombstoned: 1,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical purge rejects traversal, symlink, and non-owner artifact targets before writing a tombstone", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-purge-safe-");
  const artifactsRoot = join(root, "artifacts");
  await mkdir(artifactsRoot, { mode: 0o700 });
  await chmod(artifactsRoot, 0o700);
  try {
    const statePath = join(root, "shadow.sqlite");
    const store = openClaudeDesktopShadowStore({ statePath, enabled: true });
    try {
      assert.throws(
        () => store.purge({
          artifactRoot: artifactsRoot,
          artifacts: [{ kind: "cache", path: join(artifactsRoot, "..", "outside.bin") }],
        }),
        (error) => error.code === "claude_desktop_shadow_artifact_path",
      );
      assert.throws(
        () => store.purge({
          artifactRoot: artifactsRoot,
          artifacts: [{ kind: "cache", path: join(root, "artifacts-sibling", "outside.bin") }],
        }),
        (error) => error.code === "claude_desktop_shadow_artifact_path",
      );
      assert.throws(
        () => store.purge({
          artifactRoot: root,
          artifacts: [{ kind: "ledger", path: statePath }],
        }),
        (error) => error.code === "claude_desktop_shadow_artifact_protected",
      );
      assert.equal(store.snapshot().counts.tombstones, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
