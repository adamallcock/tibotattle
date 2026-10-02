#!/usr/bin/env node
// Vendors the production analytics kernels at a chosen production commit into
// vendor/analytics-<first 8 hex of the commit> so the GCP line runs exactly
// production's arithmetic, independently of its own src/ and workspace
// packages. The commit is an argument (`--commit=<40-hex>`) and defaults to
// d43c8f92, the revision vendored today.
//
// The closure is computed, not listed: esbuild bundles entry.ts (the reviewed
// facade), the website normalizer and the copied parity specs from a
// throwaway extraction of the commit, and its metafile names every runtime
// input. Each input is then written byte-for-byte from its git blob. The three
// workspace packages are vendored whole (package.json, index.js, index.d.ts and
// src/**). The only edits are the `export ` tokens that EXPORT_PATCHES adds.
// Type-only imports are erased by esbuild and are deliberately not vendored;
// for the few Worker modules that vendored files name only for types, tsc
// emits declaration stubs from the commit's sources so that tsc-checked
// consumers of entry.ts still typecheck.
//
// Export patches are located BY SYMBOL, never by line number. Each patch names
// a file, a symbol and the declaration kind ("function", "async function" or
// "const"). The locator masks comments, strings, templates and regex literals,
// then requires exactly one declaration of the symbol in the file, at column 0
// and of the named kind. A missing, ambiguous, nested, retyped or otherwise
// unsupported symbol refuses the run; a symbol the commit already exports is
// left alone and recorded. esbuild then confirms, as a parser would, that each
// patch adds exactly its own export and nothing else.
//
// Usage (from apps/worker):
//   node scripts/vendor-analytics-kernels.mjs [--commit=<40-hex>] [--out-root=<dir>]
//        [--authored-from=<vendor dir>]
//   node scripts/vendor-analytics-kernels.mjs --report [--commit=<40-hex>] [--reference=<MANIFEST.json>]
// `--out-root` writes vendor/ and analytics-v2-test/ under <dir> instead of
// apps/worker (a scratch dry run). `--authored-from` seeds a NEW vendor
// directory with the reviewed entry.ts and tsconfig.json from another one; it
// refuses when the target already holds them. `--report` writes nothing: it
// resolves every export patch at the commit and lists vendored files whose
// blobs differ from a reference manifest (default: the vendored d43c8f92).
// Verify with: node scripts/vendor-analytics-kernels.check.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The default and original vendored revision (what runs without `--commit`). */
export const SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
export const MANIFEST_SCHEMA = "analytics-kernel-vendor-manifest-v1";
export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = "MANIFEST.json";
/** Reviewed, hand-written files in the vendor directory (not from the vendored commit). */
export const AUTHORED_FILES = Object.freeze(["entry.ts", "tsconfig.json"]);
export const VENDORED_PACKAGES = Object.freeze(["accounting", "quota-analysis", "telemetry-contract"]);
/** Browser modules vendored so tests can read production output the way the site does. */
export const WEB_ROOTS = Object.freeze(["apps/web/public/community-data.js"]);
/** Production Worker specs copied as kernel-parity tests, imports rewritten to the vendor tree. */
export const PARITY_SPECS = Object.freeze([
  "analytics-shared-reducers.spec.ts",
  "effective-quota-day.spec.ts",
  "analytics-shared-input.spec.ts",
  "quota-analysis-v11-features.spec.ts",
  "v11-daily-projection-values.spec.ts",
  "admin-community-allowance.spec.ts",
  "public-allowance-breakdowns.spec.ts",
  "quota-endpoint-collapse.spec.ts",
  "quota-analysis-v1-shared-finish.spec.ts",
]);
export const PARITY_HELPERS = Object.freeze(["helpers/telemetry-v11.ts"]);
export const EXPORT_TOKEN = "export ";
/** Declaration kinds a patch may name. */
export const PATCH_DECLARATIONS = Object.freeze(["function", "async function", "const"]);

const WORKER_SRC = "apps/worker/src";
const WORKER_TEST = "apps/worker/test";
/** The commit's Worker ambient types; extracted only to emit type stubs, never vendored. */
const WORKER_TYPES = "apps/worker/worker-configuration.d.ts";
const PACKAGE_RULE = /^packages\/([a-z-]+)\/(package\.json|index\.js|index\.d\.ts|src\/.+)$/;

/**
 * The only edits to vendored bytes: `export ` is added at the start of the one
 * column-0 declaration of each symbol. Patches name a symbol and its
 * declaration kind, never a line; the locator finds the line at each commit.
 */
export const EXPORT_PATCHES = Object.freeze([
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", symbol: "reconciledAttribution", declaration: "function" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", symbol: "reconcileGroups", declaration: "async function" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", symbol: "genericRecordJson", declaration: "function" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", symbol: "genericOccurrence", declaration: "function" },
  { path: "apps/worker/src/storage-community-daily.ts", symbol: "publicInputs", declaration: "function" },
].map((patch) => Object.freeze(patch)));

export class VendorError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Throws unless every patch names a Worker source file, a plain identifier and a known kind, once each. */
export function assertPatchSpecs(patches) {
  const seen = new Set();
  for (const patch of patches) {
    if (typeof patch.path !== "string" || !patch.path.startsWith(`${WORKER_SRC}/`) || patch.path.split("/").includes("..")) {
      throw new VendorError("EXPORT_PATCH_SPEC_INVALID", `path ${JSON.stringify(patch.path)}`);
    }
    if (typeof patch.symbol !== "string" || !IDENTIFIER.test(patch.symbol)) {
      throw new VendorError("EXPORT_PATCH_SPEC_INVALID", `symbol ${JSON.stringify(patch.symbol)}`);
    }
    if (!PATCH_DECLARATIONS.includes(patch.declaration)) {
      throw new VendorError("EXPORT_PATCH_SPEC_INVALID", `declaration ${JSON.stringify(patch.declaration)} for ${patch.symbol}`);
    }
    const key = `${patch.path}\0${patch.symbol}`;
    if (seen.has(key)) throw new VendorError("EXPORT_PATCH_SPEC_INVALID", `duplicate ${patch.symbol} in ${patch.path}`);
    seen.add(key);
  }
}
assertPatchSpecs(EXPORT_PATCHES);

// ---------------------------------------------------------------------------
// Commit and layout
// ---------------------------------------------------------------------------

const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * A production commit must be a full 40-hex object id. Abbreviations and refs
 * (`HEAD`, `origin/main`, tags) are refused because they move; case is folded.
 */
