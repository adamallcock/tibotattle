/**
 * W1E: the pricing class's pricer (cloud-run/analytics-kernel-closure.mjs,
 * refresh optimization program 2026-10-03 section 3.2.1, rank 4).
 *
 * A row's price is cached under its pricing class (pricer_sha256, the pricing
 * method version, the price-input projection version, cards_sha256), so the
 * pricer digest must cover every input of a price (under-inclusion would
 * serve stale prices) and nothing else (over-inclusion only costs a full
 * reprice per kernel bump). This check proves:
 *
 * - the pricer is computed by the build, is a subset of the compute closure,
 *   and is stamped into a bundle (kernel.ts analyticsV2BundledPricer);
 * - its inputs are exactly PRICER_INPUTS: a change to the pricer's module
 *   set (the pure pass's metafile) fails here until reviewed (the digest
 *   moves with it either way; the class is never hand-listed);
 * - an edit of any pricing input, or of an unbundled file of a third-party
 *   pricing package, changes the class (negative tests against the metafile);
 * - an edit of non-pricing kernel code (the compute core, the reader, the
 *   d1/d5 SOURCE_PATCH targets, the hashing helpers) changes the compute
 *   closure but not the class, and so does a re-vendor that moves only the
 *   facade's provenance commit;
 * - nothing the pure (side-effect-free) pass drops can affect a price: every
 *   module it drops runs, at the top level, only declarations whose
 *   initializers call builtins or reviewed calls (REVIEWED_FOREIGN_CALLS)
 *   and write only their own bindings; and the pure bundle prices a
 *   synthetic battery exactly as the full module graph does, the battery
 *   selecting every card the projection can select;
 * - the pass refuses a pricer that reaches a dynamic import or an input
 *   outside the closure.
 *
 * Synthetic inputs only; the bundles are written under
 * node_modules/.cache (ignored) so their externals resolve, and removed.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import {
  ANALYTICS_KERNEL_REGISTRY_MODULE,
  ANALYTICS_PRICER_ENTRY,
  analyticsKernelDefines,
  analyticsPricerBundleOptions,
  computeAnalyticsKernelIdentity,
} from "../cloud-run/analytics-kernel-closure.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const CLOUD_RUN = join(WORKER_ROOT, "cloud-run");
const VENDOR_ROOT = join(WORKER_ROOT, "vendor", "analytics-d43c8f92");
const VENDORED = "apps/worker/vendor/analytics-d43c8f92";
/** cloud-run/build.mjs's options, as far as they decide the bundles' import graph. */
const BUILD_OPTIONS = Object.freeze({ bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"], logLevel: "silent" });
/**
 * The pricer's inputs (closure names; a third-party package by name and
 * version). A change needs review here: name what the new input prices, or
 * why an input left. The digest itself is never pinned.
 */
const PRICER_INPUTS = Object.freeze([
  "apps/worker/src/analytics-v2/price-attribution.ts",
  `${VENDORED}/apps/worker/src/model-history-window.ts`,
  `${VENDORED}/apps/worker/src/quota-analysis-v1-reader.ts`,
  `${VENDORED}/apps/worker/src/quota-analysis-v1.ts`,
  `${VENDORED}/apps/worker/src/server-pricing.ts`,
  `${VENDORED}/apps/worker/src/stored-record.ts`,
  `${VENDORED}/apps/worker/src/telemetry-v1-source-selection.ts`,
  `${VENDORED}/packages/accounting/src/cost-ledger.js`,
  `${VENDORED}/packages/accounting/src/price-registry.js`,
  `${VENDORED}/packages/accounting/src/subscription-speed.js`,
  `${VENDORED}/packages/quota-analysis/src/plan-attribution.js`,
  `${VENDORED}/packages/quota-analysis/src/quota-calibration.js`,
  `${VENDORED}/packages/quota-analysis/src/quota-windows.js`,
  `${VENDORED}/packages/telemetry-contract/src/constants.js`,
  `${VENDORED}/packages/telemetry-contract/src/model-catalog.js`,
  "npm:runcost@0.2.1",
]);
/**
 * Global callees a dropped module's top-level code may call: constructors
 * and functions that read their arguments and return a new value.
 */
const PURE_GLOBAL_CALLS = new Set(["Object.freeze", "Object.fromEntries", "Object.keys", "Object.values",
  "Object.entries", "Array.from", "Array.isArray", "Set", "Map", "WeakMap", "RegExp", "String", "Number", "BigInt",
  "JSON.stringify", "Math.ceil", "Math.floor", "Math.max", "Math.min", "TextEncoder", "TextDecoder"]);
/** Array and string methods that only read their receiver and return a new value. */
const PURE_METHODS = new Set(["filter", "map", "flatMap", "join", "concat", "slice", "includes", "some", "every",
  "reduce", "toSorted", "replace", "replaceAll", "trim", "split", "padStart", "toLowerCase", "toUpperCase"]);
/** Methods that mutate their receiver: allowed only on the module's own binding (its own array, set or map). */
const OWN_MUTATING_METHODS = new Set(["push", "unshift", "add", "set", "sort"]);
/**
 * Top-level calls of a dropped module into ANOTHER module's function,
 * reviewed as reads that cannot change a price (module: callee source).
 * - communityAnalysisCacheVersion builds a version string from constants.
 */
const REVIEWED_FOREIGN_CALLS = Object.freeze({
  [`${VENDORED}/apps/worker/src/storage-community-graph.ts`]: ["communityAnalysisCacheVersion"],
});

const require = createRequire(join(CLOUD_RUN, "package.json"));
const esbuild = () => require("esbuild");
const sha256Names = (identity) => [...identity.pricerNames];

async function identityWith(read, build = esbuild().build) {
  return computeAnalyticsKernelIdentity({ build, options: BUILD_OPTIONS, vendorRoot: VENDOR_ROOT, cwd: CLOUD_RUN,
    ...(read === undefined ? {} : { read }) });
}

/** The identity with one comment line appended to `target` (an absolute path). */
function mutatedAt(target) {
  return identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    return path === target ? Buffer.concat([Buffer.from(bytes), Buffer.from("\n// mutation\n")]) : bytes;
  });
}

