import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

import { captureCurrentQ1D7ReferenceBinding, currentQ1D7ViteOptions }
  from "./current-q1-d7-reference.mjs";
import { invokeCurrentQ1D7Compute } from "./current-q1-d7-native.mjs";
import { clearCurrentQ1D7PrivateValidatedOracle } from "./current-q1-d7-case-output.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import * as D1 from "./current-q1-d1-reference.mjs";
import * as D7 from "./current-q1-d7-recompute.mjs";
import { buildCurrentCorpus } from "../../scripts/gcp-fastpath-current-corpus.mjs";

const FIXTURE = new URL("./current-q1-d7-reference.mjs", import.meta.url);
const EXPECTATION_CHECK = new URL("./current-q1-d7-expectation.check.mjs", import.meta.url);
const D1_FIXTURE = new URL("./current-q1-d1-reference.mjs", import.meta.url);

function extractAdmitCaseDeclaration(source) {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const start = source.indexOf("async function admitCase(");
  assert.ok(start >= 0 && source.indexOf("async function admitCase(", start + 1) < 0,
    "the current producer must retain one private admitCase function");
  scanner.resetTokenState(start);
  for (const expected of ["async", "function", "admitCase"]) {
    const token = scanner.scan();
    assert.notEqual(token, SyntaxKind.EndOfFile);
    assert.equal(scanner.getTokenText(), expected);
  }
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile && scanner.getTokenText() !== "{") token = scanner.scan();
  assert.notEqual(token, SyntaxKind.EndOfFile, "admitCase must have a function body");
  let depth = 0, end;
  while (true) {
    const text = scanner.getTokenText();
    if (text === "{") depth++;
    else if (text === "}" && --depth === 0) {
      end = scanner.getTokenEnd();
      break;
    }
    token = scanner.scan();
    assert.notEqual(token, SyntaxKind.EndOfFile, "admitCase body must close");
  }
  const declaration = source.slice(start, end);
  assert.match(declaration, /^async function admitCase\(/u);
  return declaration;
}

async function extractedAdmitCase(D1Boundary) {
  const source = await readFile(FIXTURE, "utf8");
  const declaration = extractAdmitCaseDeclaration(source);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("D1", "Contract", "SOURCE_ID", "SOURCE_NAMESPACE", "jsonSha256",
    "isDeepStrictEqual", "requireFact", `${declaration}\nreturn admitCase;`)(D1Boundary, Contract,
    "gcp-fastpath-oracle", "gcp-fastpath-oracle", Contract.currentQ1D7JsonSha256, isDeepStrictEqual,
    (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); });
}

function generatedAdmissionCorpus(caseKey) {
  const physicalId = caseKey === "conflictPreserving"
    ? "conflict-preserving-negative-v2" : "conflict-free-positive-v2";
  const generated = buildCurrentCorpus(physicalId);
  assert.equal(generated.files[0]?.[0], "corpus.json");
  const corpus = { ...JSON.parse(generated.files[0][1]), owners: generated.owners };
  const topology = D7.validateCurrentQ1D7Topology(caseKey, corpus);
  corpus.expectedDailyDays = [...topology.dailyDays];
  corpus.conflictDays = [...topology.conflictDays];
  corpus.window = { fromDay: topology.allDays[0], throughDay: topology.allDays.at(-1) };
  return corpus;
}

