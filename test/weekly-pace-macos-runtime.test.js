import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_QUOTA_ANALYSIS_FILES,
  collectWebModuleGraph,
} from "../scripts/lib/runtime-closure.mjs";
import { MACOS_RUNTIME_STATIC_ASSETS } from "../scripts/build-macos-app.js";
import {
  CLIENT_RUNTIME_FILES,
  CLIENT_PACKAGE_FILES,
  CLIENT_WEB_FILES,
} from "../scripts/export-tibotattle.mjs";

test("pace analysis ships in both the macOS bundle and client export", () => {
  assert.equal(
    RUNTIME_QUOTA_ANALYSIS_FILES.includes("src/quota-pace-forecast.js"),
    true,
  );
  assert.equal(
    CLIENT_PACKAGE_FILES.includes(
      "packages/quota-analysis/src/quota-pace-forecast.js",
    ),
    true,
  );
  assert.equal(
    CLIENT_RUNTIME_FILES.includes("src/weekly-pace-projection.js"),
    true,
  );
});


test("animated allowance modules ship through the desktop graph and client export", async () => {
  const graph = await collectWebModuleGraph();
  for (const file of ["allowance-tanks.js", "allowance-tank-renderer.js"]) {
    const path = `apps/web/public/${file}`;
    assert.ok(CLIENT_WEB_FILES.includes(path));
    assert.ok(graph.modules.some(module => module.relativeFile === path));
  }
});


test("Codex tank logo ships in the desktop assets and client export", () => {
  const asset = "apps/web/public/codex-color.svg";
  assert.ok(MACOS_RUNTIME_STATIC_ASSETS.includes(asset));
  assert.ok(CLIENT_WEB_FILES.includes(asset));
});
