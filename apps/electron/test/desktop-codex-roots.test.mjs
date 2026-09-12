import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_CODEX_ROOT_MAX,
  DESKTOP_DEFAULT_CODEX_ROOT_ID,
  addCodexHomeToConfiguration,
  createDefaultCodexHomes,
  editCodexHomeInConfiguration,
  isAbsoluteCodexPath,
  isValidCodexRootId,
  migrateLegacyCodexHome,
  normalizeCodexHomes,
  normalizeCodexPathForComparison,
  projectCodexHomesForSettings,
  projectCodexHomesPathFree,
  removeCodexHomeFromConfiguration,
  reorderCodexHomesConfiguration,
  setPrimaryCodexHomeInConfiguration,
} from "../desktop-codex-roots.js";

const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";
const ROOT_C = "33333333-3333-4333-8333-333333333333";

function custom(rootId, path) {
  return { rootId, kind: "custom", path, enabled: true };
}

function configuration(roots = [custom(ROOT_A, "/Users/test/.codex")], primaryRootId = roots[0].rootId) {
  return normalizeCodexHomes({ activityRoots: roots, primaryRootId });
}

test("default root is a single immutable sentinel", () => {
  const defaults = createDefaultCodexHomes();
  assert.deepEqual(defaults, {
    activityRoots: [{
      rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
      kind: "default",
      path: null,
      enabled: true,
    }],
    primaryRootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
  });
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(defaults.activityRoots), true);
  assert.equal(Object.isFrozen(defaults.activityRoots[0]), true);
});

test("root IDs are canonical UUIDs and path grammar is cross-platform", () => {
  for (const value of [ROOT_A, ROOT_B, DESKTOP_DEFAULT_CODEX_ROOT_ID]) {
    assert.equal(isValidCodexRootId(value), true);
  }
  for (const value of [
    "root-a",
    "11111111-1111-5111-8111-111111111111",
    "11111111-1111-4111-7111-111111111111",
    "11111111-1111-4111-8111-11111111111",
    "11111111-1111-4111-8111-111111111111 ",
  ]) {
    assert.equal(isValidCodexRootId(value), false, value);
  }
  for (const value of [
    "/Users/test/.codex",
    "C:\\Users\\test\\.codex",
    "\\\\server\\share",
    "\\\\wsl$\\Ubuntu\\home\\adam\\.codex",
    "\\\\?\\C:\\Users\\test\\.codex",
    "\\\\?\\UNC\\server\\share\\.codex",
  ]) {
    assert.equal(isAbsoluteCodexPath(value), true, value);
  }
  for (const value of [
    "",
    "relative/.codex",
    "\\\\",
    "\\\\server",
    "\\\\?\\UNC\\server",
    "C:relative",
    "/bad\0path",
    `/long/${"x".repeat(4_100)}`,
  ]) {
    assert.equal(isAbsoluteCodexPath(value), false, value);
  }
  assert.equal(
    normalizeCodexPathForComparison("C:/Users/test/.codex\\"),
    "c:\\users\\test\\.codex",
  );
  assert.equal(
    normalizeCodexPathForComparison("\\\\server\\share\\"),
    normalizeCodexPathForComparison("\\\\SERVER\\SHARE"),
  );
});

