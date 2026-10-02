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
//     sources;
//   - cacheRetentionRefusalReasons are the literals passed to
//     `new CacheRetentionRefusedError(...)` in the vendored code the reviewed
//     facade (entry.ts) reaches: the constructions that survive in the facade's
//     tree-shaken bundle. That follows every call path, however many modules
//     it crosses, and leaves out the D1 day lanes the facade never reaches;
//   - for both classes every source must name the class only by
//     `new <class>(<one plain literal>)`, `instanceof <class>`, its one
//     declaration in its defining module, or a plain unaliased import. An
//     alias, a member or value reference, a re-export, a subclass, or a
//     namespace, star or dynamic import of the defining module could construct
//     the class under another name, so each refuses rather than under-reports;
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
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const VOCABULARY_SCHEMA = "analytics-kernel-vocabularies-v1";
/** Where the rendered module lives, relative to the out root (apps/worker unless a scratch root is named). */
export const VOCABULARY_RELATIVE = "src/analytics-v2/kernel-vocabularies.generated.ts";

/** The vendored and commit sources each vocabulary is derived from. */
export const VOCABULARY_SOURCES = Object.freeze({
  facade: "entry.ts",
  sharedReducers: "apps/worker/src/analytics-shared-reducers.ts",
  cacheValues: "apps/worker/src/cache-retention-values.ts",
  adminAllowance: "apps/worker/src/admin-community-allowance.ts",
  workerIndex: "apps/worker/src/index.ts",
});
/** Each refusal class and the vendored module that declares it. */
export const REFUSAL_CLASSES = Object.freeze({
  shared: Object.freeze({ className: "SharedAnalyticsUnavailable", definingPath: VOCABULARY_SOURCES.sharedReducers }),
  cache: Object.freeze({ className: "CacheRetentionRefusedError", definingPath: VOCABULARY_SOURCES.cacheValues }),
});
const WORKER_SRC = "apps/worker/src/";
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