const baseline = await identityWith();

test("the build computes the pricer from a pure pass, inside the compute closure, and stamps it", async () => {
  assert.match(baseline.pricerSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(baseline.pricerSha256, baseline.computeSha256);
  // The same inputs every time (no ordering or environment dependence).
  assert.equal((await identityWith()).pricerSha256, baseline.pricerSha256);
  const pricing = await readFile(join(VENDOR_ROOT, "apps", "worker", "src", "server-pricing.ts"), "utf8");
  assert.equal(baseline.pricingMethodVersion,
    /export const SERVER_PRICING_METHOD_VERSION = "([^"]+)";/u.exec(pricing)?.[1]);
  if (JSON.stringify(sha256Names(baseline)) !== JSON.stringify(PRICER_INPUTS)) {
    assert.fail(`the pricer's inputs changed: review them and update PRICER_INPUTS.\n${baseline.pricerNames.join("\n")}`);
  }
  assert.equal(baseline.pricerInputs, PRICER_INPUTS.length);
  // Every pricer input is a closure input (a package by each bundled file), so the registry entry pins the class.
  const closure = new Set(baseline.names);
  for (const name of baseline.pricerNames) {
    if (name.startsWith("npm:")) assert.ok(baseline.names.some((input) => input.startsWith(`${name}/`)), name);
    else assert.ok(closure.has(name), name);
  }
  // Non-pricing kernel code and the hashing helpers stay out.
  for (const outside of ["apps/worker/src/analytics-v2/compute-owner.ts", "apps/worker/src/crypto.ts",
    "apps/worker/src/canonical-json.ts", `${VENDORED}/entry.ts`, `${VENDORED}/apps/worker/src/quota-analysis-v11.ts`,
    `${VENDORED}/apps/worker/src/v11-daily-projection-values.ts`]) {
    assert.equal(baseline.pricerNames.includes(outside), false, outside);
    assert.ok(closure.has(outside), `${outside} is a closure input`);
  }
  // The defines stamp it, and kernel.ts reads it back (the Job's own module, bundled as the build resolves it).
  const defines = analyticsKernelDefines(baseline);
  const result = await esbuild().build({ ...BUILD_OPTIONS, absWorkingDir: CLOUD_RUN,
    entryPoints: [ANALYTICS_KERNEL_REGISTRY_MODULE], write: false, external: [], mainFields: ["module", "main"],
    format: "iife", globalName: "analyticsV2Kernel", define: defines });
  const context = { TextEncoder, TextDecoder, crypto: globalThis.crypto };
  new Script(result.outputFiles[0].text).runInNewContext(context);
  assert.deepEqual({ ...context.analyticsV2Kernel.analyticsV2BundledPricer() },
    { pricerSha256: baseline.pricerSha256, pricingMethodVersion: baseline.pricingMethodVersion });
  const identity = context.analyticsV2Kernel.analyticsV2BundledKernelIdentity();
  assert.equal(identity.pricerSha256, baseline.pricerSha256);
  // An identity without a pricer stamps none: an unknown class.
  const unstamped = analyticsKernelDefines({ ...baseline, pricerSha256: undefined, pricingMethodVersion: undefined });
  const bare = await esbuild().build({ ...BUILD_OPTIONS, absWorkingDir: CLOUD_RUN,
    entryPoints: [ANALYTICS_KERNEL_REGISTRY_MODULE], write: false, external: [], mainFields: ["module", "main"],
    format: "iife", globalName: "analyticsV2Kernel", define: unstamped });
  const bareContext = { TextEncoder, TextDecoder, crypto: globalThis.crypto };
  new Script(bare.outputFiles[0].text).runInNewContext(bareContext);
  assert.equal(bareContext.analyticsV2Kernel.analyticsV2BundledPricer(), null);
});

