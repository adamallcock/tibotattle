// The GCP-only vocabularies, derived from a vendored analytics-kernel tree.
//
// The GCP line keeps its own copies of a few closed sets the production
// kernels define: the number of model dates the allowance preview spans, the
// refusal reasons the shared reducers and the cache reducer raise, the cache
// continuity band ids and band counters, and the schema version of the
// community daily read. PostgreSQL CHECK constraints (primary 0059) and the
// analytics-v2 contract hold those copies. A re-vendor at a new production
// commit must not let them drift silently, so this module derives the sets
// from the vendored files themselves and renders them as one generated module,
// src/analytics-v2/kernel-vocabularies.generated.ts.
//
// The derivation is mechanical and fails closed. Nothing is listed by hand:
//   - modelDates and cacheRetentionBandIds are runtime values: the vendored
//     modules are bundled on their own (their @app-usagemonitor imports resolve
//     to the vendored packages through the tree's tsconfig.json) and loaded;
//   - cacheBandCounters are the members of the kernel's
//     CacheRetentionBandCounters interface in declaration order, confirmed
//     against the band objects the loaded reduceCacheRetentionDay returns for a
//     synthetic two-event session;
//   - sharedAnalyticsRefusalReasons are the string literals passed to
//     `new SharedAnalyticsUnavailable(...)` anywhere in the vendored Worker
//     sources; a non-literal argument or a subclass refuses the derivation;
//   - cacheRetentionRefusalReasons are the literals passed to
//     `new CacheRetentionRefusedError(...)` in cache-retention-values.ts, the
//     module of the one cache reducer evaluateSharedCacheDay calls. The
//     derivation confirms that evaluateSharedCacheDay calls exactly that
//     reducer from the cache-retention modules, so a kernel that routes the
//     cache family through another module refuses rather than under-reports;
//   - communityDailyReadSchemaVersion is the one `schemaVersion:
//     "community-daily-read-v<major>.<minor>"` literal in the commit's
//     apps/worker/src/index.ts. index.ts is not vendored (it is the Cloudflare
//     Worker entry), so it is read from the same commit's git objects.
//
// This module is pure: it is given the lexer, esbuild and the paths it reads,
// and it imports nothing from the generator. The generator
// (vendor-analytics-kernels.mjs) writes the rendered module after it has
// verified the staged tree; vendor-analytics-kernels.check.mjs re-derives the
// sets from the committed tree and fails on any difference, and
// analytics-v2-test/kernel-vocabularies.spec.ts fails when a GCP copy differs
// from the generated module.

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VOCABULARY_SCHEMA = "analytics-kernel-vocabularies-v1";
/** Where the rendered module lives, relative to the out root (apps/worker unless a scratch root is named). */
export const VOCABULARY_RELATIVE = "src/analytics-v2/kernel-vocabularies.generated.ts";

/** The vendored and commit sources each vocabulary is derived from. */
export const VOCABULARY_SOURCES = Object.freeze({
  sharedReducers: "apps/worker/src/analytics-shared-reducers.ts",
  cacheValues: "apps/worker/src/cache-retention-values.ts",
  adminAllowance: "apps/worker/src/admin-community-allowance.ts",
  workerIndex: "apps/worker/src/index.ts",
});
const WORKER_SRC = "apps/worker/src/";
const CACHE_MODULE_PREFIX = "./cache-retention-";
const CACHE_REDUCER = Object.freeze({ name: "reduceCacheRetentionDay", module: "./cache-retention-values" });
const CACHE_EVALUATOR = "evaluateSharedCacheDay";
const COUNTER_INTERFACE = "CacheRetentionBandCounters";
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const BAND_ID = /^[a-z][a-z0-9_]{0,63}$/;
const READ_SCHEMA = /^community-daily-read-v[0-9]+\.[0-9]+$/;

export class VocabularyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The string-literal reasons passed to `new <className>(...)` in one source, in
 * order of first appearance. Every construction must pass exactly one plain
 * string literal: a variable, a template or an expression would make the set
 * open, so it refuses. A class that extends <className> refuses too.
 */