/** One plain string literal as the only constructor argument, at the start of `rest`. */
const REASON_ARGUMENT = /^\s*\(\s*(['"])([^'"\\\n]*)\1\s*\)/;
/** The literal module specifier at the start of `rest`, or null. */
const specifierAt = (rest) => /^\s*(['"])([^'"\n]+)\1/.exec(rest)?.[2] ?? null;

/** Whether a relative specifier written in the module at `path` names the module at `target`. */
function resolvesTo(path, specifier, target) {
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.[cm]?[jt]s$/, "");
  const wanted = target.replace(/\.ts$/, "");
  return resolved === wanted || `${resolved}/index` === wanted;
}

/**
 * The brace clauses of a module's import and export statements
 * (`import [type] [Default,] { ... } from` and `export [type] { ... } [from]`):
 * the offsets of their braces, their kind, and whether an export clause
 * re-exports from another module.
 */
function braceClauses(masked) {
  const clauses = [];
  for (const match of masked.matchAll(/(?<![\w$.])(import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^{}]*)\}/g)) {
    const close = match.index + match[0].length - 1;
    clauses.push({ kind: match[1], open: close - match[2].length - 1, close,
      reexport: match[1] === "export" && /^\s*from(?![\w$])/.test(masked.slice(close + 1)) });
  }
  return clauses;
}

/** Statements that load a whole module, each of which could reach a class by any name. */
const MODULE_LOADS = Object.freeze([
  [/(?<![\w$.])import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+[A-Za-z_$][\w$]*\s*from(?![\w$])/g, (module) => `imports ${module} as a namespace`],
  [/(?<![\w$.])export\s+(?:type\s+)?\*(?:\s*as\s+[A-Za-z_$][\w$]*)?\s*from(?![\w$])/g, (module) => `re-exports ${module} with export *`],
  [/(?<![\w$.])import\s*\(/g, (module) => `imports ${module} dynamically`],
]);

/**
 * The string-literal reasons passed to `new <className>(...)` in one source, in
 * order of first appearance.
 *
 * Every construction must pass exactly one plain string literal: a variable, a
 * template or an expression would make the set open, so it refuses. And the
 * source may name the class in only four ways: `new <className>(...)`,
 * `instanceof <className>`, its one declaration (in `definingPath` only, and
 * there exactly once), and a plain name in an import clause, or in a local
 * export clause of the defining module. Anything else could construct the class
 * under a name this scan does not read, so it refuses: a subclass
 * (VOCABULARY_REFUSAL_CLASS_EXTENDED); an alias in an import or export clause,
 * a re-export, a member reference (`ns.<className>`), a value use
 * (`const X = <className>`, `f(<className>)`), or a namespace, `export *` or
 * dynamic import of the defining module, or a dynamic import of a computed
 * module (VOCABULARY_REFUSAL_CLASS_ALIASED).
 */
export function constructedReasons({ text, path, className, definingPath, maskNonCode }) {
  if (typeof definingPath !== "string" || !definingPath) throw new VocabularyError("VOCABULARY_SOURCE_MISSING", `no defining module for ${className}`);
  const masked = maskNonCode(text);
  const name = escapeRegExp(className);
  const defining = path === definingPath;
  const at = (index) => `${path}:${lineOf(text, index)}`;
  const aliased = (index, detail) => new VocabularyError("VOCABULARY_REFUSAL_CLASS_ALIASED", `${at(index)} ${detail}`);

  for (const [pattern, what] of MODULE_LOADS) {
    for (const match of masked.matchAll(pattern)) {
      const specifier = specifierAt(text.slice(match.index + match[0].length));
      if (specifier === null) throw aliased(match.index, `loads a computed module, which could reach ${className}`);
      if (resolvesTo(path, specifier, definingPath)) throw aliased(match.index, `${what(specifier)}, the module that declares ${className}`);
    }
  }

  const clauses = braceClauses(masked);
  const reasons = [];
  let declarations = 0;
  for (const match of masked.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))) {
    const index = match.index;
    const end = index + match[0].length;
    const clause = clauses.find((candidate) => candidate.open < index && index < candidate.close);
    if (clause) {
      const start = Math.max(masked.lastIndexOf(",", index), clause.open) + 1;
      const comma = masked.indexOf(",", end);
      const words = masked.slice(start, comma < 0 || comma > clause.close ? clause.close : comma).trim().split(/\s+/);
      if (words.length > 1 && words[0] === "type") words.shift();
      if (words.length !== 1) throw aliased(index, `renames ${className} in an ${clause.kind} clause`);
      if (clause.kind === "export" && (!defining || clause.reexport)) throw aliased(index, `re-exports ${className}, which only ${definingPath} may export`);
      continue;
    }
    const before = masked.slice(Math.max(0, index - 80), index);
    if (/\.\s*$/.test(before)) throw aliased(index, `refers to ${className} as a member`);
    if (/(?<![\w$.])extends\s+$/.test(before)) throw new VocabularyError("VOCABULARY_REFUSAL_CLASS_EXTENDED", `${at(index)} extends ${className}`);
    if (/(?<![\w$.])class\s+$/.test(before)) {
      if (!defining) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${at(index)} declares another class named ${className}; ${definingPath} declares it`);
      declarations += 1;
      continue;
    }
    if (/(?<![\w$.])instanceof\s+$/.test(before) && !/^\s*[.[(]/.test(masked.slice(end))) continue;
    if (/(?<![\w$.])new\s+$/.test(before)) {
      const literal = REASON_ARGUMENT.exec(text.slice(end));
      if (!literal || !REASON.test(literal[2])) {
        throw new VocabularyError("VOCABULARY_REASON_NOT_LITERAL", `${at(index)} constructs ${className} without one plain reason literal`);
      }
      if (!reasons.includes(literal[2])) reasons.push(literal[2]);
      continue;
    }
    throw aliased(index, `refers to ${className} other than by new, instanceof, its declaration or a plain import`);
  }
  if (defining && declarations !== 1) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `${path} declares class ${className} ${declarations} times, not once`);
  return reasons;
}

/**
 * The reasons `new <className>(...)` is given in a bundle's output, in order of
 * first appearance: the constructions the bundle's entry can reach. The bundler
 * drops only code it can prove nothing reachable references, so this errs
 * towards more reasons, never fewer. Run it only over sources that
 * constructedReasons accepted, so the bundle names the class only as itself
 * (the bundler resolves import names to the declared one). A bundler-renamed
 * copy (`<className>2`) would hide constructions, so it refuses.
 */
export function bundledConstructedReasons({ text, className, maskNonCode }) {
  const masked = maskNonCode(text);
  const name = escapeRegExp(className);
  const renamed = new RegExp(`(?<![\\w$])${name}\\d+(?![\\w$])`).exec(masked);
  if (renamed) throw new VocabularyError("VOCABULARY_PROBE_RENAMED", `the bundle renames ${className} to ${renamed[0]}`);
  const reasons = [];
  for (const match of masked.matchAll(new RegExp(`(?<![\\w$.])new\\s+${name}(?![\\w$])`, "g"))) {
    const literal = REASON_ARGUMENT.exec(text.slice(match.index + match[0].length));
    if (!literal || !REASON.test(literal[2])) {
      throw new VocabularyError("VOCABULARY_REASON_NOT_LITERAL", `the bundle constructs ${className} without one plain reason literal`);
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
 * Bundles `contents` (an entry that re-exports vendored modules) from the tree
 * at `vendorRoot` on its own, with tree shaking, and returns the output text.
 * @app-usagemonitor imports must resolve inside the tree.
 */
async function bundleVendored({ esbuild, vendorRoot, contents, sourcefile }) {
  let result;
  try {
    result = await esbuild.build({
      stdin: { contents, loader: "ts", resolveDir: vendorRoot, sourcefile },
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
  return result.outputFiles[0].text;
}

const reexport = (path, names) => `export ${names ? `{ ${names.join(", ")} }` : "*"} from ${JSON.stringify(`./${path.replace(/\.ts$/, "")}`)};`;

/** Bundles the named vendored modules on their own and loads them. */
async function loadVendoredModules({ esbuild, vendorRoot, nodeModules, exports }) {
  const code = await bundleVendored({ esbuild, vendorRoot, sourcefile: "kernel-vocabularies-probe.ts",
    contents: Object.entries(exports).map(([path, names]) => reexport(path, names)).join("\n") });
  const dir = mkdtempSync(join(tmpdir(), "kernel-vocabularies-"));
  try {
    symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
    const file = join(dir, "probe.mjs");
    writeFileSync(file, code);
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

  // Refusal reasons: every construction in the vendored Worker sources, each
  // source naming the class only in the forms constructedReasons reads.
  const workerSources = [...vendoredSources].filter((source) => source.startsWith(WORKER_SRC) && source.endsWith(".ts")).sort();
  const reasonsOf = ({ className, definingPath }) => {
    const reasons = [];
    for (const path of workerSources) {
      for (const reason of constructedReasons({ text: read(path), path, className, definingPath, maskNonCode })) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }
    return reasons;
  };
  const shared = reasonsOf(REFUSAL_CLASSES.shared);
  if (!shared.length) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `no ${REFUSAL_CLASSES.shared.className} reason is constructed in the vendored sources`);
  // The cache family is what the facade can reach: the vendored D1 day lanes
  // construct further reasons that the GCP path never runs.
  const cacheClass = REFUSAL_CLASSES.cache.className;
  const cacheConstructed = reasonsOf(REFUSAL_CLASSES.cache);
  const reachable = bundledConstructedReasons({ className: cacheClass, maskNonCode,
    text: await bundleVendored({ esbuild, vendorRoot, sourcefile: "kernel-vocabularies-facade.ts", contents: reexport(VOCABULARY_SOURCES.facade) }) });
  const unread = reachable.filter((reason) => !cacheConstructed.includes(reason));
  if (unread.length) {
    throw new VocabularyError("VOCABULARY_PROBE_DISAGREES", `the facade bundle constructs ${cacheClass} with ${unread.join(", ")}, which no vendored source does`);
  }
  const cacheReasons = cacheConstructed.filter((reason) => reachable.includes(reason));
  if (!cacheReasons.length) throw new VocabularyError("VOCABULARY_SOURCE_CHANGED", `the facade reaches no ${cacheClass} construction`);
  const cacheText = read(VOCABULARY_SOURCES.cacheValues);

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
    " * The CacheRetentionRefusedError reasons constructed by the vendored code the reviewed facade",
    " * (entry.ts) reaches, in vendored source order: the constructions left in its tree-shaken bundle.",
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
