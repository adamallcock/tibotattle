import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { localCompanionStatePaths } from "../src/local-installation-diagnostics.js";
import {
  resolveLinuxXdgRoots,
  validateLinuxXdgRoots,
} from "../src/platform/linux-xdg-paths.js";
import {
  LINUX_EXTERNAL_OWNER_CONSUMER_INVENTORY,
  LINUX_STATE_CONSUMER_INVENTORY,
  assertLinuxStateComposition,
  createLinuxStateComposition,
} from "../src/platform/linux-state-composition.js";

async function validatedFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tibotattle-linux-state-")),
  );
  const environment = {};
  for (const kind of ["config", "state", "cache", "runtime"]) {
    const base = join(root, kind);
    environment[`XDG_${kind.toUpperCase()}_HOME`] = base;
    await mkdir(join(base, "app-usagemonitor"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(base, 0o700);
    await chmod(join(base, "app-usagemonitor"), 0o700);
  }
  environment.XDG_RUNTIME_DIR = environment.XDG_RUNTIME_HOME;
  delete environment.XDG_RUNTIME_HOME;
  const roots = resolveLinuxXdgRoots({
    platform: "linux",
    homeDirectory: root,
    environment,
  });
  const validation = await validateLinuxXdgRoots(roots, { platform: "linux" });
  return { root, validation };
}

test("Linux state composition inventories named owners over one validated state root", async () => {
  const fixture = await validatedFixture();
  try {
    const composition = await createLinuxStateComposition({ validation: fixture.validation });
    assert.equal(assertLinuxStateComposition(composition), composition);
    assert.equal(composition.integrationStatus, "dormant");
    assert.equal(Object.isFrozen(LINUX_STATE_CONSUMER_INVENTORY), true);
    assert.deepEqual(
      LINUX_STATE_CONSUMER_INVENTORY.map(({ id }) => id),
      [
        "participant_identity",
        "account_observation",
        "claude_callback",
        "contribution_binding",
        "collector_state",
        "collector_legacy_migration",
        "legacy_analysis_index",
        "archive_accounting_index",
        "unified_index",
        "claude_desktop_quota",
        "claude_desktop_shadow",
        "contribution_queue",
        "prepared_artifacts",
        "review_pairs",
        "local_preferences",
        "activity_markers",
        "diagnostics_log",
      ],
    );
    assert.deepEqual(
      LINUX_EXTERNAL_OWNER_CONSUMER_INVENTORY.map(({ id, state }) => [id, state]),
      [
        ["metadata_bundles", "requires_explicit_owner_root"],
        ["deletion_controls", "requires_explicit_owner_root"],
        ["discard_controls", "requires_explicit_owner_root"],
      ],
    );

    const existing = localCompanionStatePaths(composition.roots.state);
    const inventoriedPaths = new Set(Object.values(composition.paths).flat());
    for (const [name, path] of Object.entries(existing)) {
      assert.equal(inventoriedPaths.has(path), true, name);
    }
    assert.equal(
      inventoriedPaths.has(join(composition.roots.state, "diagnostics-v0.1.log")),
      true,
    );
    assert.equal(composition.paths.collector_state[0], existing.collectorStateFile);
    assert.equal(composition.paths.unified_index[0], existing.unifiedIndexFile);
    assert.equal(
      composition.paths.prepared_artifacts[0],
      existing.preparedSpoolDirectory,
    );
    assert.equal(composition.paths.review_pairs[0], existing.reviewArchiveDirectory);
    assert.deepEqual(composition.sqliteUnits.unifiedIndex, {
      database: existing.unifiedIndexFile,
      rollbackJournal: `${existing.unifiedIndexFile}-journal`,
      wal: `${existing.unifiedIndexFile}-wal`,
      sharedMemory: `${existing.unifiedIndexFile}-shm`,
    });
    for (const unit of Object.values(composition.sqliteUnits)) {
      assert.equal(inventoriedPaths.has(unit.database), true);
      assert.equal(unit.rollbackJournal, `${unit.database}-journal`);
      assert.equal(unit.wal, `${unit.database}-wal`);
      assert.equal(unit.sharedMemory, `${unit.database}-shm`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Linux state composition rejects copied validation and copied composition objects", async () => {
  const fixture = await validatedFixture();
  try {
    await assert.rejects(
      createLinuxStateComposition({ validation: { ...fixture.validation } }),
      (error) => error?.code === "linux_xdg_validation_untrusted",
    );
    const composition = await createLinuxStateComposition({ validation: fixture.validation });
    assert.throws(
      () => assertLinuxStateComposition({ ...composition }),
      (error) => error?.code === "linux_state_composition_untrusted",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Linux state composition revalidates XDG root identities at point of use", async () => {
  const fixture = await validatedFixture();
  try {
    const stateRoot = fixture.validation.roots.application.state;
    await rename(stateRoot, `${stateRoot}.replaced`);
    await mkdir(stateRoot, { mode: 0o700 });
    await chmod(stateRoot, 0o700);
    await assert.rejects(
      createLinuxStateComposition({ validation: fixture.validation }),
      (error) => error?.code === "linux_xdg_directory_replaced",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
