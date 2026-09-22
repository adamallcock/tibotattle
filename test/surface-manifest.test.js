import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_COMPANION_STATIC_FILES,
} from "../apps/local/static-assets.js";
import {
  CLIENT_SOURCE_FILES,
  CLIENT_WEB_FILES,
} from "../scripts/export-tibotattle.mjs";
import {
  collectWebModuleGraph,
} from "../scripts/lib/runtime-closure.mjs";
import { MACOS_RUNTIME_STATIC_ASSETS } from "../scripts/build-macos-app.js";
import {
  assertSurfaceManifest,
  assertSurfaceProjection,
  surfaceFiles,
} from "../scripts/lib/surface-manifest.mjs";

const SURFACES = [
  "electron-runtime",
  "history-free-export",
  "local-companion",
  "native-macos",
];

function reviewedManifest() {
  return {
    schemaVersion: "tibotattle-surface-manifest-v0.1",
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [surface, [...surfaceFiles(surface)]]),
    ),
  };
}

function localCompanionFiles() {
  return Object.values(LOCAL_COMPANION_STATIC_FILES).map(({ file }) =>
    `apps/web/public/${file}`);
}

test("surface projections preserve exact local, Electron, native, and export inventories", async () => {
  const localFiles = localCompanionFiles();
  assertSurfaceProjection("local-companion", localFiles, {
    label: "local companion route-file projection",
  });
  assert.deepEqual(
    [...new Set(localFiles)].sort(),
    [...surfaceFiles("electron-runtime")].sort(),
  );
  assert.deepEqual(
    [...CLIENT_WEB_FILES].sort(),
    [...surfaceFiles("history-free-export")].sort(),
  );

  const webGraph = await collectWebModuleGraph({ surface: "native-macos" });
  const nativeFiles = [
    ...MACOS_RUNTIME_STATIC_ASSETS,
    ...webGraph.relativeFiles,
  ];
  assertSurfaceProjection("native-macos", nativeFiles, {
    label: "native macOS runtime-file projection",
  });

  // Route behavior remains a separate contract: the two historical routes are
  // intentional aliases of one declared source file.
  assert.equal(
    LOCAL_COMPANION_STATIC_FILES["/"].file,
    LOCAL_COMPANION_STATIC_FILES["/index.html"].file,
  );
  assert.equal(
    CLIENT_SOURCE_FILES.includes("apps/electron/desktop-copy-source.js"),
    false,
  );
  assert.equal(
    CLIENT_SOURCE_FILES.includes("scripts/generate-i18n-electron-copy.js"),
    false,
  );
  for (const surface of SURFACES) {
    assert.equal(
      surfaceFiles(surface).includes("apps/electron/desktop-copy-source.js"),
      false,
      `${surface} must not stage Electron localization ownership input`,
    );
    assert.equal(
      surfaceFiles(surface).includes("scripts/generate-i18n-electron-copy.js"),
      false,
      `${surface} must not stage the Electron localization generator`,
    );
  }
});

test("surface projection validation rejects unknown paths and globs", () => {
  assert.throws(
    () => surfaceFiles("unknown-surface"),
    { code: "SURFACE_MANIFEST_INVALID" },
  );
  assert.throws(
    () => assertSurfaceProjection(
      "local-companion",
      [...surfaceFiles("local-companion"), "apps/web/public/new/*.js"],
    ),
    { code: "SURFACE_MANIFEST_INVALID" },
  );
});

test("surface manifest validation rejects policy expansion and unsafe membership", () => {
  assert.equal(assertSurfaceManifest(reviewedManifest()), true);

  const extraSurface = reviewedManifest();
  extraSurface.surfaces["unreviewed-surface"] = ["apps/web/public/app.js"];

  const duplicatePath = reviewedManifest();
  duplicatePath.surfaces["local-companion"].push(
    duplicatePath.surfaces["local-companion"][0],
  );

  const traversal = reviewedManifest();
  traversal.surfaces["local-companion"][0] = "apps/web/../private.js";

  const absolute = reviewedManifest();
  absolute.surfaces["local-companion"][0] = "/apps/web/public/app.js";

  const emptyProjection = reviewedManifest();
  emptyProjection.surfaces["local-companion"] = [];

  for (const manifest of [
    extraSurface,
    duplicatePath,
    traversal,
    absolute,
    emptyProjection,
  ]) {
    assert.throws(
      () => assertSurfaceManifest(manifest),
      { code: "SURFACE_MANIFEST_INVALID" },
    );
  }
});