test("D7 daily convergence forwards its exact day sets through both public scheduler passes", async () => {
  const source = {};
  const target = {};
  const nowMs = 1_800_000_000_000;
  for (const caseKey of ["conflictPreserving", "conflictFreePositive"]) {
    const corpus = generatedAdmissionCorpus(caseKey);
    const topology = D7.validateCurrentQ1D7Topology(caseKey, corpus);
    assert.equal(Object.hasOwn(topology, "dailyDays"), true);
    assert.equal(Object.hasOwn(topology, "expectedDailyDays"), false);
    const topologyBefore = structuredClone(topology);
    const calls = [];
    const progressCalls = [];
    const seenByPass = new Map([[false, new Set()], [true, new Set()]]);
    const ctx = {
      P: {
        async advanceNextStorageCommunityDaily(args) {
          assert.deepEqual(Object.keys(args).sort(), ["nowMs", "preferStaleHead", "skipDays", "source",
            "sourceId", "sourceNamespace", "target"].sort());
          assert.equal(args.source, source);
          assert.equal(args.target, target);
          assert.equal(args.sourceId, "gcp-fastpath-oracle");
          assert.equal(args.sourceNamespace, "gcp-fastpath-oracle");
          assert.equal(args.nowMs, nowMs);
          assert.equal(typeof args.preferStaleHead, "boolean");
          const seen = seenByPass.get(args.preferStaleHead);
          assert.ok(seen);
          assert.deepEqual(args.skipDays, topology.conflictDays.filter((day) => seen.has(day)));
          const day = topology.allDays.find((candidate) => !args.skipDays.includes(candidate) && !seen.has(candidate));
          let step;
          if (day === undefined) {
            step = { state: "idle", ownersAdvanced: 0 };
          } else {
            seen.add(day);
            step = topology.conflictDays.includes(day)
              ? { state: "deferred", reason: "projection_pending", ownersAdvanced: 0, day }
              : { state: "published", ownersAdvanced: 4, day };
          }
          calls.push({ preferStaleHead: args.preferStaleHead, skipDays: [...args.skipDays], step });
          return step;
        },
      },
      ingestion: source,
      analytics: target,
      sourceId: "gcp-fastpath-oracle",
      sourceNamespace: "gcp-fastpath-oracle",
      nowMs,
      progress: { counts(value) { progressCalls.push(value); } },
    };

    const passes = await D7.runCurrentQ1D7DailyConvergence(ctx, topology);
    const expectedOutcomes = {
      published: topology.dailyDays.length,
      unchanged: 0,
      progress: 0,
      conflicts: topology.conflictDays.length,
    };
    assert.deepEqual(passes, [false, true].map(() => ({
      iterations: 171,
      outcomes: expectedOutcomes,
      filteredIdle: true,
    })));
    assert.equal(calls.length, 342);
    assert.deepEqual(calls.map((call) => call.preferStaleHead), [
      ...Array(171).fill(false),
      ...Array(171).fill(true),
    ]);
    assert.ok(calls.length <= D7.CURRENT_Q1_D7_DAILY_BOUND);
    assert.deepEqual(progressCalls, [false, true].flatMap(() =>
      Array.from({ length: 171 }, (_, index) => ({ iteration: index + 1 }))));

    for (const preferStaleHead of [false, true]) {
      const passCalls = calls.filter((call) => call.preferStaleHead === preferStaleHead);
      assert.equal(passCalls.length, 171);
      const expectedSkipped = [];
      const expectedSkipTrace = topology.allDays.map((day) => {
        const skipDays = [...expectedSkipped];
        if (topology.conflictDays.includes(day)) expectedSkipped.push(day);
        return skipDays;
      });
      expectedSkipTrace.push([...expectedSkipped]);
      assert.deepEqual(passCalls.map((call) => call.skipDays), expectedSkipTrace);
      assert.deepEqual(passCalls.slice(0, -1).map((call) => call.step), topology.allDays.map((day) =>
        topology.conflictDays.includes(day)
          ? { state: "deferred", reason: "projection_pending", ownersAdvanced: 0, day }
          : { state: "published", ownersAdvanced: 4, day }));
      assert.deepEqual(passCalls.at(-1), {
        preferStaleHead,
        skipDays: topology.conflictDays,
        step: { state: "idle", ownersAdvanced: 0 },
      });
      assert.deepEqual([...seenByPass.get(preferStaleHead)].sort(), topology.allDays);
    }
    assert.deepEqual(topology, topologyBefore);

    let malformedAdvanceCalls = 0;
    const malformedContext = {
      ...ctx,
      P: { async advanceNextStorageCommunityDaily() { malformedAdvanceCalls++; } },
    };
    await assert.rejects(
      D7.runCurrentQ1D7DailyConvergence(malformedContext,
        { ...topology, dailyDays: topology.dailyDays.slice(1) }),
      (error) => error?.code === "CURRENT_Q1_D7_RECOMPUTATION_INVALID",
    );
    assert.equal(malformedAdvanceCalls, 0);
  }
});