test("normalization bounds roots, preserves missing paths, and rejects aliases", () => {
  const missing = configuration([custom(ROOT_A, "/detached/.codex")]);
  assert.equal(missing.activityRoots[0].path, "/detached/.codex");

  assert.throws(
    () => configuration([custom(ROOT_A, "/same"), custom(ROOT_B, "/same/")]),
    /paths must be unique/u,
  );
  assert.throws(
    () => configuration([custom(ROOT_A, "/same"), custom(ROOT_A, "/other")]),
    /IDs must be unique/u,
  );
  assert.throws(
    () => configuration([
      { rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID, kind: "default", path: null, enabled: true },
      { rootId: "44444444-4444-4444-8444-444444444444", kind: "default", path: null, enabled: true },
    ]),
    /default activity root\.rootId is invalid/u,
  );
  assert.throws(
    () => configuration(Array.from({ length: DESKTOP_CODEX_ROOT_MAX + 1 }, (_, index) => custom(
      `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
      `/root/${index}`,
    ))),
    /one to eight roots/u,
  );
});

test("add/edit/primary/reorder/remove operations preserve invariants", () => {
  const initial = configuration();
  const added = addCodexHomeToConfiguration(initial, {
    path: "C:\\Users\\test\\secondary",
    idFactory: () => ROOT_B,
  });
  assert.deepEqual(added.activityRoots.map((root) => root.rootId), [ROOT_A, ROOT_B]);
  assert.equal(added.primaryRootId, ROOT_A);

  const edited = editCodexHomeInConfiguration(added, {
    rootId: ROOT_B,
    path: "/Users/test/secondary-edited",
  });
  assert.equal(edited.activityRoots[1].rootId, ROOT_B);
  assert.equal(edited.activityRoots[1].path, "/Users/test/secondary-edited");

  const primary = setPrimaryCodexHomeInConfiguration(edited, { rootId: ROOT_B });
  assert.equal(primary.primaryRootId, ROOT_B);
  const reordered = reorderCodexHomesConfiguration(primary, { rootIds: [ROOT_B, ROOT_A] });
  assert.deepEqual(reordered.activityRoots.map((root) => root.rootId), [ROOT_B, ROOT_A]);
  assert.equal(reordered.primaryRootId, ROOT_B);

  const removed = removeCodexHomeFromConfiguration(reordered, { rootId: ROOT_A });
  assert.deepEqual(removed.activityRoots.map((root) => root.rootId), [ROOT_B]);
  assert.equal(removed.primaryRootId, ROOT_B);

  assert.throws(() => removeCodexHomeFromConfiguration(initial, { rootId: ROOT_A }), /retain one root/u);
  assert.throws(() => removeCodexHomeFromConfiguration(added, { rootId: ROOT_A }), /another primary/u);
  assert.throws(() => setPrimaryCodexHomeInConfiguration(added, { rootId: ROOT_C }), /configured root/u);
  assert.throws(() => reorderCodexHomesConfiguration(added, { rootIds: [ROOT_A, ROOT_A] }), /every configured/u);
  assert.throws(() => addCodexHomeToConfiguration(initial, {
    path: "/Users/test/.codex/",
    idFactory: () => ROOT_C,
  }), /paths must be unique/u);
  assert.throws(() => editCodexHomeInConfiguration(createDefaultCodexHomes(), {
    rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
    path: "/Users/test/custom",
  }), /default activity root cannot be edited/u);
});

test("path-free and settings projections are cloned and do not cross the boundary", () => {
  const current = configuration([
    custom(ROOT_A, "/Users/test/one"),
    custom(ROOT_B, "/Users/test/two"),
  ], ROOT_B);
  const pathFree = projectCodexHomesPathFree(current);
  assert.deepEqual(pathFree, {
    activityRoots: [
      { rootId: ROOT_A, kind: "custom", enabled: true },
      { rootId: ROOT_B, kind: "custom", enabled: true },
    ],
    primaryRootId: ROOT_B,
  });
  assert.equal(JSON.stringify(pathFree).includes("/Users"), false);
  assert.equal(Object.isFrozen(pathFree), true);
  assert.equal(Object.isFrozen(pathFree.activityRoots[0]), true);

  const settings = projectCodexHomesForSettings(current);
  assert.deepEqual(settings, current);
  assert.notEqual(settings, current);
  assert.notEqual(settings.activityRoots, current.activityRoots);
  assert.throws(() => { settings.activityRoots[0].path = "/changed"; }, TypeError);
});

test("legacy scalar and object values migrate deterministically with injected IDs", () => {
  assert.deepEqual(migrateLegacyCodexHome({ mode: "default", path: null }), createDefaultCodexHomes());
  const migratedScalar = migrateLegacyCodexHome("C:\\Users\\test\\.codex", {
    idFactory: () => ROOT_A,
  });
  assert.deepEqual(migratedScalar, {
    activityRoots: [custom(ROOT_A, "C:\\Users\\test\\.codex")],
    primaryRootId: ROOT_A,
  });
  const migratedObject = migrateLegacyCodexHome({ mode: "custom", path: "/Users/test/.codex" }, {
    idFactory: () => ROOT_B,
  });
  assert.equal(migratedObject.activityRoots[0].rootId, ROOT_B);
  assert.deepEqual(
    migrateLegacyCodexHome("C:\\Users\\test\\.codex"),
    migrateLegacyCodexHome("C:\\Users\\test\\.codex"),
  );
  assert.throws(
    () => migrateLegacyCodexHome({ mode: "custom", path: "relative" }, { idFactory: () => ROOT_C }),
    /path is invalid/u,
  );
  assert.throws(
    () => addCodexHomeToConfiguration(configuration(), {
      path: "/Users/test/other",
      idFactory: () => ROOT_A,
    }),
    /already in use/u,
  );
});