export function constructedReasons({ text, path, className, maskNonCode }) {
  const masked = maskNonCode(text);
  const name = escapeRegExp(className);
  const extended = new RegExp(`(?<![\\w$.])extends\\s+${name}(?![\\w$])`).exec(masked);
  if (extended) {
    throw new VocabularyError("VOCABULARY_REFUSAL_CLASS_EXTENDED", `${path}:${lineOf(text, extended.index)} extends ${className}`);
  }
  const reasons = [];
  for (const match of masked.matchAll(new RegExp(`(?<![\\w$.])new\\s+${name}\\s*\\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    const literal = /^\(\s*(['"])([^'"\\\n]*)\1\s*\)/.exec(text.slice(open));
    if (!literal || !REASON.test(literal[2])) {
      throw new VocabularyError("VOCABULARY_REASON_NOT_LITERAL",
        `${path}:${lineOf(text, match.index)} constructs ${className} without one plain reason literal`);
    }
    if (!reasons.includes(literal[2])) reasons.push(literal[2]);
  }
  return reasons;
}

/** The [start, end) offsets of the brace block that opens at `open` (a `{` in masked code). */
function braceBlock(masked, open, label) {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return [open + 1, index];
    }
  }
  throw new VocabularyError("VOCABULARY_SOURCE_UNPARSED", `${label} has no closing brace`);
}

/**
 * The member names of one top-level interface, in declaration order. Each
 * non-blank line of its body must be one `[readonly] name[?]: type;` member,
 * so a method, an index signature or a nested literal refuses rather than
 * being skipped.
 */
export function interfaceMembers({ text, path, name, maskNonCode }) {
  const masked = maskNonCode(text);
  const declarations = [...masked.matchAll(new RegExp(`(?<![\\w$.])interface\\s+${escapeRegExp(name)}\\s*\\{`, "g"))];
  if (declarations.length !== 1) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} declares interface ${name} ${declarations.length} times, not once`);
  }
  const [start, end] = braceBlock(masked, declarations[0].index + declarations[0][0].length - 1, `${path} interface ${name}`);
  const members = [];
  for (const line of masked.slice(start, end).split("\n")) {
    if (!line.trim()) continue;
    const member = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*[A-Za-z_$][\w$]*(?:\[\])?\s*;\s*$/.exec(line);
    if (!member) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} interface ${name} has a member this derivation cannot read: ${line.trim()}`);
    members.push(member[1]);
  }
  if (!members.length || new Set(members).size !== members.length) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} interface ${name} has no members or repeats one`);
  }
  return members;
}

/** Named value imports of one module: Map<local name, specifier>. */
function namedImports(text, masked) {
  const imports = new Map();
  // The lexer blanks the specifier string, quotes included, so read it from the source.
  for (const match of masked.matchAll(/(?<![\w$.])import\s+(?!type\b)\{([^}]*)\}\s*from(?![\w$])/g)) {
    const specifier = /^\s*(['"])([^'"]+)\1/.exec(text.slice(match.index + match[0].length));
    if (!specifier) continue;
    for (const part of match[1].split(",")) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (!words.length || words[0] === "type") continue;
      imports.set(words.length === 3 && words[1] === "as" ? words[2] : words[0], specifier[2]);
    }
  }
  return imports;
}

/**
 * The imported functions that one top-level function calls, as
 * `{ name, module }`, for imports whose specifier starts with `modulePrefix`.
 */
export function importedCallees({ text, path, functionName, modulePrefix, maskNonCode }) {
  const masked = maskNonCode(text);
  const declarations = [...masked.matchAll(new RegExp(`^(?:export\\s+)?function\\s+${escapeRegExp(functionName)}\\s*\\(`, "gm"))];
  if (declarations.length !== 1) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} declares function ${functionName} ${declarations.length} times, not once`);
  }
  // Skip the parameter list (it may hold a type literal), then take the body.
  let depth = 0;
  let index = declarations[0].index + declarations[0][0].length - 1;
  for (; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")" && --depth === 0) break;
  }
  const open = masked.indexOf("{", index);
  if (index >= masked.length || open < 0) {
    throw new VocabularyError("VOCABULARY_SOURCE_UNPARSED", `${path} function ${functionName} has no body`);
  }
  if (/[{};=]/.test(masked.slice(index + 1, open))) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} function ${functionName} has a return type this derivation cannot read`);
  }
  const [start, end] = braceBlock(masked, open, `${path} function ${functionName}`);
  const imports = namedImports(text, masked);
  const callees = [];
  for (const call of masked.slice(start, end).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const module = imports.get(call[1]);
    if (module === undefined || !module.startsWith(modulePrefix)) continue;
    if (!callees.some((callee) => callee.name === call[1])) callees.push({ name: call[1], module });
  }
  return callees;
}

