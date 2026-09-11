import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyDesktopSharingInstallation,
  DESKTOP_SHARING_INSTALLATION_STATES,
} from "../desktop-sharing-installation.js";

const {
  FRESH,
  EXISTING_UNSELECTED,
  EXISTING,
  UNKNOWN,
} = DESKTOP_SHARING_INSTALLATION_STATES;

function notFound() {
  const error = new Error("missing");
  error.code = "ENOENT";
  return error;
}

function metadata(kind = "file", extras = {}) {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
    ...extras,
  };
}

function mappedInspector(entries = new Map()) {
  const calls = [];
  return {
    calls,
    async inspectPath(path) {
      calls.push(path);
      const value = entries.get(path);
      if (value instanceof Error) throw value;
      if (value === undefined) throw notFound();
      return value;
    },
  };
}

async function disposableRoots(callback) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-sharing-installation-"));
  const roots = {
    parent,
    profileRoot: join(parent, "profile"),
    stateRoot: join(parent, "state"),
    legacyStateRoot: join(parent, "legacy-state"),
  };
  await mkdir(roots.profileRoot, { recursive: true });
  await mkdir(roots.stateRoot, { recursive: true });
  try {
    return await callback(roots);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("an empty Electron-created profile is fresh when legacy roots are absent", async () => {
  await disposableRoots(async ({ profileRoot, stateRoot, legacyStateRoot }) => {
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot,
        legacyStateRoots: [legacyStateRoot],
      }),
      FRESH,
    );
  });
});

test("a managed marker without a sharing record is existing_unselected", async () => {
  await disposableRoots(async ({ profileRoot, stateRoot }) => {
    await mkdir(join(profileRoot, "desktop-settings"), { recursive: true });
    await writeFile(join(profileRoot, "desktop-settings", "desktop-first-run-v1.json"), "opaque\n");
    assert.equal(
      await classifyDesktopSharingInstallation({ profileRoot, stateRoot }),
      EXISTING_UNSELECTED,
    );
  });
});

test("sharing markers are existing without reading their contents", async () => {
  await disposableRoots(async ({ profileRoot, stateRoot }) => {
    await mkdir(join(profileRoot, "desktop-settings"), { recursive: true });
    await writeFile(join(profileRoot, "desktop-settings", "accountless-sharing-v1.json"), "not-json\n");
    assert.equal(
      await classifyDesktopSharingInstallation({ profileRoot, stateRoot }),
      EXISTING,
    );
  });
});

test("an existing empty legacy root is conservative and contribution state is existing", async () => {
  await disposableRoots(async ({ profileRoot, stateRoot, legacyStateRoot }) => {
    await mkdir(legacyStateRoot, { recursive: true });
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot,
        legacyStateRoots: [legacyStateRoot],
      }),
      EXISTING_UNSELECTED,
    );

    await mkdir(join(legacyStateRoot, "private"), { recursive: true });
    await writeFile(
      join(legacyStateRoot, "private", "automatic-contribution-v0.1.json"),
      "opaque\n",
    );
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot,
        legacyStateRoots: [legacyStateRoot],
      }),
      EXISTING,
    );
  });
});

test("only the fixed marker paths are inspected", async () => {
  const profileRoot = "/synthetic/profile";
  const stateRoot = "/synthetic/state";
  const legacyStateRoot = "/synthetic/legacy";
  const inspector = mappedInspector(new Map([
    [profileRoot, metadata("directory")],
    [join(profileRoot, "desktop-settings"), metadata("directory")],
    [stateRoot, metadata("directory")],
    [join(stateRoot, "private"), metadata("directory")],
    [legacyStateRoot, metadata("directory")],
    [join(legacyStateRoot, "private"), metadata("directory")],
  ]));
  assert.equal(
    await classifyDesktopSharingInstallation({
      profileRoot,
      stateRoot,
      legacyStateRoots: [legacyStateRoot],
      inspectPath: inspector.inspectPath,
    }),
    EXISTING_UNSELECTED,
  );
  assert.deepEqual(inspector.calls, [
    profileRoot,
    join(profileRoot, "desktop-settings"),
    join(profileRoot, "desktop-settings", "desktop-first-run-v1.json"),
    join(profileRoot, "desktop-settings", "desktop-settings-v1.json"),
    join(profileRoot, "desktop-settings", "accountless-sharing-v1.json"),
    stateRoot,
    join(stateRoot, "local-unified-index-v1.sqlite"),
    join(stateRoot, "local-collector-state-v1.sqlite"),
    join(stateRoot, "private"),
    join(stateRoot, "private", "automatic-contribution-v0.1.json"),
    join(stateRoot, "private", "incremental-contribution-sync-v1.json"),
    legacyStateRoot,
    join(legacyStateRoot, "local-unified-index-v1.sqlite"),
    join(legacyStateRoot, "local-collector-state-v1.sqlite"),
    join(legacyStateRoot, "private"),
    join(legacyStateRoot, "private", "automatic-contribution-v0.1.json"),
    join(legacyStateRoot, "private", "incremental-contribution-sync-v1.json"),
  ]);
});

