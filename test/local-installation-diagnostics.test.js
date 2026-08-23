import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative } from "node:path";
import {
  LOCAL_ONBOARDING_SCHEMA_VERSION,
  MAXIMUM_OBSERVED_ROLLOUT_FILES,
  assertLocalStatePath,
  defaultLocalCompanionStateRoot,
  inspectLocalOnboarding,
  localCompanionStatePaths,
  prepareLocalInstallationRoots,
  projectLocalOnboarding,
} from "../src/local-installation-diagnostics.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-installation-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  await mkdir(resourceRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(codexHome, "archived_sessions"), {
    recursive: true,
    mode: 0o700,
  });
  return { root, resourceRoot, stateRoot, codexHome };
}

test("installation roots separate immutable resources from owner-only state", async () => {
  const files = await fixture();
  try {
    const installation = prepareLocalInstallationRoots({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
    });
    assert.equal(installation.resourceRoot, files.resourceRoot);
    assert.equal(installation.stateRoot, files.stateRoot);
    for (const path of Object.values(installation.paths)) {
      assert.equal(isAbsolute(path), true);
      assert.equal(relative(files.stateRoot, path).startsWith(".."), false);
      assert.notEqual(relative(files.stateRoot, path), "");
      assert.equal(relative(files.resourceRoot, path).startsWith(".."), true);
    }
    if (process.platform !== "win32") {
      const metadata = await lstat(files.stateRoot);
      assert.equal(metadata.mode & 0o777, 0o700);
    }
    assert.equal(defaultLocalCompanionStateRoot({
      platform: "linux",
      homeDirectory: "/portable-home",
      environment: {},
    }), posix.join(
      "/portable-home",
      ".local",
      "state",
      "app-usagemonitor",
    ));
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("legacy accounting rollback paths stay explicit and state-scoped", () => {
  const stateRoot = join(tmpdir(), "local-installation-explicit-state");
  const paths = localCompanionStatePaths(stateRoot);

  assert.equal(
    paths.legacyAnalysisIndexFile,
    join(stateRoot, "local-analysis-index-v2.sqlite"),
  );
  assert.equal(
    paths.legacyAnalysisIndexSecretFile,
    join(stateRoot, "local-analysis-index-secret-v2"),
  );
  assert.equal(
    paths.archiveAccountingIndexFile,
    join(stateRoot, "local-archive-accounting-index-v1.sqlite"),
  );
  assert.equal(
    paths.archiveAccountingIndexSecretFile,
    join(stateRoot, "local-archive-accounting-index-v1-secret"),
  );
});

test("installation roots reject relative, overlapping, symlink, and open state directories", async () => {
  const files = await fixture();
  const symlinkTarget = join(files.root, "symlink-target");
  const symlinkState = join(files.root, "symlink-state");
  const resourceAlias = join(files.root, "resource-alias");
  const aliasedState = join(resourceAlias, "must-not-be-created");
  const openState = join(files.root, "open-state");
  await mkdir(symlinkTarget, { mode: 0o700 });
  await symlink(symlinkTarget, symlinkState);
  await symlink(files.resourceRoot, resourceAlias);
  await mkdir(openState, { mode: 0o755 });
  const assertInvalid = (options) => assert.throws(
    () => prepareLocalInstallationRoots(options),
    (error) => error?.code === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID"
      && error.message === "Local installation configuration is invalid"
      && !error.message.includes(files.root)
      && !JSON.stringify(error).includes(files.root),
  );
  try {
    assertInvalid({
      resourceRoot: "relative-resources",
      stateRoot: files.stateRoot,
    });
    assertInvalid({
      resourceRoot: files.resourceRoot,
      stateRoot: "relative-state",
    });
    assertInvalid({
      resourceRoot: files.resourceRoot,
      stateRoot: join(files.resourceRoot, "state"),
    });
    assertInvalid({
      resourceRoot: files.resourceRoot,
      stateRoot: symlinkState,
    });
    assertInvalid({
      resourceRoot: files.resourceRoot,
      stateRoot: aliasedState,
    });
    await assert.rejects(lstat(join(
      files.resourceRoot,
      "must-not-be-created",
    )));
    prepareLocalInstallationRoots({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
    });
    await symlink(
      symlinkTarget,
      join(files.stateRoot, "state-path-escape"),
    );
    assert.throws(
      () => assertLocalStatePath(
        files.stateRoot,
        join(files.stateRoot, "state-path-escape", "queue.sqlite3"),
      ),
      (error) => error?.code
        === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID",
    );
    if (process.platform !== "win32") {
      assertInvalid({
        resourceRoot: files.resourceRoot,
        stateRoot: openState,
      });
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("onboarding reports capped source readiness without paths, names, content, or identifiers", async () => {
  const files = await fixture();
  const privateCanary = "account-private-canary";
  const nestedSessions = join(
    files.codexHome,
    "sessions",
    "2026",
    "07",
    "27",
  );
  await mkdir(nestedSessions, { recursive: true, mode: 0o700 });
  await Promise.all(Array.from(
    { length: MAXIMUM_OBSERVED_ROLLOUT_FILES + 7 },
    (_, index) => writeFile(
      join(
        nestedSessions,
        `rollout-private-name-${index}.jsonl`,
      ),
      `${JSON.stringify({
        accountId: privateCanary,
        content: `private-content-${index}`,
      })}\n`,
      { mode: 0o600 },
    ),
  ));
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHome: files.codexHome,
      stateRoot: files.stateRoot,
      explicitRefresh: true,
    });
    assert.deepEqual(onboarding, {
      schemaVersion: LOCAL_ONBOARDING_SCHEMA_VERSION,
      status: "ready",
      source: {
        status: "ready",
        availability: "ready",
        configuredRoots: 1,
        availableRoots: 1,
        emptyRoots: 0,
        unavailableRoots: 0,
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: MAXIMUM_OBSERVED_ROLLOUT_FILES,
        rolloutFilesObservedCapped: true,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
    const serialized = JSON.stringify(onboarding);
    assert.equal(serialized.includes(files.root), false);
    assert.equal(serialized.includes("rollout-private-name"), false);
    assert.equal(serialized.includes("private-content"), false);
    assert.equal(serialized.includes(privateCanary), false);
    assert.deepEqual(await readdir(files.stateRoot), []);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("onboarding is ready for a fresh install with active sessions only", async () => {
  const files = await fixture();
  await rm(join(files.codexHome, "archived_sessions"), {
    recursive: true,
  });
  await writeFile(
    join(files.codexHome, "sessions", "rollout-current.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHome: files.codexHome,
      stateRoot: files.stateRoot,
    });
    assert.equal(onboarding.status, "ready");
    assert.deepEqual(onboarding.source, {
      status: "ready",
      availability: "ready",
      configuredRoots: 1,
      availableRoots: 1,
      emptyRoots: 0,
      unavailableRoots: 0,
      sessionsReadable: true,
      archivedSessionsReadable: false,
      rolloutFilesPresent: true,
      rolloutFilesObserved: 1,
      rolloutFilesObservedCapped: false,
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("multi-root onboarding isolates an unavailable root while preserving operational readiness", async () => {
  const files = await fixture();
  const unavailableRoot = join(files.root, "stopped-wsl-profile", ".codex");
  await writeFile(
    join(files.codexHome, "sessions", "rollout-current.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHomes: [files.codexHome, unavailableRoot],
      stateRoot: files.stateRoot,
    });
    assert.equal(onboarding.status, "ready");
    assert.deepEqual(onboarding.source, {
      status: "ready",
      availability: "partial",
      configuredRoots: 2,
      availableRoots: 1,
      emptyRoots: 0,
      unavailableRoots: 1,
      sessionsReadable: true,
      archivedSessionsReadable: true,
      rolloutFilesPresent: true,
      rolloutFilesObserved: 1,
      rolloutFilesObservedCapped: false,
    });
    const serialized = JSON.stringify(onboarding);
    assert.equal(serialized.includes(files.codexHome), false);
    assert.equal(serialized.includes(unavailableRoot), false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("multi-root onboarding counts a readable root with no activity directories as available and empty", async () => {
  const files = await fixture();
  const emptyCodexHome = join(files.root, "new-profile", ".codex");
  await mkdir(emptyCodexHome, { recursive: true, mode: 0o700 });
  await writeFile(
    join(files.codexHome, "sessions", "rollout-current.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHomes: [files.codexHome, emptyCodexHome],
      stateRoot: files.stateRoot,
    });
    assert.equal(onboarding.status, "ready");
    assert.deepEqual(onboarding.source, {
      status: "ready",
      availability: "ready",
      configuredRoots: 2,
      availableRoots: 2,
      emptyRoots: 1,
      unavailableRoots: 0,
      sessionsReadable: true,
      archivedSessionsReadable: true,
      rolloutFilesPresent: true,
      rolloutFilesObserved: 1,
      rolloutFilesObservedCapped: false,
    });
    const serialized = JSON.stringify(onboarding);
    assert.equal(serialized.includes(files.codexHome), false);
    assert.equal(serialized.includes(emptyCodexHome), false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("multi-root onboarding does not call an empty plus unavailable source ready", async () => {
  const files = await fixture();
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHomes: [
        files.codexHome,
        join(files.root, "unavailable-profile", ".codex"),
      ],
      stateRoot: files.stateRoot,
    });
    assert.equal(onboarding.status, "needs_attention");
    assert.equal(onboarding.source.status, "no_rollout_files");
    assert.equal(onboarding.source.availability, "partial");
    assert.equal(onboarding.source.emptyRoots, 1);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("multi-root onboarding reports all roots unavailable without exposing their identities", async () => {
  const files = await fixture();
  await rm(files.codexHome, { recursive: true });
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  const roots = [
    files.codexHome,
    join(files.root, "second-missing-profile", ".codex"),
  ];
  try {
    const onboarding = await inspectLocalOnboarding({
      codexHomes: roots,
      stateRoot: files.stateRoot,
    });
    assert.equal(onboarding.status, "needs_attention");
    assert.equal(onboarding.source.availability, "unavailable");
    assert.equal(onboarding.source.configuredRoots, 2);
    assert.equal(onboarding.source.availableRoots, 0);
    assert.equal(onboarding.source.emptyRoots, 0);
    assert.equal(onboarding.source.unavailableRoots, 2);
    const serialized = JSON.stringify(onboarding);
    for (const root of roots) assert.equal(serialized.includes(root), false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("onboarding fails closed for unreadable source/state and hostile provider data", async () => {
  const files = await fixture();
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    if (process.platform !== "win32"
        && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
      await chmod(join(files.codexHome, "archived_sessions"), 0o000);
      await chmod(files.stateRoot, 0o500);
      const onboarding = await inspectLocalOnboarding({
        codexHome: files.codexHome,
        stateRoot: files.stateRoot,
      });
      assert.equal(onboarding.status, "needs_attention");
      assert.equal(onboarding.source.archivedSessionsReadable, false);
      assert.equal(onboarding.state.writable, false);
      await chmod(join(files.codexHome, "archived_sessions"), 0o700);
      await chmod(files.stateRoot, 0o700);
    }

    assert.deepEqual(projectLocalOnboarding({
      schemaVersion: "attacker-schema",
      status: "ready",
      source: {
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: Number.MAX_SAFE_INTEGER,
        path: files.codexHome,
        filename: "private-rollout.jsonl",
      },
      state: {
        writable: true,
        path: files.stateRoot,
      },
      capabilities: {
        explicitRefresh: true,
        rawContentExposed: true,
        arbitraryPathAccess: true,
        accountId: "private-account",
      },
    }), {
      schemaVersion: LOCAL_ONBOARDING_SCHEMA_VERSION,
      status: "needs_attention",
      source: {
        status: "codex_home_unreadable",
        availability: "unavailable",
        configuredRoots: 1,
        availableRoots: 0,
        emptyRoots: 0,
        unavailableRoots: 1,
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: MAXIMUM_OBSERVED_ROLLOUT_FILES,
        rolloutFilesObservedCapped: true,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
  } finally {
    await chmod(join(files.codexHome, "archived_sessions"), 0o700)
      .catch(() => {});
    await chmod(files.stateRoot, 0o700).catch(() => {});
    await rm(files.root, { recursive: true });
  }
});

test("onboarding distinguishes a missing Codex home from no recorded tasks", async () => {
  const files = await fixture();
  prepareLocalInstallationRoots({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
  });
  try {
    await rm(files.codexHome, { recursive: true });
    const missing = await inspectLocalOnboarding({
      codexHome: files.codexHome,
      stateRoot: files.stateRoot,
      customCodexHomeConfigured: true,
    });
    assert.equal(missing.status, "needs_attention");
    assert.equal(missing.source.status, "codex_home_missing");
    assert.equal(missing.capabilities.customCodexHomeConfigured, true);

    await mkdir(join(files.codexHome, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const empty = await inspectLocalOnboarding({
      codexHome: files.codexHome,
      stateRoot: files.stateRoot,
    });
    assert.equal(empty.status, "needs_attention");
    assert.equal(empty.source.status, "no_rollout_files");
    assert.equal(empty.source.rolloutFilesPresent, false);
    assert.equal(empty.source.rolloutFilesObservedCapped, false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});