export function parseCommit(value) {
  const folded = typeof value === "string" ? value.toLowerCase() : "";
  if (!COMMIT_ID.test(folded)) {
    throw new VendorError("COMMIT_NOT_FULL_SHA", `${JSON.stringify(value)} is not a 40-hex commit id (abbreviations, refs and tags are refused)`);
  }
  return folded;
}

/**
 * Where one commit's vendored tree and parity specs live under `outRoot`
 * (apps/worker unless a scratch directory is named). The vendor directory is
 * named by the first eight hex digits. The parity specs of the original
 * revision keep `kernel-parity`; every other commit gets `kernel-parity-<eight>`
 * so two vendored revisions never share a parity directory.
 */
export function vendorLayout({ commit = SOURCE_COMMIT, outRoot = WORKER_ROOT } = {}) {
  const sha = parseCommit(commit);
  const short = sha.slice(0, 8);
  const root = resolve(outRoot);
  const vendorRelative = `vendor/analytics-${short}`;
  const parityRelative = sha === SOURCE_COMMIT ? "analytics-v2-test/kernel-parity" : `analytics-v2-test/kernel-parity-${short}`;
  return Object.freeze({
    commit: sha,
    short,
    outRoot: root,
    vendorRelative,
    vendorRoot: resolve(root, vendorRelative),
    parityRelative,
    parityRoot: resolve(root, parityRelative),
  });
}

const DEFAULT_LAYOUT = vendorLayout();
export const VENDOR_RELATIVE = DEFAULT_LAYOUT.vendorRelative;
export const VENDOR_ROOT = DEFAULT_LAYOUT.vendorRoot;
export const PARITY_RELATIVE = DEFAULT_LAYOUT.parityRelative;
export const PARITY_ROOT = DEFAULT_LAYOUT.parityRoot;

/** Git's object id for a blob with these bytes. */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: WORKER_ROOT, encoding: "utf8" }).trim();
}

export function loadEsbuild() {
  return createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
}

/** Repository paths of the parity sources at the commit. */
export function paritySources() {
  return [...PARITY_SPECS, ...PARITY_HELPERS].map((rel) => ({ rel, source: `${WORKER_TEST}/${rel}` }));
}

/**
 * The quoted-specifier prefix that reaches the commit's apps/worker/src from
 * the original test location, and the prefix that reaches the vendored copy
 * from the parity copy. The rewrite replaces only quoted occurrences of `from`.
 */
export function parityRewrite(rel, layout = DEFAULT_LAYOUT) {
  const from = `${posix.relative(posix.dirname(`${WORKER_TEST}/${rel}`), WORKER_SRC)}/`;
  const to = `${posix.relative(posix.dirname(`apps/worker/${layout.parityRelative}/${rel}`),
    `apps/worker/${layout.vendorRelative}/${WORKER_SRC}`)}/`;
  return { from, to };
}

const QUOTES = ["'", "\""];

export function applyParityRewrite(text, { from, to }) {
  for (const q of QUOTES) {
    if (text.includes(`${q}${to}`)) throw new VendorError("PARITY_REWRITE_AMBIGUOUS", to);
  }
  let out = text;
  for (const q of QUOTES) out = out.split(`${q}${from}`).join(`${q}${to}`);
  for (const match of out.matchAll(/['"](\.\.\/[^'"]*)['"]/g)) {
    if (!match[1].startsWith(to)) throw new VendorError("PARITY_IMPORT_ESCAPES", match[1]);
  }
  return out;
}

export function reverseParityRewrite(text, { from, to }) {
  let out = text;
  for (const q of QUOTES) out = out.split(`${q}${to}`).join(`${q}${from}`);
  return out;
}

// ---------------------------------------------------------------------------
// Locating export patches by symbol
// ---------------------------------------------------------------------------

