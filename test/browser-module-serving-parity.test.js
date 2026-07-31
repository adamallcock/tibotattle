import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_COMPANION_STATIC_FILES,
} from "../apps/local/static-assets.js";
import {
  collectMacOSWebModuleGraph,
} from "../scripts/build-macos-app.js";

test("every transitive browser module is served by loopback and every served module is in the closure", async () => {
  const discovered = await collectMacOSWebModuleGraph();
  const servedModules = Object.entries(LOCAL_COMPANION_STATIC_FILES)
    .filter(([, { file }]) => /\.(?:m?js)$/u.test(file))
    .map(([route, { file, type }]) => ({
      file: `apps/web/public/${file}`,
      route,
      type,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));

  assert.deepEqual(
    servedModules.map(({ file }) => file),
    discovered.relativeFiles,
  );
  for (const { file, route, type } of servedModules) {
    assert.equal(
      route,
      `/${file.slice("apps/web/public/".length)}`,
      `${file} must be served at its relative module URL`,
    );
    assert.equal(type, "text/javascript; charset=utf-8");
  }
});
