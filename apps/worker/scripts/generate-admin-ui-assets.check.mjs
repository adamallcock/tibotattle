import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ADMIN_UI_GENERATED_FILE,
  ADMIN_UI_SOURCES,
  buildAdminUiModule,
} from "./generate-admin-ui-assets.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-admin-modules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const { file } of ADMIN_UI_SOURCES) {
    await writeFile(join(directory, file), file === "admin.html"
      ? '<script type="module" src="./admin.js"></script>\n'
      : "");
  }
  return directory;
}

test("the canonical embedded admin graph is current and includes its private telemetry dependency", async () => {
  const generated = await buildAdminUiModule();
  assert.equal(generated, await readFile(ADMIN_UI_GENERATED_FILE, "utf8"));
  assert.deepEqual(ADMIN_UI_SOURCES.map(({ route }) => route), [
    "/admin.html", "/admin.css", "/admin.js", "/admin-client.js",
    "/telemetry-shared.generated.js",
  ]);
  assert.ok(generated.includes('["/telemetry-shared.generated.js"]'));
  assert.ok(generated.includes("ADMIN_MODEL_CONFIG"));
});

test("the generator traverses shared modules, re-exports, literal dynamic imports and cycles without executing them", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "admin.js"), [
    'import "./admin-client.js";',
    'export { value } from "./ui-format.js";',
    'void import("./community-view.js");',
    'throw new Error("never execute this fixture");',
  ].join("\n"));
  await writeFile(join(directory, "admin-client.js"), 'import "./telemetry-shared.generated.js";');
  await writeFile(join(directory, "ui-format.js"), 'import "./admin.js"; export const value = true;');
  await writeFile(join(directory, "community-view.js"), 'export * from "./community-data.js";');
  await writeFile(join(directory, "community-data.js"), "export const data = true;");
  await buildAdminUiModule({ webPublicDirectory: directory });
  await writeFile(join(directory, "community-data.js"), 'export * from "./missing.js";');
  await assert.rejects(
    buildAdminUiModule({ webPublicDirectory: directory }),
    /not in the hosted asset allowlists: missing\.js/u,
  );
});

test("the generator refuses missing transitive sources and unreviewed or computed module edges", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "admin.js"), 'import "./ui-format.js";');
  await assert.rejects(buildAdminUiModule({ webPublicDirectory: directory }), { code: "ENOENT" });
  for (const source of [
    'import "./missing.js";',
    'export * from "./missing.js";',
    'void import("./missing.js");',
    'void import(variable);',
    'import "https://example.invalid/foreign.js";',
    'import "../outside.js";',
    'import "package";',
    'import "./admin-client.js?unexpected";',
  ]) {
    await writeFile(join(directory, "admin.js"), source);
    await assert.rejects(buildAdminUiModule({ webPublicDirectory: directory }),
      /unsupported dependency|not in the hosted asset allowlists/u);
  }
  await writeFile(join(directory, "admin.js"), [
    '// import "./missing.js";',
    'const text = \'import "./missing.js";\';',
    "const url = import.meta.url;",
  ].join("\n"));
  await buildAdminUiModule({ webPublicDirectory: directory });
});

test("new HTML module entrypoints cannot bypass the hosted module allowlists", async (t) => {
  const directory = await fixture(t);
  for (const source of [
    '<script type="module" src="./missing.js"></script>',
    '<script type="module">import "./missing.js";</script>',
    '<script src="./admin.js"></script>',
    '<script type="module" data-src="./admin.js"></script>',
    '<script type="module" src="./admin.js">',
  ]) {
    await writeFile(join(directory, "admin.html"), source);
    await assert.rejects(buildAdminUiModule({ webPublicDirectory: directory }),
      /unsupported module entrypoint/u);
  }
  await writeFile(join(directory, "admin.html"), "<!doctype html>");
  await assert.rejects(buildAdminUiModule({ webPublicDirectory: directory }),
    /does not load the admin module entrypoint/u);
});
