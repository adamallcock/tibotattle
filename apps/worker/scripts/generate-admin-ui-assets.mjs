#!/usr/bin/env node
/**
 * Mirrors the owner-only admin UI sources into the Worker bundle.
 *
 * The public release site deliberately excludes admin.html/admin.js — the
 * public origin must keep returning 404 for them — so the Worker embeds its
 * own copy and serves it only on the Cloudflare Access protected admin
 * hostname. The dashboard sources in apps/web/public stay canonical; this
 * script projects them into src/admin-ui.generated.ts, and `--check` makes
 * the projection a fail-closed gate against silent drift.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKER_DIRECTORY = dirname(dirname(SCRIPT_FILE));
const WEB_PUBLIC_DIRECTORY = join(
  dirname(dirname(WORKER_DIRECTORY)),
  "apps",
  "web",
  "public",
);
export const ADMIN_UI_GENERATED_FILE = join(
  WORKER_DIRECTORY,
  "src",
  "admin-ui.generated.ts",
);

// The embedded set is exactly the admin-only module graph. Shared public
// modules the admin page imports at runtime stay in the ordinary
// asset directory on both hostnames. This lets the admin dashboard render the
// exact public community graph without embedding or duplicating it here.
export const ADMIN_UI_SOURCES = Object.freeze([
  Object.freeze({
    route: "/admin.html",
    file: "admin.html",
    contentType: "text/html; charset=utf-8",
  }),
  Object.freeze({
    route: "/admin.css",
    file: "admin.css",
    contentType: "text/css; charset=utf-8",
  }),
  Object.freeze({
    route: "/admin.js",
    file: "admin.js",
    contentType: "text/javascript; charset=utf-8",
  }),
  Object.freeze({
    route: "/admin-client.js",
    file: "admin-client.js",
    contentType: "text/javascript; charset=utf-8",
  }),
  Object.freeze({
    route: "/telemetry-shared.generated.js",
    file: "telemetry-shared.generated.js",
    contentType: "text/javascript; charset=utf-8",
  }),
]);

// This reviewed allowlist is not permission to publish additional files. The
// public release builder owns that separate surface. Production staging must
// prove these shared dependencies actually exist in its selected public tree.
export const ADMIN_UI_SHARED_SOURCES = Object.freeze([
  "styles.css",
  "ui-format.js",
  "localization.js",
  "i18n.generated.js",
  "community-data.js",
  "community-view.js",
]);

async function verifyModuleClosure(contents, webPublicDirectory) {
  // Reuse the repository's syntax parser, rather than a regex that misses
  // re-exports, multiline syntax or dynamic imports. Only build/check mode
  // loads it; deployment's allowlist import needs no root tooling packages.
  const { extractEsmImports } = await import("../../../scripts/lib/esm-imports.mjs");
  const allowed = new Set([
    ...ADMIN_UI_SOURCES.map(({ file }) => file),
    ...ADMIN_UI_SHARED_SOURCES,
  ]);
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const content = contents.get(file)
      ?? await readFile(join(webPublicDirectory, file), "utf8");
    for (const edge of await extractEsmImports(content, { sourceName: file })) {
      // The hosted graph uses flat relative modules only. Do not silently
      // follow network, package, traversing or computed module specifiers.
      if (typeof edge.specifier !== "string"
          || !/^\.\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.js$/u.test(edge.specifier)) {
        throw new Error(`Admin UI module has an unsupported dependency: ${file}:${edge.line}`);
      }
      const dependency = edge.specifier.slice(2);
      if (!allowed.has(dependency)) {
        throw new Error(`Admin UI dependency is not in the hosted asset allowlists: ${dependency}`);
      }
      await visit(dependency);
    }
  }
  // Validate every embedded module, even if an entrypoint temporarily stops
  // referencing one. Cycles are harmless; missing transitive modules are not.
  for (const { file } of ADMIN_UI_SOURCES) {
    if (file.endsWith(".js")) await visit(file);
  }
  const html = contents.get("admin.html").replace(/<!--[\s\S]*?-->/gu, "");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
  const entries = new Set();
  if (scripts.length !== [...html.matchAll(/<script\b/giu)].length) {
    throw new Error("Admin UI HTML has an unsupported module entrypoint");
  }
  for (const [, attributes, body] of scripts) {
    const source = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
    if (!/(?:^|\s)type\s*=\s*(["'])module\1/iu.test(attributes)
        || body.trim() !== ""
        || typeof source !== "string"
        || !/^\.\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.js$/u.test(source)
        || !allowed.has(source.slice(2))) {
      throw new Error("Admin UI HTML has an unsupported module entrypoint");
    }
    entries.add(source);
    await visit(source.slice(2));
  }
  if (!entries.has("./admin.js")) {
    throw new Error("Admin UI HTML does not load the admin module entrypoint");
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function buildAdminUiModule({
  webPublicDirectory = WEB_PUBLIC_DIRECTORY,
} = {}) {
  const entries = [];
  const digestInput = [];
  const contents = new Map();
  for (const source of ADMIN_UI_SOURCES) {
    const content = await readFile(
      join(webPublicDirectory, source.file),
      "utf8",
    );
    contents.set(source.file, content);
    digestInput.push(`${source.route}\0${content}`);
    entries.push(
      "  [" + JSON.stringify(source.route) + "]: Object.freeze({\n"
        + `    contentType: ${JSON.stringify(source.contentType)},\n`
        + `    content: ${JSON.stringify(content)},\n`
        + "  }),",
    );
  }
  await verifyModuleClosure(contents, webPublicDirectory);
  const digest = sha256Hex(digestInput.join("\0"));
  return "// @generated by scripts/generate-admin-ui-assets.mjs\n"
    + "// Do not edit: the canonical admin UI sources live in apps/web/public.\n"
    + `// Canonical SHA-256: ${digest}\n`
    + "\n"
    + "export interface AdminUiAsset {\n"
    + "  readonly contentType: string;\n"
    + "  readonly content: string;\n"
    + "}\n"
    + "\n"
    + "export const ADMIN_UI_ASSETS: Readonly<Record<string, AdminUiAsset>> ="
    + " Object.freeze({\n"
    + entries.join("\n")
    + "\n});\n";
}

export async function checkAdminUiModule() {
  const expected = await buildAdminUiModule();
  let actual;
  try {
    actual = await readFile(ADMIN_UI_GENERATED_FILE, "utf8");
  } catch {
    return false;
  }
  return actual === expected;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  if (args.some((argument) => argument !== "--check")) {
    process.stderr.write(
      "Usage: generate-admin-ui-assets.mjs [--check]\n",
    );
    process.exit(2);
  }
  if (check) {
    if (await checkAdminUiModule()) {
      process.stdout.write("admin UI worker mirror is current\n");
      return;
    }
    process.stderr.write(
      "admin UI worker mirror is stale; run "
        + "node ./scripts/generate-admin-ui-assets.mjs\n",
    );
    process.exit(1);
  }
  await writeFile(ADMIN_UI_GENERATED_FILE, await buildAdminUiModule());
  process.stdout.write(`wrote ${ADMIN_UI_GENERATED_FILE}\n`);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