function seedExecutionOrder(corpus, identities) {
  const receipts = [];
  for (const owner of corpus.owners) {
    const primaryFormat = owner.key === "c" ? "v12" : "v11";
    const primary = identities.filter((entry) => entry.participantId === owner.participantId
      && entry.format === primaryFormat);
    const extras = identities.filter((entry) => entry.participantId === owner.participantId && entry.format === "v1");
    if (owner.key === "d") receipts.push(...extras);
    receipts.push(...primary);
    if (owner.key === "a") receipts.push(...extras);
  }
  return receipts;
}

function changeDigest(value) { return `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`; }

test("static producer capture binds the current runtime, closure, and both corpora", async () => {
  const binding = await captureCurrentQ1D7ReferenceBinding();
  const paths = binding.source.files.map(({ path }) => path);
  assert.equal(binding.schemaVersion, "current-q1-d7-input-binding-v1");
  assert.equal(binding.runtime.version, "v26.2.0");
  assert.deepEqual(Object.keys(binding.cases), ["conflictPreserving", "conflictFreePositive"]);
  assert.equal(binding.cases.conflictPreserving.corpusCaseId, "conflict-preserving-negative-v2");
  assert.equal(binding.cases.conflictFreePositive.corpusCaseId, "conflict-free-positive-v2");
  assert.deepEqual(paths, [...new Set(paths)].sort());
  assert.ok(paths.includes("apps/worker/src/server-pricing.ts"));
  assert.ok(paths.includes("apps/worker/scripts/s9-rehearsal-diagnostics.mjs"));
  assert.ok(paths.includes("apps/worker/scripts/gcp-fastpath-rehearsal.mjs"));
  assert.ok(paths.includes("apps/worker/postgres-test/fixtures/current-q1-d7-producer-component.check.mjs"));
  assert.ok(paths.includes("apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.mjs"));
  assert.ok(paths.includes("apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-guardian.mjs"));
  assert.ok(paths.includes("apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs"));
  assert.ok(paths.includes("apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic.check.mjs"));
});