/**
 * The one community daily read schema version in the commit's Worker entry: the
 * value of a `schemaVersion:` property. Every literal that starts with
 * "community-daily-read-" must be that value; two versions, or a literal in
 * another position, refuse.
 */
export function communityDailyReadSchemaVersion({ text, path }) {
  const literals = [...text.matchAll(/(['"])(community-daily-read-[^'"\n]*)\1/g)].map((match) => match[2]);
  const properties = [...text.matchAll(/\bschemaVersion\s*:\s*(['"])(community-daily-read-[^'"\n]*)\1/g)].map((match) => match[2]);
  const distinct = [...new Set(properties)];
  if (distinct.length !== 1 || literals.length !== properties.length || !READ_SCHEMA.test(distinct[0])) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED",
      `${path} must hold exactly one community-daily-read schemaVersion literal and no other; found ${JSON.stringify([...new Set(literals)])}`);
  }
  return distinct[0];
}

const snakeCase = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** A synthetic session: two readable events one minute apart, so the reducer emits one group with every band. */
function probeEvents(day) {
  const start = Date.parse(`${day}T12:00:00.000Z`);
  const event = (offsetMs, orderKey) => ({
    sessionDigest: "a".repeat(64), observedAtMs: start + offsetMs, orderKey, model: "probe-model", effort: "medium",
    speedMode: "standard", surface: "probe", cacheReadTokens: 100, uncachedTokens: 10, cacheWriteTokens: 0,
  });
  return [event(0, "0001"), event(60_000, "0002")];
}

/**
 * Bundles the named vendored modules from the tree at `vendorRoot` on their own
 * and loads them. @app-usagemonitor imports must resolve inside the tree.
 */
async function loadVendoredModules({ esbuild, vendorRoot, nodeModules, exports }) {
  const contents = Object.entries(exports)
    .map(([path, names]) => `export { ${names.join(", ")} } from ${JSON.stringify(`./${path.replace(/\.ts$/, "")}`)};`).join("\n");
  let result;
  try {
    result = await esbuild.build({
      stdin: { contents, loader: "ts", resolveDir: vendorRoot, sourcefile: "kernel-vocabularies-probe.ts" },
      bundle: true, write: false, metafile: true, platform: "node", format: "esm", target: "node22",
      mainFields: ["module", "main"], logLevel: "silent",
      plugins: [{
        name: "kernel-vocabularies-externals",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => (args.path.startsWith(".") || args.path.startsWith("/")
            || args.path.startsWith("@app-usagemonitor/") ? undefined : { path: args.path, external: true }));
        },
      }],
    });
  } catch (error) {
    throw new VocabularyError("VOCABULARY_PROBE_UNBUNDLABLE", String(error?.errors?.[0]?.text ?? error?.message ?? error));
  }
  const strays = Object.keys(result.metafile.inputs).filter((input) => /(?:^|\/)node_modules\/@app-usagemonitor\//.test(input));
  if (strays.length) throw new VocabularyError("VOCABULARY_PROBE_PACKAGE_UNVENDORED", strays.join(", "));
  const dir = mkdtempSync(join(tmpdir(), "kernel-vocabularies-"));
  try {
    symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
    const file = join(dir, "probe.mjs");
    writeFileSync(file, result.outputFiles[0].contents);
    return await import(pathToFileURL(file).href);
  } catch (error) {
    if (error instanceof VocabularyError) throw error;
    throw new VocabularyError("VOCABULARY_PROBE_UNLOADABLE", String(error?.message ?? error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Derives every vocabulary from the vendored tree at `vendorRoot` and the
 * commit's Worker entry text. `vendoredSources` lists the tree's vendored
 * Worker sources (MANIFEST.json files); `maskNonCode` is the generator's lexer.
 */
export async function deriveKernelVocabularies({ vendorRoot, sourceCommit, vendoredSources, workerIndexText, esbuild, maskNonCode, nodeModules }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) throw new VocabularyError("VOCABULARY_SOURCE_COMMIT_INVALID", String(sourceCommit));
  if (typeof workerIndexText !== "string") throw new VocabularyError("VOCABULARY_SOURCE_MISSING", VOCABULARY_SOURCES.workerIndex);
  const read = (path) => {
    try {
      return readFileSync(join(vendorRoot, path), "utf8");
    } catch {
      throw new VocabularyError("VOCABULARY_SOURCE_MISSING", path);
    }
  };
  for (const path of [VOCABULARY_SOURCES.sharedReducers, VOCABULARY_SOURCES.cacheValues, VOCABULARY_SOURCES.adminAllowance]) {
    if (!vendoredSources.includes(path)) throw new VocabularyError("VOCABULARY_SOURCE_MISSING", `${path} is not vendored`);
  }

  // Refusal reasons.
  const shared = [];
  for (const path of [...vendoredSources].filter((source) => source.startsWith(WORKER_SRC) && source.endsWith(".ts")).sort()) {
    for (const reason of constructedReasons({ text: read(path), path, className: "SharedAnalyticsUnavailable", maskNonCode })) {
      if (!shared.includes(reason)) shared.push(reason);
    }
  }
  if (!shared.length) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", "no SharedAnalyticsUnavailable reason is constructed in the vendored sources");
  const reducersText = read(VOCABULARY_SOURCES.sharedReducers);
  const callees = importedCallees({ text: reducersText, path: VOCABULARY_SOURCES.sharedReducers, functionName: CACHE_EVALUATOR,
    modulePrefix: CACHE_MODULE_PREFIX, maskNonCode });
  if (JSON.stringify(callees) !== JSON.stringify([CACHE_REDUCER])) {
    throw new VocabularyError("VOCABULARY_SOURCE_CHANGED",
      `${CACHE_EVALUATOR} calls ${JSON.stringify(callees)} from the cache-retention modules, not exactly ${CACHE_REDUCER.name}; review where the cache family's refusals come from`);
  }
  const cacheText = read(VOCABULARY_SOURCES.cacheValues);
  const cacheReasons = constructedReasons({ text: cacheText, path: VOCABULARY_SOURCES.cacheValues,
    className: "CacheRetentionRefusedError", maskNonCode });
  if (!cacheReasons.length) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${VOCABULARY_SOURCES.cacheValues} constructs no CacheRetentionRefusedError`);

  // Runtime values and the counter confirmation.
  const loaded = await loadVendoredModules({ esbuild, vendorRoot, nodeModules, exports: {
    [VOCABULARY_SOURCES.adminAllowance]: ["ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS"],
    [VOCABULARY_SOURCES.cacheValues]: ["CACHE_RETENTION_BAND_IDS", "reduceCacheRetentionDay"],
  } });
  const modelDates = loaded.ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS;
  if (!Number.isSafeInteger(modelDates) || modelDates < 1) throw new VocabularyError("VOCABULARY_VALUE_INVALID", `ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS is ${modelDates}`);
  const bandIds = loaded.CACHE_RETENTION_BAND_IDS;
  if (!Array.isArray(bandIds) || !bandIds.length || !bandIds.every((id) => typeof id === "string" && BAND_ID.test(id))
      || new Set(bandIds).size !== bandIds.length) {
    throw new VocabularyError("VOCABULARY_VALUE_INVALID", `CACHE_RETENTION_BAND_IDS is ${JSON.stringify(bandIds)}`);
  }
  const members = interfaceMembers({ text: cacheText, path: VOCABULARY_SOURCES.cacheValues, name: COUNTER_INTERFACE, maskNonCode });
  if (members[0] !== "band") throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${COUNTER_INTERFACE} no longer starts with its band id`);
  const counters = members.slice(1);
  let aggregate;
  try {
    aggregate = loaded.reduceCacheRetentionDay({ day: "2026-01-02", events: probeEvents("2026-01-02"), carry: [], eventsRead: 2 });
  } catch (error) {
    throw new VocabularyError("VOCABULARY_PROBE_REFUSED", `reduceCacheRetentionDay refused the synthetic session: ${String(error?.message ?? error)}`);
  }
  const bands = aggregate?.groups?.[0]?.bands;
  if (!Array.isArray(bands) || bands.length !== bandIds.length || bands.some((band, index) => band.band !== bandIds[index])) {
    throw new VocabularyError("VOCABULARY_PROBE_REFUSED", "the synthetic session did not yield one group with every band in order");
  }
  for (const band of bands) {
    const keys = Object.keys(band).filter((key) => key !== "band").sort();
    if (keys.join(",") !== [...counters].sort().join(",")) {
      throw new VocabularyError("VOCABULARY_COUNTERS_DISAGREE",
        `${COUNTER_INTERFACE} declares ${counters.join(", ")} but the reducer's bands carry ${keys.join(", ")}`);
    }
  }

  return Object.freeze({
    schemaVersion: VOCABULARY_SCHEMA,
    sourceCommit,
    modelDates,
    sharedAnalyticsRefusalReasons: Object.freeze(shared),
    cacheRetentionRefusalReasons: Object.freeze(cacheReasons),
    cacheRetentionBandIds: Object.freeze([...bandIds]),
    cacheBandCounters: Object.freeze(counters.map(snakeCase)),
    communityDailyReadSchemaVersion: communityDailyReadSchemaVersion({ text: workerIndexText, path: VOCABULARY_SOURCES.workerIndex }),
  });
}

const list = (values) => `Object.freeze([\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n] as const)`;

/** The generated module's text: deterministic, one `export const` block per vocabulary, separated by blank lines. */
export function renderKernelVocabularies(vocabularies) {
  const v = vocabularies;
  if (v?.schemaVersion !== VOCABULARY_SCHEMA) throw new VocabularyError("VOCABULARY_SCHEMA_UNKNOWN", String(v?.schemaVersion));
  return [
    "// GENERATED FILE. Do not edit by hand.",
    "//",
    "// The GCP-only vocabularies, derived from the analytics kernels vendored at the",
    "// commit below by apps/worker/scripts/analytics-kernel-vocabularies.mjs and",
    "// written by apps/worker/scripts/vendor-analytics-kernels.mjs whenever it",
    "// vendors. apps/worker/scripts/vendor-analytics-kernels.check.mjs fails when",
    "// this file differs from what the vendored tree gives, and",
    "// analytics-v2-test/kernel-vocabularies.spec.ts fails when a GCP copy (the",
    "// analytics-v2 contract or the primary 0059 CHECK sets) differs from it.",
    `// Schema: ${VOCABULARY_SCHEMA}.`,
    "",
    "/** The production commit the vocabularies were derived from (MANIFEST.json sourceCommit). */",
    `export const KERNEL_VOCABULARIES_SOURCE_COMMIT = ${JSON.stringify(v.sourceCommit)} as const;`,
    "",
    "/** Model history dates in the allowance preview: admin-community-allowance.ts ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS. */",
    `export const KERNEL_MODEL_DATES = ${v.modelDates} as const;`,
    "",
    "/** Every reason the vendored Worker sources construct a SharedAnalyticsUnavailable with, in order of first appearance. */",
    `export const KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS = ${list(v.sharedAnalyticsRefusalReasons)};`,
    "",
    "/**",
    " * The CacheRetentionRefusedError reasons cache-retention-values.ts constructs: the module of",
    " * reduceCacheRetentionDay, the one cache reducer evaluateSharedCacheDay calls.",
    " */",
    `export const KERNEL_CACHE_RETENTION_REFUSAL_REASONS = ${list(v.cacheRetentionRefusalReasons)};`,
    "",
    "/** The cache continuity bands, in order: cache-retention-values.ts CACHE_RETENTION_BAND_IDS. */",
    `export const KERNEL_CACHE_RETENTION_BAND_IDS = ${list(v.cacheRetentionBandIds)};`,
    "",
    "/** The band counters in CacheRetentionBandCounters declaration order, snake_cased as the stored columns are. */",
    `export const KERNEL_CACHE_BAND_COUNTERS = ${list(v.cacheBandCounters)};`,
    "",
    "/** The community daily read's schemaVersion in the commit's apps/worker/src/index.ts (not vendored). */",
    `export const KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION = ${JSON.stringify(v.communityDailyReadSchemaVersion)} as const;`,
    "",
  ].join("\n");
}

/** The rendered module's blocks by exported name, for a review-sized difference between two renderings. */
export function vocabularyBlocks(text) {
  const blocks = new Map();
  for (const block of text.split("\n\n")) {
    const name = /export const ([A-Z_]+) =/.exec(block)?.[1];
    if (name) blocks.set(name, block);
  }
  return blocks;
}

/** Exported names whose blocks differ between two renderings (the source commit line aside). */
export function changedVocabularies(before, after) {
  const left = vocabularyBlocks(before);
  const right = vocabularyBlocks(after);
  return [...new Set([...left.keys(), ...right.keys()])].sort()
    .filter((name) => name !== "KERNEL_VOCABULARIES_SOURCE_COMMIT" && left.get(name) !== right.get(name));
}