test("an edit of any pricing input changes the pricing class (negative tests against the pricer metafile)", async () => {
  const runcost = join(WORKER_ROOT, "node_modules", "runcost");
  const targets = [
    ...PRICER_INPUTS.filter((name) => !name.startsWith("npm:")).map((name) => join(REPOSITORY_ROOT, ...name.split("/"))),
    // The bundled file of the third-party pricer package, and one it installs but the bundle does not use.
    join(runcost, "browser.js"), join(runcost, "README.md"),
  ];
  for (const target of targets) {
    const mutated = await mutatedAt(target);
    assert.notEqual(mutated.pricerSha256, baseline.pricerSha256, target);
  }
  // The pricing method version is read from the pricer's own source.
  const pricing = join(VENDOR_ROOT, "apps", "worker", "src", "server-pricing.ts");
  const renamed = await identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    return path === pricing ? Buffer.from(Buffer.from(bytes).toString("utf8")
      .replace("server-api-price-equivalent-v0.5", "server-api-price-equivalent-v0.6"), "utf8") : bytes;
  });
  assert.equal(renamed.pricingMethodVersion, "server-api-price-equivalent-v0.6");
  assert.notEqual(renamed.pricerSha256, baseline.pricerSha256);
});

test("a non-pricing kernel edit keeps the pricing class and moves the compute closure", async () => {
  for (const target of [
    join(WORKER_ROOT, "src", "analytics-v2", "compute-owner.ts"),
    join(WORKER_ROOT, "src", "analytics-v2", "occurrence-source.ts"),
    join(WORKER_ROOT, "src", "analytics-v2", "native-path.ts"),
    join(WORKER_ROOT, "src", "crypto.ts"),
    // d1's and d5's SOURCE_PATCH targets.
    join(VENDOR_ROOT, "apps", "worker", "src", "quota-analysis-v11.ts"),
    join(VENDOR_ROOT, "apps", "worker", "src", "v11-daily-projection-values.ts"),
    join(VENDOR_ROOT, "apps", "worker", "src", "effective-usage-day.ts"),
    join(VENDOR_ROOT, "entry.ts"),
  ]) {
    const mutated = await mutatedAt(target);
    assert.notEqual(mutated.computeClosureSha256, baseline.computeClosureSha256, target);
    assert.equal(mutated.pricerSha256, baseline.pricerSha256, target);
  }
  // A re-vendor that moves only the provenance commit keeps it too.
  const manifestFile = join(VENDOR_ROOT, "MANIFEST.json");
  const current = JSON.parse(await readFile(manifestFile, "utf8")).sourceCommit;
  const next = "0123456789abcdef0123456789abcdef01234567";
  const moved = await identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    if (path === manifestFile) {
      return Buffer.from(`${JSON.stringify({ ...JSON.parse(Buffer.from(bytes).toString("utf8")), sourceCommit: next }, null, 2)}\n`);
    }
    if (path === join(VENDOR_ROOT, "entry.ts")) {
      return Buffer.from(Buffer.from(bytes).toString("utf8").replaceAll(current.slice(0, 8), next.slice(0, 8)));
    }
    return bytes;
  });
  assert.notEqual(moved.computeClosureSha256, baseline.computeClosureSha256);
  assert.equal(moved.pricerSha256, baseline.pricerSha256);
});