test("admitCase accepts execution-order receipts through a sorted copy and refuses identity mutations", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "current-q1-d7-admission-order-vite-"));
  await chmod(cacheDir, 0o700);
  let server, pendingReceipts;
  const seedCalls = [], invariant = { sha256: "a".repeat(64) };
  let invariantCalls = 0;
  const D1Boundary = {
    ...D1,
    async seedCurrentQ1Corpus(context, owners) {
      seedCalls.push({ context, owners });
      return pendingReceipts;
    },
    async captureCurrentQ1IngestionInvariantDetails(database) {
      invariantCalls++;
      assert.equal(database, seedCalls.at(-1)?.context.ingestion);
      return invariant;
    },
  };
  try {
    server = await createServer(currentQ1D7ViteOptions({ cacheDir }));
    const P = await D1.loadCurrentQ1WorkerModules(server);
    const admitCase = await extractedAdmitCase(D1Boundary);
    const mutations = [
      ["missing", (receipts) => { receipts.pop(); }],
      ["duplicate", (receipts) => { receipts[receipts.length - 1] = structuredClone(receipts[0]); }],
      ["foreign identity", (receipts) => { receipts[0].participantId = "participant:foreign-admission"; }],
      ["altered identity", (receipts) => {
        const receipt = receipts.find((entry) => entry.format === "v11");
        assert.ok(receipt);
        receipt.day = "2027-01-01";
      }],
      ["changed manifest digest", (receipts) => {
        const receipt = receipts.find((entry) => entry.format !== "v1");
        assert.ok(receipt);
        receipt.manifestDigest = changeDigest(receipt.manifestDigest);
      }],
      ["changed chunk digest", (receipts) => {
        const receipt = receipts.find((entry) => entry.format !== "v1");
        assert.ok(receipt?.chunks?.length);
        receipt.chunks[0].chunkDigest = changeDigest(receipt.chunks[0].chunkDigest);
      }],
      ["reversed nested chunk order", (receipts) => {
        const receipt = receipts.find((entry) => entry.chunks?.length > 1);
        assert.ok(receipt, "the public corpus builder must include a multi-chunk manifest");
        receipt.chunks.reverse();
      }],
      ["extra field", (receipts) => { receipts[0].unexpected = "synthetic"; }],
    ];
    for (const caseKey of ["conflictPreserving", "conflictFreePositive"]) {
      const corpus = generatedAdmissionCorpus(caseKey);
      const identities = await D1.buildCurrentQ1AdmissionIdentities(P, corpus);
      const admissionIdentities = structuredClone(identities);
      const actual = seedExecutionOrder(corpus, identities);
      assert.equal(actual.length, identities.length, `${caseKey}: every builder identity has a seed receipt`);
      assert.notDeepEqual(actual, identities, `${caseKey}: the seed receipts retain execution order`);
      const input = { corpus, admissionIdentities,
        admissionSha256: Contract.currentQ1D7JsonSha256(admissionIdentities) };
      const context = { P, ingestion: {}, admissionDiagnostic: { api: { synthetic: true } } };
      const progress = { counts() {} };
      const corpusBefore = structuredClone(corpus);
      const expectedBefore = structuredClone(admissionIdentities);

      pendingReceipts = actual;
      const accepted = await admitCase(context, input, progress);
      assert.equal(accepted.actual, actual, `${caseKey}: preserve the source's returned receipt array`);
      assert.equal(accepted.sourceInvariant, invariant);
      assert.deepEqual(actual, seedExecutionOrder(corpus, identities), `${caseKey}: do not reorder source receipts`);
      assert.deepEqual(corpus, corpusBefore, `${caseKey}: do not change corpus inputs`);
      assert.deepEqual(admissionIdentities, expectedBefore, `${caseKey}: do not change expected identities`);
      const seeded = seedCalls.at(-1);
      assert.equal(seeded.owners, corpus.owners);
      assert.equal(seeded.context.P, context.admissionDiagnostic.api);
      assert.equal(seeded.context.sourceId, "gcp-fastpath-oracle");
      assert.equal(seeded.context.sourceNamespace, "gcp-fastpath-oracle");

      for (const [label, mutate] of mutations) {
        const candidate = structuredClone(actual);
        mutate(candidate);
        const candidateBefore = structuredClone(candidate);
        const ownerInputBefore = structuredClone(corpus.owners);
        pendingReceipts = candidate;
        await assert.rejects(admitCase(context, input, progress),
          (error) => error?.code === "CURRENT_Q1_D7_ADMISSION_MISMATCH", `${caseKey}: ${label}`);
        assert.deepEqual(candidate, candidateBefore, `${caseKey}: preserve ${label} receipt input`);
        assert.deepEqual(corpus.owners, ownerInputBefore, `${caseKey}: preserve owners after ${label}`);
        assert.deepEqual(admissionIdentities, expectedBefore, `${caseKey}: preserve expectations after ${label}`);
      }
    }
    assert.equal(invariantCalls, 2, "only the two accepted corpora reach invariant capture");
    assert.equal(seedCalls.length, 2 * (mutations.length + 1));
  } finally {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

function database() {
  return { prepare() { return { first: async () => 1, run: async () => ({ success: true }) }; } };
}

test("D7 Vite disables env-file loading with an actual synthetic Vite root", async () => {
  const root = await mkdtemp(join(tmpdir(), "current-q1-d7-vite-env-check-"));
  let server;
  try {
    await writeFile(join(root, ".env.local"), "VITE_D7_PRIVATE_FIXTURE_SENTINEL=must-not-load\n", { mode: 0o600 });
    const options = currentQ1D7ViteOptions({ root });
    assert.equal(options.configFile, false);
    assert.equal(options.envDir, false);
    server = await createServer(options);
    assert.equal(Object.hasOwn(server.config.env, "VITE_D7_PRIVATE_FIXTURE_SENTINEL"), false);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("D7 production entry has fixed owned contract imports, not an env-selected validator", async () => {
  const source = await readFile(FIXTURE, "utf8");
  assert.match(source, /import \* as Contract from "\.\/current-q1-d7-contract\.mjs";/u);
  assert.doesNotMatch(source, /CURRENT_Q1_D7_CONTRACT_PATH|process\.env/u);
  assert.match(source, /createServer\(currentQ1D7ViteOptions\(\{ cacheDir \}\)\)/u);
});

test("D1's default source capture keeps its pre-D7 path behavior", async () => {
  const source = await readFile(D1_FIXTURE, "utf8");
  const strictPathHelper = source.match(/const assertCanonicalPath = async \(path\) => \{([\s\S]*?)\n  \};/u)?.[1];
  assert.ok(strictPathHelper);
  assert.match(strictPathHelper, /requireFact\(await realpath\(path\) === path/u);
  assert.match(source, /if \(strictPublicPackageRoots\) await assertCanonicalPath\(absolute\)/u);
  assert.match(source, /validateSourcePath === undefined \|\| await realpath\(path\) === path/u);
  let canonicalPathCalls = 0;
  const validateSourcePath = undefined;
  const canonical = validateSourcePath === undefined || await (async () => {
    canonicalPathCalls++;
    return false;
  })();
  assert.equal(canonical, true);
  assert.equal(canonicalPathCalls, 0);
});

test("producer derives and validates the current public projection before accepting each case", async () => {
  const source = await readFile(FIXTURE, "utf8");
  assert.match(source, /currentPublicExpectations\[caseKey\]\s*=\s*buildCurrentQ1D7CurrentPublicExpectation/u);
  assert.match(source, /createCurrentQ1D7PublicProjectionReceipt\(/u);
  assert.match(source, /validateCurrentQ1D7CurrentPublicResponse\(/u);
  assert.match(source, /const publicAllowanceAuthority = ctx\.P\.reducePublicAllowanceBreakdownsV15/u);
  assert.match(source, /nativeByCase\[caseKey\]\.conflictProofs/u);
  assert.match(source, /publicationInventory/u);
  assert.match(source, /expectedDailyDays:\s*input\.corpus\.expectedDailyDays/u);
  assert.match(source, /expectation:\s*currentPublicExpectation/u);
});

test("the source-pinned current v1.5 reducer rejects every nonempty authority substitution", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "current-q1-d7-authority-vite-"));
  let server;
  try {
    server = await createServer(currentQ1D7ViteOptions({ cacheDir }));
    const P = await D1.loadCurrentQ1WorkerModules(server);
    assert.equal(typeof P.reducePublicAllowanceBreakdownsV15, "function");
    const envelope = { schemaVersion: "community-allowance-breakdowns-v1.5",
      basis: P.COMMUNITY_ALLOWANCE_BASIS, referencePlanType: "pro",
      normalization: P.COMMUNITY_ALLOWANCE_NORMALIZATION,
      modelBasis: P.ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
      modelGate: P.ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
      generatedAt: new Date(Contract.CURRENT_Q1_D7_NOW_MS).toISOString(), days: [],
      modelConfig: P.buildCurrentPublicModelMetadata() };
    const authority = P.reducePublicAllowanceBreakdownsV15(envelope);
    assert.deepEqual(authority.base, Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "modelConfig")));
    assert.deepEqual(authority.metadata, envelope.modelConfig);
    for (const key of ["basis", "normalization", "modelBasis", "modelGate"]) {
      const substituted = structuredClone(envelope);
      substituted[key] = `${substituted[key]}-substituted`;
      assert.throws(() => P.reducePublicAllowanceBreakdownsV15(substituted),
        /PUBLIC_ALLOWANCE_BREAKDOWNS_V15_INVALID/u, `${key} must remain source-authoritative`);
    }
  } finally {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("expectation checks use the fixed same-module contract import", async () => {
  const source = await readFile(EXPECTATION_CHECK, "utf8");
  assert.match(source, /await import\("\.\/current-q1-d7-contract\.mjs"\)/u);
  assert.doesNotMatch(source, /CURRENT_Q1_D7_CONTRACT_PATH|process\.env/u);
});

test("compute clock and invocation deadline share monotonic performance time", async () => {
  const observed = [];
  const started = performance.now();
  const deadlineMonotonicMs = started + 10_000;
  await invokeCurrentQ1D7Compute({ bindings: { source: database(), target: database() },
    scope: { metric: "model", day: "2026-07-24" }, deadlineMonotonicMs,
    computeStorageGraphResult: async (bindings, _scope, options) => {
      const now = options.now();
      observed.push({ now, deadline: options.deadlineMs });
      await bindings.source.prepare("SELECT 1").first();
      await bindings.target.prepare("SELECT 1").first();
      return { state: "complete" };
    } });
  assert.equal(observed.length, 1);
  assert.ok(observed[0].now >= started && observed[0].now < started + 1_000);
  assert.ok(observed[0].deadline >= observed[0].now);
  assert.ok(observed[0].deadline <= observed[0].now + 20_000);
});

test("success cleanup can clear only a non-enumerable retained private oracle", () => {
  const ctx = {};
  Object.defineProperty(ctx, "privateValidatedOracle", { value: { digest: "private" },
    writable: true, enumerable: false, configurable: true });
  assert.equal(clearCurrentQ1D7PrivateValidatedOracle(ctx), true);
  assert.equal(Object.hasOwn(ctx, "privateValidatedOracle"), false);
});

test("D7 reuses the unchanged D1 checkpoint-progress selector and aggregate projection", async () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const scope = { source: "effective", metric: "model", day: "2026-07-24",
    owner: { ownerDigest: hash("owner") }, checkpointDependencyDigest: hash("dependency") };
  const keyDigest = hash("key");
  const heads = [{ generation: hash("generation"), retired: 0 }];
  const stages = [{ n: 2, parts: 3, controlBytes: 20, manifestBytes: 40 }];
  const parts = [{ n: 3, bytes: 200 }];
  const prepared = [];
  const P = {
    STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD: "effective-model-method",
    STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS: ["effective-model-method"],
    async storageHistoryKeyDigest(value) {
      assert.deepEqual(value, { sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle",
        ownerDigest: scope.owner.ownerDigest, day: scope.day, dependencyDigest: scope.checkpointDependencyDigest,
        method: "effective-model-method" });
      return keyDigest;
    },
  };
  const analytics = {
    prepare(sql) {
      return { sql, bind(value) { const statement = { sql, value }; prepared.push(statement); return statement; } };
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      assert.deepEqual(statements, prepared);
      assert.ok(statements[0].sql.includes("analytics_history_checkpoint_heads"));
      assert.ok(statements[1].sql.includes("analytics_history_checkpoint_stages"));
      assert.ok(statements[2].sql.includes("analytics_history_checkpoint_parts"));
      assert.ok(statements.every((statement) => statement.value === keyDigest));
      return [{ results: heads }, { results: stages }, { results: parts }];
    },
  };
  const actual = await D1.nativeCheckpointProgress({ P, analytics }, scope);
  assert.equal(actual, hash(JSON.stringify({ keyDigest, heads, stages, parts })));
  const noCheckpoint = await D1.nativeCheckpointProgress({ P: {}, analytics: null },
    { source: "v0.2", metric: "model", day: "2026-07-24" });
  assert.equal(noCheckpoint, hash(JSON.stringify({ keyDigest: null })));
});