const REGEX_PRECEDING_WORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
const REGEX_PRECEDING_PUNCTUATION = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** End offset of a regex literal that starts at `start`, or -1 when the slash is not one (a regex cannot span lines). */
function regexLiteralEnd(text, start) {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return -1;
    if (char === "\\") { index += 1; continue; }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") { inClass = true; continue; }
    if (char === "/") {
      let end = index + 1;
      while (end < text.length && /[a-z]/i.test(text[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * Returns `text` with every comment, string, template-literal text and regex
 * literal blanked to spaces (newlines kept, offsets unchanged), so patterns run
 * over the result see code only. Code inside `${}` stays visible. The scan is
 * deliberately small; it fails closed with SOURCE_UNLEXABLE on an unterminated
 * construct, and the parser-level export check in `verifyExportPatches` backs
 * it up.
 */
export function maskNonCode(text) {
  const out = text.split("");
  const length = text.length;
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (text[index] !== "\n" && text[index] !== "\r") out[index] = " ";
  };
  const unlexable = (what, at) => { throw new VendorError("SOURCE_UNLEXABLE", `${what} at offset ${at}`); };
  const templateDepths = [];
  let depth = 0;
  let inTemplate = false;
  let last = { kind: "none", text: "" };
  let index = 0;
  while (index < length) {
    const char = text[index];
    if (inTemplate) {
      if (char === "\\") { blank(index, Math.min(index + 2, length)); index += 2; continue; }
      if (char === "`") { blank(index, index + 1); index += 1; inTemplate = false; last = { kind: "value", text: char }; continue; }
      if (char === "$" && text[index + 1] === "{") {
        blank(index, index + 2); index += 2; templateDepths.push(depth); inTemplate = false; last = { kind: "punct", text: "{" };
        continue;
      }
      blank(index, index + 1); index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      let end = text.indexOf("\n", index);
      if (end < 0) end = length;
      blank(index, end); index = end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) unlexable("unterminated block comment", index);
      blank(index, end + 2); index = end + 2;
      continue;
    }
    if (char === "'" || char === "\"") {
      let end = index + 1;
      for (;;) {
        if (end >= length) unlexable("unterminated string", index);
        const next = text[end];
        if (next === "\\") { end += text[end + 1] === "\r" && text[end + 2] === "\n" ? 3 : 2; continue; }
        if (next === "\n" || next === "\r") unlexable("unterminated string", index);
        if (next === char) break;
        end += 1;
      }
      blank(index, end + 1); index = end + 1; last = { kind: "value", text: char };
      continue;
    }
    if (char === "`") { blank(index, index + 1); index += 1; inTemplate = true; continue; }
    if (char === "/") {
      const regexAllowed = last.kind === "none" || (last.kind === "punct" && REGEX_PRECEDING_PUNCTUATION.has(last.text))
        || (last.kind === "word" && REGEX_PRECEDING_WORDS.has(last.text));
      const end = regexAllowed ? regexLiteralEnd(text, index) : -1;
      if (end > 0) { blank(index, end); index = end; last = { kind: "value", text: "/" }; continue; }
      last = { kind: "punct", text: "/" }; index += 1;
      continue;
    }
    if (char === "{") { depth += 1; last = { kind: "punct", text: char }; index += 1; continue; }
    if (char === "}") {
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop(); blank(index, index + 1); index += 1; inTemplate = true;
        continue;
      }
      depth -= 1; last = { kind: "punct", text: char }; index += 1;
      continue;
    }
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[\w$]/.test(char)) {
      let end = index + 1;
      while (end < length && /[\w$]/.test(text[end])) end += 1;
      last = { kind: "word", text: text.slice(index, end) }; index = end;
      continue;
    }
    last = { kind: "punct", text: char }; index += 1;
  }
  if (inTemplate || templateDepths.length) unlexable("unterminated template literal", length);
  return out.join("");
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declaration kinds that carry an export token in place; everything else found by name is refused. */
const SUPPORTED_DECLARATION_KINDS = new Set(PATCH_DECLARATIONS);

/**
 * Every declaration of `symbol` in code (any indentation): function
 * declarations and named function expressions, const/let/var bindings and
 * class/enum/namespace declarations. Each carries where it sits: `top` is
 * column 0 with at most `export` and `async` before it.
 */
export function findSymbolDeclarations(text, symbol, masked = maskNonCode(text)) {
  if (!IDENTIFIER.test(symbol)) throw new VendorError("EXPORT_PATCH_SPEC_INVALID", `symbol ${JSON.stringify(symbol)}`);
  const name = escapeRegExp(symbol);
  const forms = [
    { re: new RegExp(`(?<![\\w$.])function(\\s*\\*\\s*|\\s+)${name}(?![\\w$])`, "g"),
      kind: (match, async) => (match[1].includes("*") ? "generator function" : async ? "async function" : "function"),
      allowsAsync: true },
    { re: new RegExp(`(?<![\\w$.])(const|let|var)\\s+${name}(?![\\w$])`, "g"), kind: (match) => match[1], allowsAsync: false },
    { re: new RegExp(`(?<![\\w$.])(class|enum|namespace)\\s+${name}(?![\\w$])`, "g"), kind: (match) => match[1], allowsAsync: false },
  ];
  const found = [];
  for (const form of forms) {
    for (const match of masked.matchAll(form.re)) {
      const index = match.index;
      const lineStart = masked.lastIndexOf("\n", index - 1) + 1;
      const head = masked.slice(lineStart, index);
      const top = (form.allowsAsync ? /^(export\s+)?(async\s+)?$/ : /^(export\s+)?$/).exec(head);
      let placement = "other";
      if (top) placement = "top";
      else if (/^[ \t]+$/.test(head)) placement = "nested";
      else if (/^export\s+default\s+(async\s+)?$/.test(head)) placement = "default";
      found.push({
        kind: form.kind(match, Boolean(top?.[2])),
        exported: Boolean(top?.[1]),
        placement,
        index,
        lineStart,
        line: text.slice(0, lineStart).split("\n").length,
        end: index + match[0].length,
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** True when an `export { ... }` clause or `export * as` names the symbol, local or exported. */
function exportClauseNames(masked, symbol) {
  for (const clause of masked.matchAll(/(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of clause[1].split(",")) {
      if (part.split(/\s+/).filter(Boolean).filter((word) => word !== "type" && word !== "as").includes(symbol)) return true;
    }
  }
  return new RegExp(`(?<![\\w$.])export\\s*\\*\\s*as\\s+${escapeRegExp(symbol)}(?![\\w$])`).test(masked);
}

/** The recorded start of a patched declaration: its text up to and including the delimiter after the name. */
function originalPrefix(text, lineStart, nameEnd) {
  let end = nameEnd;
  while (text[end] === " " || text[end] === "\t") end += 1;
  if (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
  return text.slice(lineStart, end);
}

/**
 * Resolves one patch against one source text. The status is closed:
 *   apply             exactly one column-0 declaration of the right kind, not yet exported
 *   already-exported  the same, but the commit already writes `export`
 *   missing           no declaration of the symbol in code
 *   ambiguous         more than one declaration (overloads, shadowing, a named function expression)
 *   not-top-level     the one declaration is nested, a default export or otherwise not at column 0
 *   unsupported       the one declaration is a let/var/class/enum/namespace/generator
 *   kind-changed      the one declaration is a different supported kind than the patch names
 *   export-clause     an `export { }` clause also names the symbol, so adding a token would clash
 *   unlexable         the lexer could not mask the file
 */
export function locateExportSymbol(text, patch) {
  const base = { path: patch.path, symbol: patch.symbol, declaration: patch.declaration };
  let masked;
  try {
    masked = maskNonCode(text);
  } catch (error) {
    if (!(error instanceof VendorError)) throw error;
    return { ...base, status: "unlexable", detail: error.message };
  }
  if (exportClauseNames(masked, patch.symbol)) {
    return { ...base, status: "export-clause", detail: "an export clause already names the symbol" };
  }
  const declarations = findSymbolDeclarations(text, patch.symbol, masked);
  if (!declarations.length) return { ...base, status: "missing", detail: "no declaration of the symbol" };
  if (declarations.length > 1) {
    return { ...base, status: "ambiguous", detail: `${declarations.length} declarations at lines ${declarations.map((d) => d.line).join(", ")}` };
  }
  const [found] = declarations;
  const where = { line: found.line, lineStart: found.lineStart };
  if (found.placement !== "top") {
    return { ...base, ...where, status: "not-top-level", detail: `${found.kind} at line ${found.line} is ${found.placement}, not a column-0 declaration` };
  }
  if (!SUPPORTED_DECLARATION_KINDS.has(found.kind)) {
    return { ...base, ...where, status: "unsupported", detail: `${found.kind} at line ${found.line} cannot take an export token in place` };
  }
  if (found.kind !== patch.declaration) {
    return { ...base, ...where, status: "kind-changed", detail: `${patch.symbol} is now a ${found.kind}, the patch names a ${patch.declaration}` };
  }
  return { ...base, ...where, status: found.exported ? "already-exported" : "apply", original: originalPrefix(text, found.lineStart, found.end) };
}

const PATCH_OK = new Set(["apply", "already-exported"]);

/** One resolution per patch, in patch order. `readText(path)` returns the file's text or undefined when it is absent. */
export function resolveExportPatches(patches, readText) {
  assertPatchSpecs(patches);
  return patches.map((patch) => {
    const text = readText(patch.path);
    if (text === undefined) {
      return { path: patch.path, symbol: patch.symbol, declaration: patch.declaration, status: "file-missing", detail: "the file is not in the commit" };
    }
    return locateExportSymbol(text, patch);
  });
}

/** Throws unless every resolution is `apply` or `already-exported`; the code names the first failure, the detail lists all. */
export function assertExportPatchesResolved(resolutions) {
  const failures = resolutions.filter((resolution) => !PATCH_OK.has(resolution.status));
  if (!failures.length) return;
  const code = `EXPORT_SYMBOL_${failures[0].status.toUpperCase().replace(/-/g, "_")}`;
  throw new VendorError(code, failures.map((f) => `${f.path}:${f.symbol} ${f.status} (${f.detail})`).join("; "));
}

/** Adds the export tokens for this file's `apply` resolutions at their line starts; refuses a non-minimal result. */
export function applyExportPatches(path, bytes, resolutions) {
  const mine = resolutions.filter((resolution) => resolution.path === path && resolution.status === "apply");
  if (!mine.length) return bytes;
  let text = bytes.toString("utf8");
  for (const resolution of [...mine].sort((a, b) => b.lineStart - a.lineStart)) {
    text = `${text.slice(0, resolution.lineStart)}${EXPORT_TOKEN}${text.slice(resolution.lineStart)}`;
  }
  const out = Buffer.from(text, "utf8");
  if (out.length !== bytes.length + EXPORT_TOKEN.length * mine.length) throw new VendorError("EXPORT_PATCH_NOT_MINIMAL", path);
  return out;
}

/** Export names of a TypeScript module as esbuild's metafile reports them (every import left external). */
async function moduleExportNames(esbuild, path, text) {
  try {
    const result = await esbuild.build({
      stdin: { contents: text, loader: "ts", sourcefile: path, resolveDir: WORKER_ROOT },
      bundle: true, write: false, metafile: true, format: "esm", logLevel: "silent", tsconfigRaw: {},
      plugins: [{
        name: "export-names-externals",
        setup(build) { build.onResolve({ filter: /.*/ }, (args) => (args.kind === "entry-point" ? undefined : { path: args.path, external: true })); },
      }],
    });
    return new Set(Object.values(result.metafile.outputs).flatMap((output) => output.exports ?? []));
  } catch (error) {
    throw new VendorError("EXPORT_PATCH_VERIFY_FAILED", `${path} does not parse: ${String(error?.errors?.[0]?.text ?? error?.message ?? error)}`);
  }
}

/**
 * Parser-level confirmation of one file's patches: each `apply` symbol was not
 * exported and now is, each `already-exported` symbol is exported in the
 * original, and the patch added no other export and removed none.
 */
export async function verifyExportPatches(esbuild, path, text, patched, resolutions) {
  const mine = resolutions.filter((resolution) => resolution.path === path);
  const applied = mine.filter((resolution) => resolution.status === "apply").map((resolution) => resolution.symbol);
  const present = mine.filter((resolution) => resolution.status === "already-exported").map((resolution) => resolution.symbol);
  const before = await moduleExportNames(esbuild, path, text);
  const after = patched === text ? before : await moduleExportNames(esbuild, path, patched);
  const problems = [];
  for (const symbol of applied) {
    if (before.has(symbol)) problems.push(`${symbol} was already exported`);
    if (!after.has(symbol)) problems.push(`${symbol} is not exported after the patch`);
  }
  for (const symbol of present) if (!before.has(symbol)) problems.push(`${symbol} is not exported although the declaration says so`);
  const extra = [...after].filter((name) => !before.has(name) && !applied.includes(name));
  if (extra.length) problems.push(`the patch also exported ${extra.join(", ")}`);
  const lost = [...before].filter((name) => !after.has(name));
  if (lost.length) problems.push(`the patch dropped ${lost.join(", ")}`);
  if (problems.length) throw new VendorError("EXPORT_PATCH_VERIFY_FAILED", `${path}: ${problems.join("; ")}`);
}

/**
 * Resolves every patch, refuses unless all resolve, then verifies each patched
 * file with the parser. Returns the resolutions for `applyExportPatches`.
 */
export async function planExportPatches({ patches = EXPORT_PATCHES, readText, esbuild = loadEsbuild() }) {
  const resolutions = resolveExportPatches(patches, readText);
  assertExportPatchesResolved(resolutions);
  for (const path of new Set(resolutions.map((resolution) => resolution.path))) {
    const text = readText(path);
    const patched = applyExportPatches(path, Buffer.from(text, "utf8"), resolutions).toString("utf8");
    await verifyExportPatches(esbuild, path, text, patched, resolutions);
  }
  return resolutions;
}

// ---------------------------------------------------------------------------
// Reading the commit
// ---------------------------------------------------------------------------

/** All blobs under these prefixes at `commit`: Map<path, {mode, blob}>. */
function listTree(root, commit, prefixes) {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...prefixes],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const tree = new Map();
  for (const record of out.toString("utf8").split("\0")) {
    if (!record) continue;
    const [meta, path] = record.split("\t");
    const [mode, type, blob] = meta.split(" ");
    if (type !== "blob") continue;
    if (mode !== "100644") throw new VendorError("UNSUPPORTED_MODE", `${mode} ${path}`);
    tree.set(path, { mode, blob });
  }
  return tree;
}

/** One file's text at the commit, or undefined when the commit has no such blob. */
function readTextAt(root, commit, path) {
  const result = spawnSync("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.toString("utf8") : undefined;
}

/** Reads blobs with one `git cat-file --batch`: Map<blob, Buffer>. */
function readBlobs(root, blobs) {
  const unique = [...new Set(blobs)];
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root, input: `${unique.join("\n")}\n`, maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) throw new VendorError("GIT_CAT_FILE_FAILED", result.stderr?.toString());
  const out = result.stdout;
  const map = new Map();
  let offset = 0;
  for (const blob of unique) {
    const newline = out.indexOf(0x0a, offset);
    const [sha, type, size] = out.subarray(offset, newline).toString("utf8").split(" ");
    if (sha !== blob || type !== "blob") throw new VendorError("GIT_CAT_FILE_FAILED", blob);
    const start = newline + 1;
    const bytes = Buffer.from(out.subarray(start, start + Number(size)));
    if (gitBlobSha(bytes) !== blob) throw new VendorError("GIT_BLOB_MISMATCH", blob);
    map.set(blob, bytes);
    offset = start + Number(size) + 1;
  }
  return map;
}

function writeFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Runs esbuild over a tree laid out like the vendor directory and returns the
 * runtime inputs of each named entry plus every bare import left external.
 * `@app-usagemonitor/*` must resolve through the tree's tsconfig.json paths;
 * any `cloudflare:` import fails the build.
 */
export async function computeRuntimeClosure({ esbuild, root, entryPoints }) {
  const externals = new Map();
  const cloudflare = [];
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    mainFields: ["module", "main"],
    outdir: join(root, ".closure-out"),
    logLevel: "silent",
    plugins: [{
      name: "vendor-closure-externals",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const spec = args.path;
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@app-usagemonitor/")) return undefined;
          if (spec.startsWith("cloudflare:")) cloudflare.push(`${args.importer} -> ${spec}`);
          const name = spec.startsWith("node:") ? spec : spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
          if (!externals.has(name)) externals.set(name, new Set());
          externals.get(name).add(args.importer);
          return { path: spec, external: true };
        });
      },
    }],
  });
  if (cloudflare.length) throw new VendorError("CLOUDFLARE_IMPORT_IN_CLOSURE", cloudflare.join(", "));
  const byEntry = {};
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    const name = Object.entries(entryPoints).find(([, file]) => output.entryPoint === posix.normalize(file.split(sep).join("/")))?.[0];
    if (!name) throw new VendorError("CLOSURE_ENTRY_UNMAPPED", output.entryPoint);
    byEntry[name] = Object.keys(output.inputs).sort();
  }
  for (const name of Object.keys(entryPoints)) {
    if (!byEntry[name]) throw new VendorError("CLOSURE_ENTRY_MISSING", name);
  }
  return { byEntry, externals: [...externals.keys()].sort(), esbuildVersion: esbuild.version };
}

/** Entry points for a tree laid out like the vendor directory (paths relative to root). */
export function closureEntryPoints(parityPathFor) {
  const entries = { kernel: "entry.ts" };
  WEB_ROOTS.forEach((path, index) => { entries[`web${index}`] = path; });
  PARITY_SPECS.forEach((spec, index) => { entries[`parity${index}`] = parityPathFor(spec); });
  return entries;
}

/** Classifies closure inputs into vendored repository paths with their reach. */
export function classifyClosure(byEntry, { isParityInput }) {
  const reach = new Map();
  const mark = (path, value) => { if (!reach.has(path)) reach.set(path, value); };
  const order = ["kernel", ...Object.keys(byEntry).filter((name) => name.startsWith("web")),
    ...Object.keys(byEntry).filter((name) => name.startsWith("parity"))];
  for (const name of order) {
    const value = name === "kernel" ? "kernel" : name.startsWith("web") ? "web" : "parity";
    for (const input of byEntry[name]) {
      if (input === "entry.ts" || isParityInput(input)) continue;
      if (PACKAGE_RULE.test(input)) {
        const pkg = PACKAGE_RULE.exec(input)[1];
        if (!VENDORED_PACKAGES.includes(pkg)) throw new VendorError("UNVENDORED_PACKAGE_INPUT", input);
        continue;
      }
      if (!input.startsWith(`${WORKER_SRC}/`) && !input.startsWith("apps/web/public/")) {
        throw new VendorError("UNEXPECTED_CLOSURE_INPUT", input);
      }
      mark(input, value);
    }
  }
  return reach;
}

/** Paths this generator may own inside the vendor directory. */
export function isVendoredPath(path) {
  return !path.split("/").includes("..")
    && (path.startsWith(`${WORKER_SRC}/`) || path.startsWith("apps/web/public/")
      || (PACKAGE_RULE.test(path) && VENDORED_PACKAGES.includes(PACKAGE_RULE.exec(path)[1])));
}

function removeEmptyDirectories(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir)) removeEmptyDirectories(join(dir, entry));
  if (!readdirSync(dir).length) rmdirSync(dir);
}