/** The pricer bundle under the build's options: `pure` (the class's pass) or the module graph's real semantics. */
async function pricerBundle(pure) {
  return esbuild().build(analyticsPricerBundleOptions({ options: BUILD_OPTIONS, vendorRoot: VENDOR_ROOT, cwd: CLOUD_RUN,
    pure }));
}

const inputsWithBytes = (result) => new Set(Object.entries(Object.values(result.metafile.outputs)[0].inputs)
  .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => resolve(CLOUD_RUN, path)));

const { parseAst } = await import(pathToFileURL(createRequire(join(WORKER_ROOT, "package.json"))
  .resolve("rolldown/parseAst")).href);

/**
 * Audit the top-level code of the `dropped` modules in an esbuild bundle
 * `text` (each module's code follows a `// <path relative to cloud-run>`
 * line): the findings, and how many statements were audited.
 */
function auditDroppedTopLevel(text, dropped) {
  const marks = [...text.matchAll(/^\/\/ (\S+)$/gmu)]
    .map((match) => [match.index, resolve(CLOUD_RUN, match[1]).slice(REPOSITORY_ROOT.length + 1)]);
  const moduleAt = (position) => {
    let current = null;
    for (const [index, module] of marks) {
      if (index > position) break;
      current = module;
    }
    return current;
  };
  const program = parseAst(text);
  const declaredIn = new Map();
  const declare = (name, module) => declaredIn.set(name, module);
  for (const statement of program.body) {
    const module = moduleAt(statement.start);
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) if (declaration.id.type === "Identifier") declare(declaration.id.name, module);
    } else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) {
      declare(statement.id.name, module);
    }
  }
  const source = (node) => text.slice(node.start, node.end);
  const rootOf = (node) => {
    let current = node;
    while (current?.type === "MemberExpression" || current?.type === "ChainExpression") current = current.object ?? current.expression;
    return current?.type === "Identifier" ? current.name : null;
  };
  const findings = [];
  const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);
  // Visit what a top-level statement executes when the module initializes.
  const visit = (node, module, locals) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    // A stored function runs only when called (by a module the pure pass keeps, which then reaches it).
    if (FUNCTIONS.has(node.type) || node.type === "MethodDefinition") return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") locals.add(node.id.name);
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee;
      const root = rootOf(callee);
      const owner = root === null ? null : declaredIn.get(root) ?? null;
      const text = source(callee);
      const method = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
      const ownValue = root !== null && (owner === module || locals.has(root));
      const literal = callee.type === "MemberExpression" && ["ArrayExpression", "Literal", "TemplateLiteral"]
        .includes(callee.object.type);
      const fresh = callee.type === "MemberExpression" && ["CallExpression", "NewExpression"].includes(callee.object.type);
      const allowed = PURE_GLOBAL_CALLS.has(text) && owner === null
        || (method !== null && PURE_METHODS.has(method) && (literal || fresh || ownValue || owner !== null))
        || (method !== null && OWN_MUTATING_METHODS.has(method)
          && ((callee.object.type === "Identifier" && ownValue) || literal || fresh))
        || (owner === module && callee.type === "Identifier")
        || (REVIEWED_FOREIGN_CALLS[module] ?? []).includes(text);
      if (!allowed) findings.push(`${module}: calls ${text.slice(0, 80)}`);
      // Arguments run now, callbacks included.
      for (const argument of node.arguments) {
        if (FUNCTIONS.has(argument.type)) visit(argument.body, module, new Set([...locals,
          ...argument.params.filter((param) => param.type === "Identifier").map((param) => param.name)]));
        else visit(argument, module, locals);
      }
      if (callee.type === "MemberExpression") visit(callee.object, module, locals);
      return;
    }
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression"
        || (node.type === "UnaryExpression" && node.operator === "delete")) {
      const target = node.left ?? node.argument;
      const root = rootOf(target);
      if (root === null || (declaredIn.get(root) !== module && !locals.has(root))) {
        findings.push(`${module}: writes ${source(target).slice(0, 80)}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) for (const child of value) visit(child, module, locals);
      else visit(value, module, locals);
    }
  };
  const DECLARATIONS = new Set(["VariableDeclaration", "FunctionDeclaration", "ClassDeclaration", "ImportDeclaration",
    "ExportNamedDeclaration", "ForStatement", "ForOfStatement", "EmptyStatement"]);
  let audited = 0;
  for (const statement of program.body) {
    const module = moduleAt(statement.start);
    if (module === null || !dropped.has(module)) continue;
    audited += 1;
    if (!DECLARATIONS.has(statement.type)) findings.push(`${module}: runs a ${statement.type}`);
    if (statement.type === "ClassDeclaration" && statement.body.body.some((member) => member.static
        || member.type === "StaticBlock")) {
      findings.push(`${module}: a class with static initialization`);
    }
    visit(statement, module, new Set());
  }
  return { findings: [...new Set(findings)], audited };
}

test("nothing the pure pass drops runs top-level code that could change a price", async () => {
  const [pure, real] = await Promise.all([pricerBundle(true), pricerBundle(false)]);
  const kept = inputsWithBytes(pure);
  const dropped = new Set([...inputsWithBytes(real)].filter((path) => !kept.has(path))
    .map((path) => resolve(path).slice(REPOSITORY_ROOT.length + 1)));
  assert.ok(dropped.size > 50, "the real graph keeps the facade's other modules for their top-level code");
  const { findings, audited } = auditDroppedTopLevel(real.outputFiles[0].text, dropped);
  assert.ok(audited > 100, "the dropped modules' top-level statements were audited");
  assert.deepEqual(findings, [], "a dropped module's top-level code could change a price");
});

test("the audit finds a dropped module that writes, or calls into, another module's state", () => {
  const kept = "apps/worker/src/synthetic-kept.ts";
  const dropped = "apps/worker/src/synthetic-dropped.ts";
  const text = [
    `// ../src/synthetic-kept.ts`,
    `var PRICES = {};`,
    `function registerPrice(name) { PRICES[name] = 1; }`,
    `// ../src/synthetic-dropped.ts`,
    `var OWN = [];`,
    `OWN.push(1);`,
    `var COPY = Object.freeze(OWN.map((value) => value));`,
    `PRICES.gpt = 2;`,
    `var REGISTERED = registerPrice("gpt");`,
    `[1].forEach(() => { PRICES.other = 3; });`,
    `class Late { static seed = registerPrice("late"); }`,
  ].join("\n");
  const { findings } = auditDroppedTopLevel(text, new Set([dropped]));
  assert.deepEqual(findings, [
    `${dropped}: runs a ExpressionStatement`,
    `${dropped}: writes PRICES.gpt`,
    `${dropped}: calls registerPrice`,
    `${dropped}: calls [1].forEach`,
    `${dropped}: writes PRICES.other`,
    `${dropped}: a class with static initialization`,
  ]);
  // The kept module is not audited: its code is in the pricer.
  assert.equal(findings.some((finding) => finding.startsWith(kept)), false);
});