test("non-ENOENT inspection errors fail closed", async () => {
  const profileRoot = "/synthetic/profile";
  const firstMarker = join(profileRoot, "desktop-settings", "desktop-first-run-v1.json");
  const error = new Error("permission denied");
  error.code = "EACCES";
  const inspector = mappedInspector(new Map([
    [profileRoot, metadata("directory")],
    [join(profileRoot, "desktop-settings"), metadata("directory")],
    [firstMarker, error],
  ]));
  assert.equal(
    await classifyDesktopSharingInstallation({
      profileRoot,
      stateRoot: "/synthetic/state",
      inspectPath: inspector.inspectPath,
    }),
    UNKNOWN,
  );
});

test("symlinks, unexpected types, and foreign owners fail closed", async (t) => {
  await t.test("symlink marker", async () => {
    await disposableRoots(async ({ profileRoot, stateRoot }) => {
      const settingsRoot = join(profileRoot, "desktop-settings");
      await mkdir(settingsRoot, { recursive: true });
      const target = join(settingsRoot, "target.json");
      await writeFile(target, "opaque\n");
      await symlink(target, join(settingsRoot, "desktop-settings-v1.json"));
      assert.equal(
        await classifyDesktopSharingInstallation({ profileRoot, stateRoot }),
        UNKNOWN,
      );
    });
  });

  await t.test("unexpected file type", async () => {
    const profileRoot = "/synthetic/profile";
    const firstMarker = join(profileRoot, "desktop-settings", "desktop-first-run-v1.json");
    const inspector = mappedInspector(new Map([
      [profileRoot, metadata("directory")],
      [join(profileRoot, "desktop-settings"), metadata("directory")],
      [firstMarker, metadata("directory")],
    ]));
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot: "/synthetic/state",
        inspectPath: inspector.inspectPath,
      }),
      UNKNOWN,
    );
  });

  await t.test("unsafe fixed ancestor", async () => {
    const profileRoot = "/synthetic/profile";
    const settingsRoot = join(profileRoot, "desktop-settings");
    const inspector = mappedInspector(new Map([
      [profileRoot, metadata("directory")],
      [settingsRoot, metadata("symlink")],
    ]));
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot: "/synthetic/state",
        inspectPath: inspector.inspectPath,
      }),
      UNKNOWN,
    );
  });

  await t.test("unsafe state root and private ancestors", async () => {
    const profileRoot = "/synthetic/profile";
    const stateRoot = "/synthetic/state";
    const profileSettings = join(profileRoot, "desktop-settings");
    const privatePath = join(stateRoot, "private");
    const baseEntries = [
      [profileRoot, metadata("directory")],
      [profileSettings, metadata("directory")],
      [stateRoot, metadata("directory")],
    ];
    const unsafeAncestors = [
      [stateRoot, metadata("symlink")],
      [privatePath, metadata("symlink")],
    ];
    if (typeof process.getuid === "function") {
      unsafeAncestors.push([
        privatePath,
        metadata("directory", { uid: process.getuid() + 1 }),
      ]);
    }
    for (const [path, value] of unsafeAncestors) {
      const entries = new Map(baseEntries);
      entries.set(path, value);
      const inspector = mappedInspector(entries);
      assert.equal(
        await classifyDesktopSharingInstallation({
          profileRoot,
          stateRoot,
          inspectPath: inspector.inspectPath,
        }),
        UNKNOWN,
      );
    }
  });

  if (typeof process.getuid !== "function") return;
  await t.test("foreign owner", async () => {
    const profileRoot = "/synthetic/profile";
    const firstMarker = join(profileRoot, "desktop-settings", "desktop-first-run-v1.json");
    const inspector = mappedInspector(new Map([
      [profileRoot, metadata("directory")],
      [join(profileRoot, "desktop-settings"), metadata("directory")],
      [firstMarker, metadata("file", { uid: process.getuid() + 1 })],
    ]));
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot: "/synthetic/state",
        inspectPath: inspector.inspectPath,
      }),
      UNKNOWN,
    );
  });

  await t.test("foreign fixed ancestor owner", async () => {
    const profileRoot = "/synthetic/profile";
    const foreignUid = process.getuid() + 1;
    const inspector = mappedInspector(new Map([
      [profileRoot, metadata("directory", { uid: foreignUid })],
    ]));
    assert.equal(
      await classifyDesktopSharingInstallation({
        profileRoot,
        stateRoot: "/synthetic/state",
        inspectPath: inspector.inspectPath,
      }),
      UNKNOWN,
    );
  });
});

test("invalid classifier options fail closed", async () => {
  assert.equal(await classifyDesktopSharingInstallation(), UNKNOWN);
  assert.equal(
    await classifyDesktopSharingInstallation({
      profileRoot: "/synthetic/profile",
      stateRoot: "/synthetic/state",
      legacyStateRoots: [""],
    }),
    UNKNOWN,
  );
});