// ---------------------------------------------------------------------------
// One commit's output directory
// ---------------------------------------------------------------------------

function readManifest(layout) {
  const path = join(layout.vendorRoot, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Deletes only the files a previous manifest says this generator wrote. */
function removePreviousOutput(previous, layout) {
  if (!previous) return;
  if (previous.schemaVersion !== MANIFEST_SCHEMA) throw new VendorError("MANIFEST_SCHEMA_UNKNOWN", previous.schemaVersion);
  // Resolve and validate every target before deleting any of them.
  const targets = [];
  for (const file of [...(previous.files ?? []), ...(previous.typeStubs ?? [])]) {
    const target = resolve(layout.vendorRoot, file.path);
    if (!target.startsWith(`${layout.vendorRoot}${sep}`) || !isVendoredPath(file.path)) {
      throw new VendorError("MANIFEST_PATH_UNEXPECTED", file.path);
    }
    targets.push(target);
  }
  for (const test of previous.parityTests ?? []) {
    const target = resolve(layout.outRoot, test.path);
    if (!target.startsWith(`${layout.parityRoot}${sep}`)) throw new VendorError("MANIFEST_PATH_UNEXPECTED", test.path);
    targets.push(target);
  }
  for (const target of targets) if (existsSync(target)) unlinkSync(target);
  for (const top of ["apps", "packages"]) removeEmptyDirectories(join(layout.vendorRoot, top));
  removeEmptyDirectories(layout.parityRoot);
}

/** The commit must exist here as exactly this id, and as a commit (not a tag or tree that peels to one). */
function assertSourceCommit(root, commit) {
  const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: root, encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== commit) throw new VendorError("SOURCE_COMMIT_UNAVAILABLE", commit);
}

/** A vendor directory belongs to one commit; never write another commit's output into it. */
function assertDirectoryCommit(layout) {
  const manifest = readManifest(layout);
  if (manifest && manifest.sourceCommit !== layout.commit) {
    throw new VendorError("VENDOR_DIR_COMMIT_MISMATCH", `${layout.vendorRelative} holds ${manifest.sourceCommit}, not ${layout.commit}`);
  }
}

/**
 * Where the reviewed entry.ts and tsconfig.json come from. A vendor directory
 * that holds them keeps them (they are hand-written and never overwritten).
 * `authoredFrom` seeds a directory that holds neither, and is refused when it
 * holds either.
 */
function resolveAuthoredSource(layout, authoredFrom) {
  const own = AUTHORED_FILES.filter((file) => existsSync(join(layout.vendorRoot, file)));
  if (authoredFrom) {
    if (own.length) {
      throw new VendorError("AUTHORED_FILES_EXIST", `${layout.vendorRelative} already holds ${own.join(", ")}; --authored-from only seeds a directory that has none`);
    }
    const dir = resolve(authoredFrom);
    for (const file of AUTHORED_FILES) {
      if (!existsSync(join(dir, file))) throw new VendorError("AUTHORED_FILE_MISSING", `${join(dir, file)}`);
    }
    return { dir, seeded: true };
  }
  for (const file of AUTHORED_FILES) {
    if (!existsSync(join(layout.vendorRoot, file))) {
      throw new VendorError("AUTHORED_FILE_MISSING", `${layout.vendorRelative}/${file} (seed a new vendor directory with --authored-from=<vendor dir>)`);
    }
  }
  return { dir: layout.vendorRoot, seeded: false };
}

/**
 * Runs `fn` over a throwaway extraction of the commit laid out like the vendor
 * directory (export patches applied, authored files copied), then deletes it.
 * Every export patch must resolve by symbol before anything is extracted.
 */
export async function withSourceExtraction({ layout = DEFAULT_LAYOUT, authoredFrom } = {}, fn) {
  const root = repoRoot();
  assertSourceCommit(root, layout.commit);
  assertDirectoryCommit(layout);
  const authored = resolveAuthoredSource(layout, authoredFrom);
  const tree = listTree(root, layout.commit, [WORKER_SRC, WORKER_TYPES, "apps/web/public",
    ...VENDORED_PACKAGES.map((pkg) => `packages/${pkg}`), ...paritySources().map(({ source }) => source)]);
  if (![...tree.keys()].some((path) => path.startsWith(`${WORKER_SRC}/`))) throw new VendorError("SOURCE_LAYOUT_UNEXPECTED", `${layout.commit} has no ${WORKER_SRC}`);
  const parityMissing = paritySources().filter(({ source }) => !tree.has(source)).map(({ source }) => source);
  if (parityMissing.length) throw new VendorError("PARITY_SOURCE_MISSING", parityMissing.join(", "));
  const extractable = [...tree.keys()].filter((path) => path.startsWith(`${WORKER_SRC}/`) || PACKAGE_RULE.test(path)
    || (path.startsWith("apps/web/public/") && path.endsWith(".js")) || path.startsWith(`${WORKER_TEST}/`)
    || path === WORKER_TYPES);
  const blobs = readBlobs(root, extractable.map((path) => tree.get(path).blob));
  const textAt = (path) => (tree.has(path) && blobs.has(tree.get(path).blob) ? blobs.get(tree.get(path).blob).toString("utf8") : undefined);
  const exportPlan = await planExportPatches({ readText: textAt });
  const scratch = mkdtempSync(join(tmpdir(), "vendor-analytics-kernels-"));
  try {
    for (const path of extractable) writeFile(join(scratch, path), applyExportPatches(path, blobs.get(tree.get(path).blob), exportPlan));
    for (const file of AUTHORED_FILES) writeFile(join(scratch, file), readFileSync(join(authored.dir, file)));
    return await fn({ scratch, tree, exportPlan, authored, blobs: (path) => blobs.get(tree.get(path).blob) });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * Worker modules that vendored TypeScript names but that are not vendored.
 * The runtime closure is complete, so every such import is type-only; tsc
 * still resolves it. `exists` tells whether a path exists at the commit.
 */
export function typeOnlyFrontier(vendored, readVendored, exists) {
  const frontier = new Set();
  for (const path of [...vendored].sort()) {
    if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
    for (const match of readVendored(path).toString("utf8").matchAll(RELATIVE_SPECIFIER)) {
      const base = posix.normalize(posix.join(posix.dirname(path), match[1]));
      const target = [`${base}.ts`, `${base}/index.ts`, base].find((candidate) => vendored.has(candidate) || exists(candidate));
      if (!target) throw new VendorError("UNRESOLVED_RELATIVE_IMPORT", `${path} -> ${match[1]}`);
      if (!vendored.has(target)) frontier.add(target);
    }
  }
  return [...frontier].sort();
}

export const typeStubPath = (source) => source.replace(/\.ts$/, ".d.ts");

/**
 * Declaration stubs for the type-only frontier, emitted by this checkout's tsc
 * from the d43c8f92 sources. They let tsc-checked consumers import entry.ts
 * (with skipLibCheck, imports inside a stub that stay unresolved are not
 * reported); esbuild and Vitest never load them.
 */
function emitTypeStubs(scratch, frontier) {
  if (!frontier.length) return new Map();
  const compilerOptions = JSON.parse(readFileSync(join(scratch, "tsconfig.json"), "utf8")).compilerOptions;
  writeFileSync(join(scratch, "tsconfig.stubs.json"), JSON.stringify({
    compilerOptions: { ...compilerOptions, types: [`./${WORKER_TYPES}`], noEmit: false, declaration: true,
      emitDeclarationOnly: true, noEmitOnError: false, rootDir: ".", outDir: "./.type-stubs" },
    files: frontier,
  }));
  symlinkSync(join(WORKER_ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
  const tsc = join(WORKER_ROOT, "node_modules", ".bin", "tsc");
  const result = spawnSync(tsc, ["-p", "tsconfig.stubs.json", "--pretty", "false"], { cwd: scratch, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || ![0, 1, 2].includes(result.status)) throw new VendorError("TYPE_STUB_EMIT_FAILED", String(result.error ?? result.status));
  const own = (result.stdout ?? "").split("\n").filter((line) => frontier.some((path) => line.startsWith(`${path}(`)));
  if (own.length) throw new VendorError("TYPE_STUB_SOURCE_ERRORS", own.join("; "));
  const stubs = new Map();
  for (const source of frontier) {
    const emitted = join(scratch, ".type-stubs", typeStubPath(source));
    if (!existsSync(emitted)) throw new VendorError("TYPE_STUB_NOT_EMITTED", source);
    const bytes = readFileSync(emitted);
    if (bytes.toString("utf8").includes("cloudflare:")) throw new VendorError("CLOUDFLARE_IMPORT_IN_TYPE_STUB", source);
    stubs.set(typeStubPath(source), bytes);
  }
  return stubs;
}

/** Re-emits the stubs for the manifest's vendored files (used by the check). */
export async function regenerateTypeStubs(manifest, { outRoot = WORKER_ROOT } = {}) {
  const layout = vendorLayout({ commit: manifest.sourceCommit, outRoot });
  return withSourceExtraction({ layout }, async ({ scratch, tree }) => {
    const vendored = new Set(manifest.files.map((file) => file.path));
    const frontier = typeOnlyFrontier(vendored, (path) => readFileSync(join(scratch, path)), (path) => tree.has(path));
    return { frontier, stubs: emitTypeStubs(scratch, frontier) };
  });
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * MANIFEST.json for one vendored commit. Its shape is schema v1 and does not
 * depend on how the patches were located: each applied patch records the line
 * the locator found and the declaration's recorded start. A symbol the commit
 * already exports adds `exportsAlreadyPresent` (absent otherwise).
 */
export function buildManifest({ layout, closure, files, typeStubs, parityTests, exportPlan }) {
  const applied = exportPlan.filter((resolution) => resolution.status === "apply");
  const present = exportPlan.filter((resolution) => resolution.status === "already-exported");
  return {
    schemaVersion: MANIFEST_SCHEMA,
    sourceCommit: layout.commit,
    generator: "apps/worker/scripts/vendor-analytics-kernels.mjs",
    check: "apps/worker/scripts/vendor-analytics-kernels.check.mjs",
    authoredFiles: [...AUTHORED_FILES],
    closure: {
      tool: "esbuild-metafile",
      esbuildVersion: closure.esbuildVersion,
      entryPoints: Object.values(closureEntryPoints((spec) => `${WORKER_TEST}/${spec}`)),
      packageRule: "packages/{accounting,quota-analysis,telemetry-contract}/{package.json,index.js,index.d.ts,src/**}",
      typeOnlyImports: "erased by esbuild; not vendored; typeStubs declare the modules that vendored files name",
      externals: closure.externals,
    },
    exportPatches: applied.map(({ path, line, symbol, original }) => ({ path, line, symbol, original })),
    ...(present.length ? { exportsAlreadyPresent: present.map(({ path, line, symbol }) => ({ path, line, symbol })) } : {}),
    counts: {
      files: files.length,
      kernel: files.filter((file) => file.reach === "kernel").length,
      web: files.filter((file) => file.reach === "web").length,
      parity: files.filter((file) => file.reach === "parity").length,
      package: files.filter((file) => file.reach === "package").length,
      exportPatched: applied.length,
      exportPatchedFiles: files.filter((file) => file.patch === "export").length,
      typeStubs: typeStubs.length,
      parityTests: parityTests.length,
    },
    files: files.map(({ path, blob, sha256: digest, patch, reach: value }) => ({ path, blob, sha256: digest, patch, reach: value })),
    typeStubs: typeStubs.map(({ path, source, sourceBlob, sha256: digest }) => ({ path, source, sourceBlob, sha256: digest,
      tool: "tsc --declaration --emitDeclarationOnly" })),
    parityTests: parityTests.map(({ path, source, blob, rewrite }) => ({ path, source, blob, rewrite })),
  };
}

export async function vendorAnalyticsKernels({ log = console.log, commit = SOURCE_COMMIT, outRoot = WORKER_ROOT, authoredFrom } = {}) {
  const layout = vendorLayout({ commit, outRoot });
  return withSourceExtraction({ layout, authoredFrom }, async ({ scratch, tree, blobs, exportPlan, authored }) => {
    // 1. Runtime closure from the facade, the website normalizer and the parity specs.
    const esbuild = loadEsbuild();
    const parityInputs = new Set(paritySources().map(({ source }) => source));
    const closure = await computeRuntimeClosure({ esbuild, root: scratch,
      entryPoints: closureEntryPoints((spec) => `${WORKER_TEST}/${spec}`) });
    for (const inputs of Object.values(closure.byEntry)) {
      for (const input of inputs) {
        if (input.startsWith(`${WORKER_TEST}/`) && !parityInputs.has(input)) throw new VendorError("UNLISTED_PARITY_HELPER", input);
      }
    }
    const reach = classifyClosure(closure.byEntry, { isParityInput: (input) => parityInputs.has(input) });

    // 2. Files: the closure plus the whole of each vendored package.
    const patchedPaths = new Set(exportPlan.filter((resolution) => resolution.status === "apply").map((resolution) => resolution.path));
    const files = [];
    for (const path of [...tree.keys()].sort()) {
      const pkg = PACKAGE_RULE.exec(path);
      const value = pkg && VENDORED_PACKAGES.includes(pkg[1]) ? "package" : reach.get(path);
      if (!value) continue;
      const vendored = applyExportPatches(path, blobs(path), exportPlan);
      files.push({ path, blob: tree.get(path).blob, sha256: sha256(vendored),
        patch: patchedPaths.has(path) ? "export" : "none", reach: value, bytes: vendored });
    }
    for (const path of reach.keys()) if (!files.some((file) => file.path === path)) throw new VendorError("CLOSURE_INPUT_NOT_IN_TREE", path);
    for (const path of patchedPaths) if (!files.some((file) => file.path === path)) throw new VendorError("EXPORT_PATCH_FILE_NOT_VENDORED", path);

    // 3. Declaration stubs for type-only imports that leave the runtime closure.
    const vendoredPaths = new Set(files.map((file) => file.path));
    const frontier = typeOnlyFrontier(vendoredPaths, (path) => readFileSync(join(scratch, path)), (path) => tree.has(path));
    const stubs = emitTypeStubs(scratch, frontier);
    const typeStubs = frontier.map((source) => ({ path: typeStubPath(source), source, sourceBlob: tree.get(source).blob,
      sha256: sha256(stubs.get(typeStubPath(source))), bytes: stubs.get(typeStubPath(source)) }));

    const parityTests = paritySources().map(({ rel, source }) => {
      const rewrite = parityRewrite(rel, layout);
      const original = blobs(source);
      const text = applyParityRewrite(original.toString("utf8"), rewrite);
      if (reverseParityRewrite(text, rewrite) !== original.toString("utf8")) throw new VendorError("PARITY_REWRITE_IRREVERSIBLE", source);
      return { path: `${layout.parityRelative}/${rel}`, source, blob: tree.get(source).blob, rewrite, bytes: Buffer.from(text, "utf8") };
    });

    // 4. Replace previous output, then write.
    removePreviousOutput(readManifest(layout), layout);
    if (authored.seeded) for (const file of AUTHORED_FILES) writeFile(join(layout.vendorRoot, file), readFileSync(join(authored.dir, file)));
    for (const file of [...files, ...typeStubs]) writeFile(join(layout.vendorRoot, file.path), file.bytes);
    for (const test of parityTests) writeFile(join(layout.outRoot, test.path), test.bytes);
    const manifest = buildManifest({ layout, closure, files, typeStubs, parityTests, exportPlan });
    writeFileSync(join(layout.vendorRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    log(JSON.stringify({ status: "ok", sourceCommit: layout.commit, ...manifest.counts, externals: closure.externals }));
    return manifest;
  });
}

// ---------------------------------------------------------------------------
// Report: resolve the patches at a commit and list vendored files that differ
// ---------------------------------------------------------------------------

/**
 * Vendored files of a reference manifest whose blobs differ at `commit`:
 * the vendored files, the sources of the type stubs and the parity sources.
 */
export function driftAgainstReference(root, commit, reference) {
  const entries = [
    ...(reference.files ?? []).map((file) => ({ role: "vendored", path: file.path, blob: file.blob })),
    ...(reference.typeStubs ?? []).map((stub) => ({ role: "type-stub-source", path: stub.source, blob: stub.sourceBlob })),
    ...(reference.parityTests ?? []).map((spec) => ({ role: "parity-source", path: spec.source, blob: spec.blob })),
  ];
  const tree = listTree(root, commit, [...new Set(entries.map((entry) => entry.path))]);
  const changed = [];
  const removed = [];
  let identical = 0;
  for (const entry of entries) {
    const now = tree.get(entry.path);
    if (!now) removed.push({ role: entry.role, path: entry.path });
    else if (now.blob !== entry.blob) changed.push({ role: entry.role, path: entry.path, referenceBlob: entry.blob, blob: now.blob });
    else identical += 1;
  }
  return { referenceCommit: reference.sourceCommit, checked: entries.length, identical, changed, removed };
}

/**
 * The reviewed facade's own imports of Worker modules that `commit` no longer
 * has. A facade with unresolved imports must be re-authored before that commit
 * can be vendored; the report says so before the generator is run.
 */
export function facadeAgainstCommit(root, commit, referenceDirectory) {
  const entry = join(referenceDirectory, "entry.ts");
  if (!existsSync(entry)) return null;
  const modules = new Set();
  for (const match of readFileSync(entry, "utf8").matchAll(/\bfrom\s+["']\.\/(apps\/worker\/src\/[^"']+)["']/g)) modules.add(match[1]);
  const wanted = [...modules].sort();
  const tree = listTree(root, commit, wanted.map((module) => `${module}.ts`));
  const unresolved = wanted.filter((module) => !tree.has(`${module}.ts`));
  return { entry: "entry.ts", modules: wanted.length, unresolved };
}

/**
 * Writes nothing. Resolves every export patch at `commit`, confirms the
 * resolvable set with the parser, and (when a reference manifest is given)
 * lists the reference's files whose blobs differ at `commit` and the facade
 * imports that no longer resolve. `patchesOk` is the patch result alone;
 * `ok` also requires a facade that still resolves.
 */
export async function reportAtCommit({ commit, reference, referenceDirectory } = {}) {
  const layout = vendorLayout({ commit });
  const root = repoRoot();
  assertSourceCommit(root, layout.commit);
  const texts = new Map([...new Set(EXPORT_PATCHES.map((patch) => patch.path))].map((path) => [path, readTextAt(root, layout.commit, path)]));
  const resolutions = resolveExportPatches(EXPORT_PATCHES, (path) => texts.get(path));
  const summary = {};
  for (const resolution of resolutions) summary[resolution.status] = (summary[resolution.status] ?? 0) + 1;
  let verification = { status: "skipped", detail: "a patch did not resolve" };
  if (resolutions.every((resolution) => PATCH_OK.has(resolution.status))) {
    try {
      await planExportPatches({ readText: (path) => texts.get(path) });
      verification = { status: "passed" };
    } catch (error) {
      if (!(error instanceof VendorError)) throw error;
      verification = { status: "failed", detail: error.message };
    }
  }
  const patches = resolutions.map(({ path, symbol, declaration, status, line, original, detail }) => ({
    path, symbol, declaration, status, ...(line === undefined ? {} : { line }), ...(original === undefined ? {} : { original }),
    ...(PATCH_OK.has(status) ? {} : { detail }),
  }));
  const facade = referenceDirectory ? facadeAgainstCommit(root, layout.commit, referenceDirectory) : null;
  const patchesOk = resolutions.every((resolution) => PATCH_OK.has(resolution.status)) && verification.status === "passed";
  return {
    commit: layout.commit,
    vendorDirectory: layout.vendorRelative,
    patches,
    summary,
    verification,
    drift: reference ? driftAgainstReference(root, layout.commit, reference) : null,
    facade,
    patchesOk,
    // The commit can be vendored with this facade only when the patches resolve and the facade's imports all exist.
    ok: patchesOk && (facade === null || facade.unresolved.length === 0),
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export const USAGE = [
  "usage: node scripts/vendor-analytics-kernels.mjs [--commit=<40-hex>] [--out-root=<dir>] [--authored-from=<vendor dir>]",
  "       node scripts/vendor-analytics-kernels.mjs --report [--commit=<40-hex>] [--reference=<MANIFEST.json>]",
].join("\n");

const VALUE_FLAGS = new Set(["commit", "out-root", "authored-from", "reference"]);
const SWITCH_FLAGS = new Set(["report", "help"]);

/** Strict parse: unknown, repeated, valueless or positional arguments refuse. */
export function parseArguments(argv) {
  const options = { commit: SOURCE_COMMIT, outRoot: undefined, authoredFrom: undefined, reference: undefined, report: false, help: false };
  const seen = new Set();
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(argument);
    if (!match) throw new VendorError("USAGE", `unexpected argument ${JSON.stringify(argument)}\n${USAGE}`);
    const [, flag, value] = match;
    const known = VALUE_FLAGS.has(flag) || SWITCH_FLAGS.has(flag);
    if (!known) throw new VendorError("USAGE", `unknown option --${flag}\n${USAGE}`);
    if (seen.has(flag)) throw new VendorError("USAGE", `--${flag} given twice`);
    seen.add(flag);
    if (SWITCH_FLAGS.has(flag)) {
      if (value !== undefined) throw new VendorError("USAGE", `--${flag} takes no value`);
      options[flag] = true;
    } else {
      if (!value) throw new VendorError("USAGE", `--${flag} needs a value: --${flag}=<value>`);
      options[flag === "out-root" ? "outRoot" : flag === "authored-from" ? "authoredFrom" : flag] = value;
    }
  }
  options.commit = parseCommit(options.commit);
  if (options.report && (options.outRoot || options.authoredFrom)) throw new VendorError("USAGE", "--report writes nothing; --out-root and --authored-from do not apply");
  if (options.reference && !options.report) throw new VendorError("USAGE", "--reference only applies to --report");
  return options;
}

export async function main(argv, { log = console.log } = {}) {
  const options = parseArguments(argv);
  if (options.help) { log(USAGE); return { ok: true }; }
  if (options.report) {
    const referencePath = options.reference ? resolve(options.reference) : join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE);
    if (options.reference && !existsSync(referencePath)) throw new VendorError("REFERENCE_MANIFEST_MISSING", referencePath);
    const reference = existsSync(referencePath) ? JSON.parse(readFileSync(referencePath, "utf8")) : undefined;
    const report = await reportAtCommit({ commit: options.commit, reference, referenceDirectory: reference ? dirname(referencePath) : undefined });
    log(JSON.stringify(report, null, 2));
    return report;
  }
  const manifest = await vendorAnalyticsKernels({
    log, commit: options.commit, authoredFrom: options.authoredFrom, outRoot: options.outRoot ? resolve(options.outRoot) : WORKER_ROOT,
  });
  return { ok: true, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof VendorError ? error.message : error);
    process.exitCode = 1;
  }
}