test("the pure pricer prices a battery selecting every reachable card exactly as the full module graph", async () => {
  const cache = join(WORKER_ROOT, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "analytics-v2-pricing-class-check-"));
  try {
    const modules = {};
    for (const [label, pure] of [["pure", true], ["real", false]]) {
      const file = join(directory, `${label}.mjs`);
      await writeFile(file, (await pricerBundle(pure)).outputFiles[0].text);
      modules[label] = await import(pathToFileURL(file).href);
    }
    for (const { exports } of ANALYTICS_PRICER_ENTRY) {
      for (const name of exports) assert.equal(typeof modules.pure[name], "function", name);
    }
    const { APP_OFFICIAL_PRICE_CARDS: cards } = await import(pathToFileURL(join(VENDOR_ROOT, "packages", "accounting",
      "src", "price-registry.js")).href);
    const shifted = (day, days) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const records = [];
    for (const card of cards) {
      const provider = card.provider === "openai" ? "openai_codex" : "anthropic_claude_code";
      const days = new Set(["2026-08-01"]);
      for (const bound of [card.effective?.from, card.effective?.to]) {
        if (typeof bound === "string") for (const offset of [-1, 0, 1]) days.add(shifted(bound, offset));
      }
      const surfaces = provider === "openai_codex"
        ? [["openai_api", card.service_tier, "standard"], ["openai_api", null, "standard"],
          ["chatgpt_subscription", null, "standard"], ["chatgpt_subscription", null, "fast"]]
        : [["anthropic_api", null, "standard"], ["claude_subscription", null, "standard"]];
      for (const modelId of [card.model, ...(card.aliases ?? []), "unknown"]) {
        for (const day of days) {
          for (const [billingSurface, apiServiceTier, speedMode] of surfaces) {
            for (const context of [1_000, 300_000, null]) {
              records.push({ provider, modelId, billingSurface, speedMode, apiServiceTier, reasoningEffort: "high",
                eventTime: `${day}T12:00:00.000Z`, totalInputContextTokens: context,
                components: { inputUncachedTokens: 100, inputCacheReadTokens: context === 300_000 ? 299_000 : 900,
                  inputCacheWriteTokens: provider === "anthropic_claude_code" ? 50 : 0, outputTextTokens: 50,
                  outputReasoningTokens: 25, outputCombinedTokens: context === null ? 75 : null } });
            }
          }
        }
      }
    }
    // Unshapeable and partial records.
    records.push({ provider: "openai_codex", modelId: "gpt-5.5", eventTime: "2026-08-01T00:00:00.000Z", components: null });
    records.push({ provider: "openai_codex", modelId: "gpt-5.5", billingSurface: "openai_api", apiServiceTier: "standard",
      eventTime: "2026-08-01T00:00:00.000Z", components: { inputUncachedTokens: 10 } });
    const selected = new Set();
    for (const record of records) {
      const price = (module) => module.priceAnalyticsV2Input(module.analyticsV2PriceInput(record));
      const chunk = (module) => module.priceChunkUsageRecord(JSON.stringify(record), record.eventTime);
      const real = price(modules.real);
      assert.deepEqual(price(modules.pure), real);
      assert.deepEqual(chunk(modules.pure), chunk(modules.real));
      for (const cardId of real.cardIds) selected.add(cardId);
    }
    // Every card the projection can select: not Anthropic batch/fast tiers (tierForEvent never selects them)
    // and not provider-tool unit cards (the projection carries no tool units).
    const reachable = cards.filter((card) => !(card.provider === "anthropic" && card.service_tier !== "standard")
      && !card.model.endsWith("-provider-tools"));
    assert.ok(reachable.length > 150);
    assert.deepEqual(reachable.filter((card) => !selected.has(card.id)).map((card) => card.id), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the pricer pass refuses a dynamic import it reaches and an input outside the closure", async () => {
  const pricerPass = (options) => options.stdin !== undefined;
  // A pricer whose output still holds the dynamic-import marker.
  await assert.rejects(identityWith(undefined, async (options) => {
    const result = await esbuild().build(options);
    if (!pricerPass(options)) return result;
    const file = result.outputFiles[0];
    return { ...result, outputFiles: [{ ...file, text: `${file.text}\nimport("analytics-v2-pricer-dynamic-import:./x");\n` }] };
  }), { code: "ANALYTICS_PRICER_DYNAMIC_IMPORT_REACHED" });
  // A pricer input the compute closure does not hold (here, kernel.ts, plumbing).
  await assert.rejects(identityWith(undefined, async (options) => {
    const result = await esbuild().build(options);
    if (!pricerPass(options)) return result;
    const output = Object.values(result.metafile.outputs)[0];
    output.inputs[join("..", "src", "analytics-v2", "kernel.ts")] = { bytesInOutput: 10 };
    return result;
  }), { code: "ANALYTICS_PRICER_OUTSIDE_CLOSURE" });
  // The pricing method version must come from a pricer input.
  await assert.rejects(identityWith(undefined, async (options) => {
    const result = await esbuild().build(options);
    if (!pricerPass(options)) return result;
    const output = Object.values(result.metafile.outputs)[0];
    for (const path of Object.keys(output.inputs)) if (path.endsWith("server-pricing.ts")) delete output.inputs[path];
    return result;
  }), { code: "ANALYTICS_PRICER_METHOD_VERSION_MISSING" });
});
