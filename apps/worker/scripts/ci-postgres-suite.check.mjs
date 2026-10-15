import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  receiptContext,
  assertCleanPostgresCheckout,
  main,
  postgresBuildOwnership,
  postgresExecutionInputs,
  aggregatePostgresReceipts,
  createPostgresReceipt,
  createEdgeS9TapProgressForwarder,
  partitionPostgresPlan,
  parseSuiteArguments,
  postgresPlanDigest,
  checkRegistrationRatchet,
  classifyFailureDetail,
  deriveFileProfile,
  EDGE_E2E_GOLDEN_VARIABLE,
  EDGE_E2E_NODE_FLAGS,
  EDGE_E2E_NODE_VARIABLE,
  EDGE_E2E_NODE_VERSION,
  evaluatePostgresSuite,
  EXPECTED_HOST_PROFILE_FILES,
  EXTRA_REGISTRATION_SCRIPTS,
  EXTRA_SCRIPT_PREREQUISITES,
  extractGateExpressions,
  listPostgresTestFiles,
  loadRegistration,
  parseDomainCheckRegistration,
  parseExtraRegistrationScript,
  parseNodeTap,
  parseVitestInclude,
  parseVitestReport,
  passEnvironment,
  planPostgresSuite,
  probeEdgeE2eEnvironment,
  PROFILE_EDGE_E2E,
  PARTITIONS,
  VITEST_REGISTRATION_CONFIGS,
  readSocketProfileInput,
  runPostgresSuite,
  SCRIPT_PROFILES,
  UNREGISTERED_ALLOWLIST,
} from "./ci-postgres-suite.mjs";
import { S9_DIAGNOSTIC_BYTES, S9_TAP_PROGRESS_PREFIX } from "./s9-rehearsal-diagnostics.mjs";
import {
  CI_WORK_DIRECTORY,
  ciPostgresProfiles,
  ciPostgresTcpProfile,
  CONTAINER_NAME,
  CONTAINER_SOCKET_DIRECTORY,
  dockerRunArguments,
  exportSocketProfile,
  INIT_COMPLETE_MARKER,
  POSTGRES_IMAGE,
  startCiPostgres,
  stopCiPostgres,
  verifyPrivateDirectory,
  verifyServer,
} from "./ci-postgres-container.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOCKET = "/private/tmp/tibotattle-pg-ci/socket";
const EDGE_SPEC = "postgres-test/edge-origin-e2e.spec.mjs";
const PRODUCTION_MIGRATIONS_SPEC = "postgres-test/postgres-production-migrations.spec.mjs";
const JOURNAL_TRANSFER_SPEC = "postgres-test/postgres-ingestion-journal-transfer.spec.mjs";
const EDGE_NODE = "/synthetic/node-v22.16.0/bin/node";
const EDGE_GOLDEN = "/synthetic/golden";

async function withWorkerCopy(callback) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-suite-check-"));
  try {
    for (const path of ["package.json", "vitest.postgres.config.ts", "vitest.node.config.ts"]) {
      await cp(join(WORKER_ROOT, path), join(root, path));
    }
    await cp(join(WORKER_ROOT, "postgres-test"), join(root, "postgres-test"), { recursive: true });
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function editJson(path, edit) {
  const value = JSON.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const codes = (failures) => failures.map(({ code }) => code);

// ---------------------------------------------------------------------------
// Profile routing
// ---------------------------------------------------------------------------

test("routing over the real postgres-test directory derives exactly the frozen HOST files", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  assert.deepEqual(plan.failures, []);
  assert.deepEqual(plan.hostProfileFiles, [...EXPECTED_HOST_PROFILE_FILES].sort());
  assert.deepEqual([...EXPECTED_HOST_PROFILE_FILES].sort(), [
    "postgres-test/typed-v12-normalized.spec.mjs",
  ]);
  const onDisk = await listPostgresTestFiles(WORKER_ROOT);
  const planned = plan.files.map(({ file }) => file);
  assert.equal(new Set(planned).size, planned.length, "each file is planned once");
  for (const file of onDisk) assert.ok(planned.includes(file), `${file} is planned`);
  for (const entry of plan.files) {
    assert.equal(entry.profile, entry.file === EDGE_SPEC
      ? PROFILE_EDGE_E2E
      : EXPECTED_HOST_PROFILE_FILES.includes(entry.file) ? "HOST" : "SOCKET", entry.file);
  }
  for (const socketOnly of [
    "postgres-test/postgres-maintenance.spec.mjs",
    "postgres-test/v12-transport-roundtrip.spec.mjs",
    "postgres-test/postgres-community-daily-roundtrip.spec.mjs",
  ]) {
    assert.equal(plan.files.find(({ file }) => file === socketOnly).profile, "SOCKET");
  }
});

test("routing resolves identifiers to the environment variable they read", async () => {
  // Two real specs bind a local PG_TEST_HOST to PG_TEST_SOCKET; a name-only
  // reading of `skip: !PG_TEST_HOST` would send them to the HOST pass, where
  // they skip.
  for (const file of [
    "postgres-test/legacy-source-membership-roundtrip.spec.mjs",
    "postgres-test/legacy-typed-telemetry-roundtrip.spec.mjs",
  ]) {
    const source = await readFile(join(WORKER_ROOT, file), "utf8");
    assert.match(source, /const PG_TEST_HOST = process\.env\.PG_TEST_SOCKET;/u);
    assert.match(source, /skip: !PG_TEST_HOST,/u);
    assert.equal(deriveFileProfile(source).profile, "SOCKET", file);
  }
  assert.equal(deriveFileProfile(`
const PG_TEST_HOST = process.env.PG_TEST_SOCKET;
test("aliased", { skip: !PG_TEST_HOST }, async () => {});
`).profile, "SOCKET");
  assert.equal(deriveFileProfile(`
const PG_TEST_HOST = process.env.PG_TEST_HOST;
test("host as socket", { skip: !PG_TEST_HOST }, async () => {});
test("again", { skip: !PG_TEST_HOST, timeout: 1 }, async () => {});
`).profile, "HOST");
  assert.equal(deriveFileProfile(`
const { PG_TEST_HOST: hostDirectory } = process.env;
test("destructured", { skip: !hostDirectory }, async () => {});
`).profile, "HOST");
  assert.equal(deriveFileProfile(`
test("direct", { skip: !process.env.PG_TEST_HOST }, async () => {});
`).profile, "HOST");
});

test("dual-key, socket-keyed and ungated specs route SOCKET; mixed or unresolved gates are ambiguous", () => {
  const bindings = `
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
`;
  assert.equal(deriveFileProfile(`${bindings}
test("dual", { skip: !PG_TEST_HOST && !PG_TEST_SOCKET }, async () => {});
`).profile, "SOCKET");
  assert.equal(deriveFileProfile(`${bindings}
describe.skipIf(!PG_TEST_SOCKET && !PG_TEST_HOST)("suite", () => {});
`).profile, "SOCKET");
  assert.equal(deriveFileProfile(`${bindings}
test("multi-line", {
  skip: !PG_TEST_HOST
    && !PG_TEST_SOCKET,
}, async () => {});
`).profile, "SOCKET");
  assert.equal(deriveFileProfile(`
test("no gate", async () => {});
`).profile, "SOCKET");
  assert.equal(deriveFileProfile(`${bindings}
test("unrelated", { skip: process.platform === "win32" }, async () => {});
`).profile, "SOCKET");

  const mixed = deriveFileProfile(`${bindings}
test("host", { skip: !PG_TEST_HOST }, async () => {});
test("socket", { skip: !PG_TEST_SOCKET }, async () => {});
`);
  assert.equal(mixed.ambiguous, true);
  assert.equal(mixed.profile, null);
  const unresolved = deriveFileProfile(`
import { PG_TEST_HOST } from "./environment.mjs";
test("imported", { skip: !PG_TEST_HOST }, async () => {});
`);
  assert.equal(unresolved.ambiguous, true);
  assert.match(unresolved.reasons.join(";"), /unresolved PG_TEST_HOST/u);
});

test("vitest skipIf and runIf arguments are gates too", () => {
  // Every real vitest spec gates dual-key, which routes SOCKET like an ungated
  // file; these fixtures prove skipIf/runIf are read, not defaulted.
  assert.deepEqual(extractGateExpressions(`
describe.skipIf(!process.env.PG_TEST_HOST)("suite", () => {});
it.runIf(Boolean(process.env.PG_TEST_SOCKET))("case", () => {});
`), ["!process.env.PG_TEST_HOST", "Boolean(process.env.PG_TEST_SOCKET)"]);
  assert.equal(deriveFileProfile(`
describe.skipIf(!process.env.PG_TEST_HOST)("suite", () => {});
`).profile, "HOST");
  assert.equal(deriveFileProfile(`
const PG_TEST_HOST = process.env.PG_TEST_HOST;
describe.runIf(PG_TEST_HOST)("suite", () => {});
`).profile, "HOST");
  const unbound = deriveFileProfile(`
describe.runIf(PG_TEST_UNBOUND)("suite", () => {});
`);
  assert.deepEqual([unbound.ambiguous, unbound.profile], [true, null]);
  assert.match(unbound.reasons.join(";"), /unresolved PG_TEST_UNBOUND/u);
  const mixed = deriveFileProfile(`
describe.skipIf(!process.env.PG_TEST_HOST)("host", () => {});
describe.skipIf(!process.env.PG_TEST_SOCKET)("socket", () => {});
`);
  assert.equal(mixed.ambiguous, true);
});

test("a vitest-registered spec that derives HOST fails PROFILE_ROUTING_DRIFT (the HOST pass is node:test only)", async () => {
  const vitestSpec = "postgres-test/postgres-community-daily-host.spec.mjs";
  await withWorkerCopy(async (root) => {
    assert.ok((await readFile(join(root, "vitest.postgres.config.ts"), "utf8")).includes(vitestSpec));
    await writeFile(join(root, vitestSpec),
      "import { describe, it } from \"vitest\";\n"
      + "describe.skipIf(!process.env.PG_TEST_HOST)(\"synthetic\", () => { it(\"runs\", () => {}); });\n");
    const plan = await planPostgresSuite({
      workerRoot: root,
      expectedHostFiles: [...EXPECTED_HOST_PROFILE_FILES, vitestSpec],
    });
    assert.deepEqual(plan.failures.map(({ code, file, detail }) => [code, file, detail]), [
      ["PROFILE_ROUTING_DRIFT", vitestSpec, "HOST-routed specs must be node:test files"],
    ]);
  });
});

test("a spec whose derived route changes fails PROFILE_ROUTING_DRIFT or PROFILE_ROUTING_AMBIGUOUS", async () => {
  await withWorkerCopy(async (root) => {
    const maintenance = join(root, "postgres-test/postgres-maintenance.spec.mjs");
    const source = await readFile(maintenance, "utf8");
    await writeFile(maintenance, source.replaceAll(
      "skip: !PG_TEST_HOST && !PG_TEST_SOCKET,",
      "skip: !PG_TEST_HOST,",
    ));
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(codes(plan.failures), ["PROFILE_ROUTING_DRIFT"]);
    assert.equal(plan.failures[0].file, "postgres-test/postgres-maintenance.spec.mjs");
  });
  await withWorkerCopy(async (root) => {
    const hostOnly = join(root, "postgres-test/typed-v12-normalized.spec.mjs");
    const source = await readFile(hostOnly, "utf8");
    await writeFile(hostOnly, source.replace(
      "skip: !PG_TEST_HOST,",
      "skip: !PG_TEST_HOST && !process.env.PG_TEST_SOCKET,",
    ));
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(codes(plan.failures), ["PROFILE_ROUTING_DRIFT"]);
    assert.match(plan.failures[0].detail, /does not derive HOST/u);
  });
  await withWorkerCopy(async (root) => {
    const typed = join(root, "postgres-test/typed-v12-normalized.spec.mjs");
    await writeFile(typed, `${await readFile(typed, "utf8")}
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
test("synthetic socket-keyed test", { skip: !PG_TEST_SOCKET }, () => {});
`);
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.ok(codes(plan.failures).includes("PROFILE_ROUTING_AMBIGUOUS"));
  });
});

// ---------------------------------------------------------------------------
// Registration ratchet
// ---------------------------------------------------------------------------

test("the real registration leaves exactly the ten allowlisted specs unregistered", async () => {
  const registration = await loadRegistration(WORKER_ROOT);
  const onDisk = await listPostgresTestFiles(WORKER_ROOT);
  const { registered, failures } = checkRegistrationRatchet({ onDisk, registration });
  assert.deepEqual(failures, []);
  assert.equal(UNREGISTERED_ALLOWLIST.length, 10);
  assert.deepEqual(onDisk.filter((file) => !registered.has(file)), [...UNREGISTERED_ALLOWLIST].sort());
  // The rich-days allowance spec (formerly the retired journey's fixture
  // spec) stays registered through the Node vitest config.
  const richDays = "postgres-test/community-allowance-rich-days.spec.mjs";
  assert.ok(!UNREGISTERED_ALLOWLIST.includes(richDays));
  assert.deepEqual(registered.get(richDays), ["vitest.node.config.ts"]);
  assert.equal(registered.has("postgres-test/gcp-cloud-run-journey-fixture.spec.mjs"), false);
  assert.deepEqual(registered.get("postgres-test/postgres-maintenance.spec.mjs"), ["postgres:domain:check"]);
  for (const added of ["postgres-test/append-only-residue.spec.mjs", "postgres-test/online-erasure-absence.spec.mjs"]) {
    assert.deepEqual(registered.get(added), ["postgres:domain:check"], added);
  }
});

test("a new unregistered spec fails UNREGISTERED_POSTGRES_SPEC", async () => {
  await withWorkerCopy(async (root) => {
    await writeFile(join(root, "postgres-test/new-synthetic.spec.mjs"),
      "import { test } from \"node:test\";\ntest(\"synthetic\", () => {});\n");
    await writeFile(join(root, "postgres-test/new-synthetic.check.mjs"),
      "import { test } from \"node:test\";\ntest(\"synthetic\", () => {});\n");
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(plan.failures.map(({ code, file }) => [code, file]), [
      ["UNREGISTERED_POSTGRES_SPEC", "postgres-test/new-synthetic.check.mjs"],
      ["UNREGISTERED_POSTGRES_SPEC", "postgres-test/new-synthetic.spec.mjs"],
    ]);
  });
});

test("an allowlisted spec that becomes registered or disappears fails ALLOWLIST_STALE", async () => {
  const promoted = "postgres-test/v12-transport-roundtrip.spec.mjs";
  await withWorkerCopy(async (root) => {
    await editJson(join(root, "package.json"), (value) => {
      value.scripts["postgres:domain:check"] += ` ./${promoted}`;
    });
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(plan.failures.map(({ code, file }) => [code, file]), [["ALLOWLIST_STALE", promoted]]);
  });
  await withWorkerCopy(async (root) => {
    const config = join(root, "vitest.node.config.ts");
    await writeFile(config, (await readFile(config, "utf8")).replace(
      "include: [",
      `include: ["${promoted}", `,
    ));
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(plan.failures.map(({ code, file }) => [code, file]), [["ALLOWLIST_STALE", promoted]]);
  });
  await withWorkerCopy(async (root) => {
    await rm(join(root, promoted));
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(plan.failures.map(({ code, file }) => [code, file]), [["ALLOWLIST_STALE", promoted]]);
  });
});

test("registration drift fails closed: missing, duplicated or unparseable registrations", async () => {
  await withWorkerCopy(async (root) => {
    await rm(join(root, "postgres-test/postgres-maintenance.spec.mjs"));
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(codes(plan.failures), ["REGISTERED_SPEC_MISSING"]);
  });
  await withWorkerCopy(async (root) => {
    await editJson(join(root, "package.json"), (value) => {
      value.scripts["postgres:domain:check"] += " ./postgres-test/postgres-maintenance.spec.mjs";
    });
    const plan = await planPostgresSuite({ workerRoot: root });
    assert.deepEqual(codes(plan.failures), ["REGISTRATION_DUPLICATE"]);
  });
  assert.throws(() => parseVitestInclude(`include: ["postgres-test/*.spec.mjs"]`),
    /REGISTRATION_PARSE_FAILED/u);
  assert.throws(() => parseVitestInclude(`include: [...shared]`), /REGISTRATION_PARSE_FAILED/u);
  assert.throws(() => parseDomainCheckRegistration(
    "node --test postgres-test/unprefixed.spec.mjs",
  ), /REGISTRATION_PARSE_FAILED/u);
  assert.throws(() => parseDomainCheckRegistration(
    "vitest run ./postgres-test/a.spec.mjs",
  ), /REGISTRATION_PARSE_FAILED/u);
  assert.deepEqual(parseDomainCheckRegistration(
    "vitest run --config vitest.postgres.config.ts && node --test --test-concurrency=1 ./postgres-test/a.spec.mjs ./postgres-test/b.check.mjs",
  ), {
    nodeFiles: ["postgres-test/a.spec.mjs", "postgres-test/b.check.mjs"],
    vitestConfigs: ["vitest.postgres.config.ts"],
  });
  assert.deepEqual(parseDomainCheckRegistration("vitest run --config=vitest.node.config.ts").vitestConfigs,
    ["vitest.node.config.ts"]);
});

test("a postgres:domain:check registration the runner would not execute fails REGISTRATION_PARSE_FAILED", async () => {
  const base = "vitest run --config vitest.postgres.config.ts && node --test --test-concurrency=1 ./postgres-test/a.spec.mjs";
  for (const script of [
    `${base} ./scripts/pg-extra.check.mjs`,
    `${base} ./test/pg-other.spec.mjs`,
    `${base} && vitest run --config vitest.graph.config.ts`,
    `${base} && vitest run`,
    `${base} && vitest run --config vitest.postgres.config.ts ./postgres-test/filter.spec.mjs`,
    `${base} && node ./scripts/pg-extra.check.mjs`,
    `${base} && node --test`,
    `${base} && npm run other:check`,
    "node --test --import ./setup.mjs ./postgres-test/a.spec.mjs",
    "node --test ./postgres-test/a.spec.mjs; node --test ./postgres-test/b.spec.mjs",
  ]) {
    assert.throws(() => parseDomainCheckRegistration(script), /REGISTRATION_PARSE_FAILED/u, script);
  }
  for (const appended of [" ./scripts/pg-extra.check.mjs", " && vitest run --config vitest.graph.config.ts"]) {
    await withWorkerCopy(async (root) => {
      await editJson(join(root, "package.json"), (value) => {
        value.scripts["postgres:domain:check"] += appended;
      });
      const plan = await planPostgresSuite({ workerRoot: root });
      assert.deepEqual(codes(plan.failures), ["REGISTRATION_PARSE_FAILED"], appended);
      assert.deepEqual(plan.files, []);
    });
  }
});

// ---------------------------------------------------------------------------
// Result parsing and evaluation
// ---------------------------------------------------------------------------

const TAP_FILE = "postgres-test/synthetic.spec.mjs";
const TAP_ABSOLUTE = join(WORKER_ROOT, TAP_FILE);

function tapParse(text) {
  return parseNodeTap(text, { absoluteFile: TAP_ABSOLUTE, cwd: WORKER_ROOT });
}

const PASSING_TAP = `TAP version 13
# Subtest: plain pass
ok 1 - plain pass
  ---
  duration_ms: 0.3
  type: 'test'
  ...
# Subtest: group
    # Subtest: nested pass
    ok 1 - nested pass
      ---
      duration_ms: 0.1
      type: 'test'
      ...
    1..1
ok 2 - group
  ---
  duration_ms: 0.2
  type: 'suite'
  ...
1..2
# tests 2
# suites 1
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10
`;

function nodeRecord(pass, file, parsed, exitCode = 0) {
  return {
    pass,
    runner: "node",
    file,
    exitCode,
    files: new Map([[file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
    parseFailures: parsed.parseFailures,
  };
}

test("TAP parsing keys leaves by full name and ignores suite wrappers", () => {
  const parsed = tapParse(PASSING_TAP);
  assert.deepEqual(parsed.parseFailures, []);
  assert.equal(parsed.fileFailure, null);
  assert.deepEqual(parsed.tests.map(({ name, status }) => [name, status]), [
    ["plain pass", "passed"],
    ["group > nested pass", "passed"],
  ]);
});

test("a skipped or todo test in its routed pass fails SILENTLY_SKIPPED", () => {
  const parsed = tapParse(`TAP version 13
# Subtest: runs
ok 1 - runs
  ---
  type: 'test'
  ...
# Subtest: skipped \\# not a directive
ok 2 - skipped \\# not a directive # SKIP
  ---
  type: 'test'
  ...
# Subtest: group
    # Subtest: nested todo
    ok 1 - nested todo # TODO
      ---
      type: 'test'
      ...
    1..1
ok 3 - group
  ---
  type: 'suite'
  ...
1..3
# tests 3
# pass 1
# fail 0
# cancelled 0
# skipped 1
# todo 1
`);
  assert.deepEqual(parsed.tests.map(({ name, status }) => [name, status]), [
    ["runs", "passed"],
    ["skipped # not a directive", "skipped"],
    ["group > nested todo", "todo"],
  ]);
  const summary = evaluatePostgresSuite({
    plan: { files: [{ file: TAP_FILE, profile: "HOST" }] },
    records: [nodeRecord("HOST", TAP_FILE, parsed)],
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.failures.map(({ code, test: name }) => [code, name]), [
    ["SILENTLY_SKIPPED", "skipped # not a directive"],
    ["SILENTLY_SKIPPED", "group > nested todo"],
  ]);
  assert.equal(summary.skipped.length, 2);
});

test("failures are FAILED unless they come from an environment assertion (ENV_PROFILE_CONFLICT)", () => {
  const parsed = tapParse(`TAP version 13
# Subtest: endpoint
not ok 1 - endpoint
  ---
  type: 'test'
  error: 'PostgreSQL transport tests require a loopback host or a private Unix socket'
  stack: |-
    localEndpoint (file:///worker/postgres-test/synthetic.spec.mjs:30:3)
  ...
# Subtest: arithmetic
not ok 2 - arithmetic
  ---
  type: 'test'
  error: |-
    Expected values to be strictly equal:
    1 !== 2
  ...
1..2
# tests 2
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
`);
  const summary = evaluatePostgresSuite({
    plan: { files: [{ file: TAP_FILE, profile: "SOCKET" }] },
    records: [nodeRecord("SOCKET", TAP_FILE, parsed, 1)],
  });
  assert.deepEqual(summary.failures.map(({ code, file, test: name }) => [code, file, name]), [
    ["ENV_PROFILE_CONFLICT", TAP_FILE, "endpoint"],
    ["FAILED", TAP_FILE, "arithmetic"],
  ]);
  assert.equal(classifyFailureDetail("AssertionError: 'PG_TEST_HOST' must be loopback"), "ENV_PROFILE_CONFLICT");
  assert.equal(classifyFailureDetail("relation \"x\" does not exist"), "FAILED");
});

test("a file that produced zero tests fails EMPTY_SPEC_FILE, and a load failure also fails FAILED", () => {
  const empty = tapParse(`TAP version 13
# Subtest: ${TAP_FILE}
ok 1 - ${TAP_FILE}
  ---
  type: 'test'
  ...
1..1
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`);
  assert.deepEqual(empty.tests, []);
  let summary = evaluatePostgresSuite({
    plan: { files: [{ file: TAP_FILE, profile: "SOCKET" }] },
    records: [nodeRecord("SOCKET", TAP_FILE, empty)],
  });
  assert.deepEqual(codes(summary.failures), ["EMPTY_SPEC_FILE"]);

  const broken = tapParse(`TAP version 13
# Subtest: ${TAP_ABSOLUTE}
not ok 1 - ${TAP_ABSOLUTE}
  ---
  type: 'test'
  failureType: 'testCodeFailure'
  error: 'test failed'
  ...
1..1
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`);
  summary = evaluatePostgresSuite({
    plan: { files: [{ file: TAP_FILE, profile: "SOCKET" }] },
    records: [nodeRecord("SOCKET", TAP_FILE, broken, 1)],
  });
  assert.deepEqual(summary.failures.map(({ code, test: name }) => [code, name]), [
    ["FAILED", "(file)"],
    ["EMPTY_SPEC_FILE", undefined],
  ]);
});

test("truncated or inconsistent TAP never counts as a pass", () => {
  assert.deepEqual(tapParse("TAP version 13\n# Subtest: a\nok 1 - a\n").parseFailures, ["TAP_INCOMPLETE"]);
  assert.deepEqual(tapParse(`TAP version 13
# Subtest: a
ok 1 - a
1..1
# tests 1
# pass 0
# fail 0
# skipped 1
# todo 0
`).parseFailures, ["TAP_PARSE_MISMATCH"]);
  const summary = evaluatePostgresSuite({
    plan: { files: [{ file: TAP_FILE, profile: "SOCKET" }] },
    records: [nodeRecord("SOCKET", TAP_FILE, tapParse(PASSING_TAP), 1)],
  });
  assert.deepEqual(codes(summary.failures), ["SUITE_PROCESS_FAILED"]);
});

test("the TAP parser understands this Node's real reporter output", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-suite-tap-"));
  try {
    const file = join(root, "postgres-test", "real.spec.mjs");
    await mkdir(dirname(file));
    await writeFile(file, `import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
test("passes", () => {});
test("skips # hash", { skip: true }, () => {});
test("todo", { todo: true }, () => {});
test("fails", () => { assert.equal(1, 2); });
describe("suite", () => { it("nested", () => {}); });
test("parent", async (t) => { await t.test("child", () => {}); });
`);
    const result = spawnSync(process.execPath, [
      "--test", "--test-concurrency=1", "--test-reporter=tap", "./postgres-test/real.spec.mjs",
    ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
    const parsed = parseNodeTap(result.stdout, { absoluteFile: file, cwd: root });
    assert.deepEqual(parsed.parseFailures, []);
    assert.deepEqual(parsed.tests.map(({ name, status }) => [name, status]), [
      ["passes", "passed"],
      ["skips # hash", "skipped"],
      ["todo", "todo"],
      ["fails", "failed"],
      ["suite > nested", "passed"],
      ["parent > child", "passed"],
    ]);

    await writeFile(file, "// no tests\n");
    const empty = spawnSync(process.execPath, [
      "--test", "--test-concurrency=1", "--test-reporter=tap", "./postgres-test/real.spec.mjs",
    ], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } });
    const parsedEmpty = parseNodeTap(empty.stdout, { absoluteFile: file, cwd: root });
    assert.deepEqual([parsedEmpty.tests, parsedEmpty.fileFailure, parsedEmpty.parseFailures], [[], null, []]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EDGE TAP forwarding accepts only closed monotonic tagged S9 progress within both caps", () => {
  const forwarded = [];
  const forward = createEdgeS9TapProgressForwarder((value) => forwarded.push(value));
  const valid = { event: "s9_rehearsal_progress", component: "controller", phase: "current_d1_replay", elapsedMs: 10 };
  const tagged = (value) => `# ${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(value)}\n`;
  forward(Buffer.from([
    "# ordinary TAP comment\n",
    `# ${S9_TAP_PROGRESS_PREFIX}{malformed}\n`,
    tagged({ ...valid, privatePath: "/private/SENSITIVE_CANARY" }),
    tagged({ ...valid, phase: "SENSITIVE_CANARY" }),
    tagged(valid),
    tagged({ ...valid, elapsedMs: 9 }),
    "# PRIVATE_RAW_ERROR /private/SENSITIVE_CANARY\n",
  ].join("")));
  assert.deepEqual(forwarded, [valid]);
  assert.doesNotMatch(JSON.stringify(forwarded), /SENSITIVE_CANARY|private/u);

  const splitForwarded = [];
  const splitForward = createEdgeS9TapProgressForwarder((value) => splitForwarded.push(value));
  const splitLine = tagged({ ...valid, elapsedMs: 11 });
  const prefixLength = `# ${S9_TAP_PROGRESS_PREFIX}`.length;
  splitForward(Buffer.from(splitLine.slice(0, prefixLength - 3)));
  splitForward(Buffer.from(splitLine.slice(prefixLength - 3, prefixLength + 12)));
  splitForward(Buffer.from(splitLine.slice(prefixLength + 12)));
  assert.deepEqual(splitForwarded, [{ ...valid, elapsedMs: 11 }],
    "a tagged prefix and JSON split across chunks remain one validated record");

  const canonicalForwarded = [];
  const forwardCanonical = createEdgeS9TapProgressForwarder((value) => canonicalForwarded.push(value));
  forwardCanonical(Buffer.from(`${tagged(valid).replaceAll(",", ", ")}${tagged(valid)}`));
  assert.deepEqual(canonicalForwarded, [valid], "valid but noncanonical JSON is refused");

  const oversizedChunkForwarded = [];
  const forwardOversizedChunk = createEdgeS9TapProgressForwarder((value) => oversizedChunkForwarded.push(value));
  const validLine = tagged(valid);
  const oversizedChunk = validLine.repeat(Math.ceil((64 * 1024 + 1) / Buffer.byteLength(validLine)));
  assert.ok(Buffer.byteLength(oversizedChunk) > 64 * 1024);
  forwardOversizedChunk(Buffer.from(oversizedChunk));
  forwardOversizedChunk(Buffer.from(`${validLine}${validLine}`));
  assert.deepEqual(oversizedChunkForwarded, [valid],
    "an oversized whole chunk is discarded and parsing resumes after the next newline");

  const oversizedLineForwarded = [];
  const forwardOversizedLine = createEdgeS9TapProgressForwarder((value) => oversizedLineForwarded.push(value));
  const oversizedLine = `# ${S9_TAP_PROGRESS_PREFIX}${"x".repeat(1_024)}\n`;
  forwardOversizedLine(Buffer.from(`${oversizedLine}${validLine}`));
  assert.deepEqual(oversizedLineForwarded, [valid],
    "an oversized line is discarded without blocking the following line");

  const recordCapped = [];
  const forwardRecordCapped = createEdgeS9TapProgressForwarder((value) => recordCapped.push(value));
  const small = { event: "s9_rehearsal_progress", component: "producer", phase: "oracle", elapsedMs: 0 };
  const smallLine = Buffer.from(tagged(small));
  for (let index = 0; index < 2_000; index += 1) forwardRecordCapped(smallLine);
  assert.equal(recordCapped.length, 1_024, "the independent record cap remains exact");

  const byteCapped = [];
  const forwardByteCapped = createEdgeS9TapProgressForwarder((value) => byteCapped.push(value));
  const large = { event: "s9_rehearsal_progress", component: "producer", phase: "oracle", elapsedMs: 0,
    ...Object.fromEntries(["iteration", "completedSteps", "scopeOrdinal", "ownerOrdinal", "dayOrdinal",
      "chunkOrdinal", "completedOwners", "completedDays", "completedChunks"].map((key) => [key, 10_000_000])) };
  const largeLine = Buffer.from(tagged(large));
  for (let index = 0; index < 2_000; index += 1) forwardByteCapped(largeLine);
  const forwardedBytes = byteCapped.reduce((total, value) => total + Buffer.byteLength(`${JSON.stringify(value)}\n`), 0);
  assert.ok(byteCapped.length < 1_024, "the byte cap is independently exercised");
  assert.ok(forwardedBytes <= S9_DIAGNOSTIC_BYTES);

  const sinkFailure = createEdgeS9TapProgressForwarder(() => { throw new Error("PRIVATE_SINK_FAILURE"); });
  assert.doesNotThrow(() => sinkFailure(Buffer.from(tagged(valid))));
});

test("EDGE run streams a real Node TAP progress comment before child completion and still parses full TAP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-edge-progress-tap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specDirectory = join(root, "postgres-test");
  await mkdir(specDirectory);
  const spec = join(specDirectory, "edge-origin-e2e.spec.mjs");
  const completed = join(root, "child-completed.marker");
  const valid = { event: "s9_rehearsal_progress", component: "controller", phase: "current_d1_replay", elapsedMs: 100 };
  const regressing = { ...valid, elapsedMs: 99 };
  const privateValue = { ...valid, privatePath: "/private/SENSITIVE_CANARY" };
  const source = `import { test } from "node:test";
import { writeFile } from "node:fs/promises";
test("synthetic progress boundary", async () => {
  process.stderr.write(${JSON.stringify(`${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(valid)}\n`)});
  process.stderr.write(${JSON.stringify(`${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(regressing)}\n`)});
  process.stderr.write(${JSON.stringify(`${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(privateValue)}\n`)});
  process.stderr.write("PRIVATE_RAW_ERROR /private/SENSITIVE_CANARY\\n");
  process.stdout.write(${JSON.stringify(`# ${S9_TAP_PROGRESS_PREFIX}${JSON.stringify(valid)}\n`)});
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  await writeFile(${JSON.stringify(completed)}, "done");
});
`;
  await writeFile(spec, source);
  const live = [];
  let observedBeforeCompletion = false;
  const plan = { failures: [], files: [{ file: EDGE_SPEC, runner: "script:edge:e2e", source: "edge:e2e",
    profile: PROFILE_EDGE_E2E }] };
  const result = await runPostgresSuite({ workerRoot: root, plan,
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    probeEdgeE2e: async () => ({ available: true, node: process.execPath }),
    onOutput: () => {},
    onS9Progress: (value) => {
      observedBeforeCompletion ||= !existsSync(completed);
      live.push(value);
      throw new Error("PRIVATE_LIVE_SINK_FAILURE");
    },
  });
  assert.equal(observedBeforeCompletion, true,
    "the suite forwards progress while the synthetic child test is still running");
  assert.deepEqual(live, [valid], "regressing, malformed-shape, and untagged output is not forwarded");
  assert.doesNotMatch(JSON.stringify(live), /SENSITIVE_CANARY|private/u);
  assert.equal(result.status, "passed");
  assert.equal(result.tests, 1);
  assert.deepEqual(result.failures, []);
  assert.ok(existsSync(completed));
});

function vitestReport(entries) {
  return {
    numTotalTests: 0,
    testResults: entries.map(({ file, status = "passed", message = "", assertions }) => ({
      name: join(WORKER_ROOT, file),
      status,
      message,
      assertionResults: assertions.map(([ancestors, title, assertionStatus, failureMessages = []]) => ({
        ancestorTitles: ancestors,
        fullName: [...ancestors, title].join(" "),
        title,
        status: assertionStatus,
        failureMessages,
      })),
    })),
  };
}

function vitestRecord(parsed, exitCode = 0) {
  return {
    pass: "SOCKET",
    runner: "vitest:vitest.postgres.config.ts",
    file: null,
    exitCode,
    files: parsed.files,
    parseFailures: parsed.parseFailures,
  };
}

test("vitest JSON: skipped, pending and todo fail; missing, empty and unplanned files fail", () => {
  const a = "postgres-test/a.spec.mjs";
  const b = "postgres-test/b.spec.mjs";
  const c = "postgres-test/c.spec.mjs";
  const parsed = parseVitestReport(vitestReport([
    { file: a, assertions: [
      [["suite"], "passes", "passed"],
      [["suite"], "skipped", "skipped"],
      [["suite"], "pending", "pending"],
      [["suite"], "todo", "todo"],
      [["suite"], "fails", "failed", ["AssertionError: qualification requires a local Unix socket"]],
    ] },
    { file: b, status: "failed", message: "No test suite found in file", assertions: [] },
    { file: "postgres-test/unplanned.spec.mjs", assertions: [[[], "x", "passed"]] },
  ]), { workerRoot: WORKER_ROOT });
  assert.deepEqual(parsed.parseFailures, []);
  const summary = evaluatePostgresSuite({
    plan: { files: [a, b, c].map((file) => ({ file, profile: "SOCKET" })) },
    records: [vitestRecord(parsed, 1)],
  });
  assert.deepEqual(summary.failures.map(({ code, file, test: name }) => [code, file, name]), [
    ["SILENTLY_SKIPPED", a, "suite > skipped"],
    ["SILENTLY_SKIPPED", a, "suite > pending"],
    ["SILENTLY_SKIPPED", a, "suite > todo"],
    ["ENV_PROFILE_CONFLICT", a, "suite > fails"],
    ["FAILED", b, "(file)"],
    ["EMPTY_SPEC_FILE", b, undefined],
    ["UNPLANNED_SPEC_RESULT", "postgres-test/unplanned.spec.mjs", undefined],
    ["EMPTY_SPEC_FILE", c, undefined],
  ]);
  assert.deepEqual(parseVitestReport(null, { workerRoot: WORKER_ROOT }).parseFailures, ["VITEST_REPORT_INVALID"]);
});

test("vitest JSON: a disabled test is a skip and an unknown status is a failure, never a pass", () => {
  const a = "postgres-test/a.spec.mjs";
  const parsed = parseVitestReport(vitestReport([
    { file: a, assertions: [
      [["suite"], "disabled", "disabled"],
      [["suite"], "from a newer vitest", "some-future-status"],
      [["suite"], "no status", undefined],
    ] },
  ]), { workerRoot: WORKER_ROOT });
  assert.deepEqual(parsed.files.get(a).tests.map(({ status }) => status), ["skipped", "failed", "failed"]);
  const summary = evaluatePostgresSuite({
    plan: { files: [{ file: a, profile: "SOCKET" }] },
    records: [vitestRecord(parsed)],
  });
  assert.deepEqual(summary.failures.map(({ code, test: name }) => [code, name]), [
    ["SILENTLY_SKIPPED", "suite > disabled"],
    ["FAILED", "suite > from a newer vitest"],
    ["FAILED", "suite > no status"],
  ]);
  assert.equal(summary.passedByPass.SOCKET, 0);
});

test("the union of passes must place every planned file in its routed pass exactly once", () => {
  const hostFile = "postgres-test/host.spec.mjs";
  const socketFile = "postgres-test/socket.spec.mjs";
  const plan = { files: [
    { file: hostFile, profile: "HOST" },
    { file: socketFile, profile: "SOCKET" },
  ] };
  const passing = tapParse(PASSING_TAP);
  let summary = evaluatePostgresSuite({ plan, records: [
    nodeRecord("SOCKET", socketFile, passing),
    nodeRecord("HOST", hostFile, passing),
  ] });
  assert.deepEqual(summary, {
    status: "passed",
    files: 2,
    tests: 4,
    passedByPass: { SOCKET: 2, HOST: 2, EDGE_E2E: 0 },
    skipped: [],
    failures: [],
    environmentGaps: [],
  });
  summary = evaluatePostgresSuite({ plan, records: [
    nodeRecord("SOCKET", socketFile, passing),
    nodeRecord("SOCKET", hostFile, passing),
  ] });
  assert.deepEqual(summary.failures.map(({ code, file }) => [code, file]), [
    ["PROFILE_ROUTING_DRIFT", hostFile],
  ]);
  summary = evaluatePostgresSuite({ plan, records: [
    nodeRecord("SOCKET", socketFile, passing),
    nodeRecord("SOCKET", socketFile, passing),
    nodeRecord("HOST", hostFile, passing),
  ] });
  assert.deepEqual(codes(summary.failures), ["PROFILE_ROUTING_DRIFT"]);
});

// ---------------------------------------------------------------------------
// Runner orchestration (fake processes, no database)
// ---------------------------------------------------------------------------

function passingTapFor(name) {
  return `TAP version 13
# Subtest: ${name}
ok 1 - ${name}
  ---
  type: 'test'
  ...
1..1
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
}

function tapForStatuses(file, statuses, { reportedTests = statuses.length } = {}) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  const lines = ["TAP version 13", `# Subtest: ${file}`];
  statuses.forEach((status, index) => {
    const name = `synthetic case ${index + 1}`;
    const tapStatus = status === "failed" ? "not ok" : "ok";
    const directive = status === "skipped" ? " # SKIP" : status === "todo" ? " # TODO" : "";
    lines.push(`    # Subtest: ${name}`, `    ${tapStatus} ${index + 1} - ${name}${directive}`);
    counts[status] += 1;
  });
  lines.push(`    1..${statuses.length}`, `ok 1 - ${file}`, "1..1", `# tests ${reportedTests}`,
    "# suites 1", `# pass ${counts.passed}`, `# fail ${counts.failed}`, "# cancelled 0",
    `# skipped ${counts.skipped}`, `# todo ${counts.todo}`, "");
  return lines.join("\n");
}

function fakeSuiteRunner({ plan, skipFile = null, prerequisiteExit = 0, outputsByFile = {} }) {
  const calls = [];
  const run = async (command, args, { cwd, env, captureStdout }) => {
    calls.push({ command, args, cwd, env: { ...env }, captureStdout });
    if (command === EDGE_NODE) {
      if (args[0] === "./cloud-run/build.mjs") return { exitCode: prerequisiteExit, stdout: "" };
      assert.deepEqual(args.slice(0, EDGE_E2E_NODE_FLAGS.length + 1), [...EDGE_E2E_NODE_FLAGS, "--test"]);
    } else {
      assert.equal(command, process.execPath);
    }
    if (args.includes("run")) {
      const config = args[args.indexOf("--config") + 1];
      const output = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
      const files = plan.files.filter(({ runner }) => runner === `vitest:${config}`);
      await writeFile(output, JSON.stringify(vitestReport(files.map(({ file }) => ({
        file, assertions: [[["synthetic"], "passes", "passed"]],
      })))));
      return { exitCode: 0, stdout: "" };
    }
    const file = args.at(-1).slice(2);
    if (outputsByFile[file] !== undefined) return outputsByFile[file];
    if (file === skipFile) {
      return { exitCode: 0, stdout: `TAP version 13
# Subtest: gated
ok 1 - gated # SKIP
  ---
  type: 'test'
  ...
1..1
# tests 1
# pass 0
# fail 0
# cancelled 0
# skipped 1
# todo 0
` };
    }
    return { exitCode: 0, stdout: passingTapFor(`${file} test`) };
  };
  return { run, calls };
}

const edgeAvailable = async () => ({ available: true, node: EDGE_NODE });

test("the runner sends each file to its routed profile and never sets PG_TEST_PASSWORD", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const { run, calls } = fakeSuiteRunner({ plan });
  const summary = await runPostgresSuite({
    workerRoot: WORKER_ROOT,
    environment: { PATH: "/usr/bin", PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432", PGPASSWORD_UNRELATED: "x" },
    run,
    onOutput: () => {},
    plan,
    probeEdgeE2e: edgeAvailable,
  });
  assert.equal(summary.status, "passed", JSON.stringify(summary.failures));
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.files, plan.files.length);
  assert.equal(summary.tests, plan.files.length);
  assert.equal(summary.passedByPass.HOST, EXPECTED_HOST_PROFILE_FILES.length);

  const vitestCalls = calls.filter(({ args }) => args.includes("run"));
  assert.deepEqual(vitestCalls.map(({ args }) => args.slice(1, 4)), [
    ["run", "--config", "vitest.postgres.config.ts"],
    ["run", "--config", "vitest.node.config.ts"],
  ]);
  for (const call of vitestCalls) {
    assert.ok(call.args.includes("--reporter=json"));
    assert.ok(call.args.some((arg) => arg.startsWith("--outputFile=")));
  }
  const nodeCalls = calls.filter(({ args }) => args[0] === "--test");
  for (const call of calls) {
    assert.equal(call.cwd, WORKER_ROOT);
    assert.equal(call.env.PG_TEST_PASSWORD, undefined);
    assert.equal(call.env.PG_TEST_PORT, "5432");
  }
  for (const call of nodeCalls) {
    assert.deepEqual(call.args.slice(0, 3), ["--test", "--test-concurrency=1", "--test-reporter=tap"]);
    const file = call.args[3].slice(2);
    if (EXPECTED_HOST_PROFILE_FILES.includes(file)) {
      assert.equal(call.env.PG_TEST_HOST, SOCKET, file);
      assert.equal(call.env.PG_TEST_SOCKET, undefined, file);
    } else {
      assert.equal(call.env.PG_TEST_SOCKET, SOCKET, file);
      assert.equal(call.env.PG_TEST_HOST, undefined, file);
    }
  }
  for (const call of vitestCalls) {
    assert.equal(call.env.PG_TEST_SOCKET, SOCKET);
    assert.equal(call.env.PG_TEST_HOST, undefined);
  }
  const hostCalls = nodeCalls.filter(({ env }) => env.PG_TEST_HOST !== undefined).map(({ args }) => args[3].slice(2));
  assert.deepEqual(hostCalls.sort(), [...EXPECTED_HOST_PROFILE_FILES].sort());
  const routedCalls = nodeCalls.filter(({ command }) => command === process.execPath);
  assert.ok(routedCalls.findIndex(({ env }) => env.PG_TEST_HOST !== undefined)
    > routedCalls.findLastIndex(({ env }) => env.PG_TEST_SOCKET !== undefined), "SOCKET pass runs first");
  const edgeCalls = calls.filter(({ command }) => command === EDGE_NODE);
  assert.deepEqual(edgeCalls.map(({ args }) => args), [
    ["./cloud-run/build.mjs"],
    ["--experimental-strip-types", "--test", "--test-concurrency=1", "--test-reporter=tap", `./${EDGE_SPEC}`],
  ], "EDGE_E2E runs last, through edge:e2e's own steps, under the image runtime with type stripping");
  assert.ok(calls.indexOf(edgeCalls[0]) > calls.findLastIndex(({ env }) => env.PG_TEST_HOST !== undefined));
  for (const call of edgeCalls) {
    assert.equal(call.env.PG_TEST_SOCKET, SOCKET);
    assert.equal(call.env.PG_TEST_HOST, undefined);
  }
  assert.equal(summary.passedByPass.EDGE_E2E, 1);
  assert.deepEqual(summary.environmentGaps, []);
});

test("current D7 requires 20 parsed tests only for its explicit registered EDGE_E2E file", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const runEdge = async ({ file = EDGE_SPEC, statuses, mode, reportedTests }) => {
    const selectedPlan = file === EDGE_SPEC ? plan : {
      failures: [],
      files: [{ file, profile: PROFILE_EDGE_E2E, runner: "script:edge:e2e", source: "edge:e2e",
        prerequisites: ["node ./cloud-run/build.mjs"], testFlags: ["--test-concurrency=1"] }],
    };
    const tap = tapForStatuses(file, statuses, { reportedTests });
    const { run } = fakeSuiteRunner({ plan: selectedPlan,
      outputsByFile: { [file]: { exitCode: statuses.includes("failed") ? 1 : 0, stdout: tap } } });
    return runPostgresSuite({
      workerRoot: WORKER_ROOT,
      environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432",
        ...(mode === undefined ? {} : { EDGE_E2E_S9_COMPARISON_MODE: mode }) },
      run,
      onOutput: () => {},
      plan: selectedPlan,
      ...(file === EDGE_SPEC ? { partition: "EDGE_E2E" } : {}),
      probeEdgeE2e: edgeAvailable,
    });
  };
  const passing = (count) => Array.from({ length: count }, () => "passed");

  for (const count of [19, 21]) {
    const summary = await runEdge({ statuses: passing(count), mode: "current-worker-d1-d7",
      reportedTests: count === 19 ? 20 : count });
    assert.equal(summary.status, "failed", `${count} parsed tests cannot qualify current D7`);
    assert.deepEqual(summary.failures.filter(({ code }) => code === "TAP_TEST_COUNT_MISMATCH")
      .map(({ file, pass }) => [file, pass]), [[EDGE_SPEC, PROFILE_EDGE_E2E]]);
  }

  const accepted = await runEdge({ statuses: passing(20), mode: "current-worker-d1-d7" });
  assert.deepEqual([accepted.status, accepted.tests, accepted.passedByPass.EDGE_E2E], ["passed", 20, 20]);
  assert.deepEqual(accepted.failures, []);

  const skipped = await runEdge({ statuses: [...passing(19), "skipped"], mode: "current-worker-d1-d7" });
  assert.equal(skipped.tests, 20, "the count is based on parsed TAP leaves");
  assert.equal(skipped.status, "failed");
  assert.deepEqual(codes(skipped.failures), ["SILENTLY_SKIPPED"]);

  const failed = await runEdge({ statuses: [...passing(19), "failed"], mode: "current-worker-d1-d7" });
  assert.equal(failed.tests, 20);
  assert.equal(failed.status, "failed");
  assert.deepEqual(codes(failed.failures), ["FAILED"]);

  for (const [mode, count] of [["current-worker-d1", 15], ["historical", 15], [undefined, 19]]) {
    const summary = await runEdge({ statuses: passing(count), mode });
    assert.equal(summary.status, "passed", `${mode ?? "unset mode"} keeps its existing count behavior`);
    assert.equal(summary.tests, count);
    assert.deepEqual(summary.failures, []);
  }

  const otherRegisteredScriptFile = await runEdge({ file: "postgres-test/synthetic-edge.spec.mjs",
    statuses: passing(19), mode: "current-worker-d1-d7" });
  assert.equal(otherRegisteredScriptFile.status, "passed",
    "the current D7 count belongs only to the canonical registered edge file");
  assert.equal(otherRegisteredScriptFile.tests, 19);
});

test("a skip inside the routed pass fails the whole run", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const { run } = fakeSuiteRunner({ plan, skipFile: "postgres-test/typed-v12-normalized.spec.mjs" });
  const summary = await runPostgresSuite({
    workerRoot: WORKER_ROOT,
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    run,
    onOutput: () => {},
    plan,
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.skipped, [{
    file: "postgres-test/typed-v12-normalized.spec.mjs",
    test: "gated",
    pass: "HOST",
  }]);
  assert.deepEqual(codes(summary.failures), ["SILENTLY_SKIPPED"]);
});

test("a static plan failure fails the run before any spec process starts", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const unregistered = Object.freeze({
    code: "UNREGISTERED_POSTGRES_SPEC",
    file: "postgres-test/new-synthetic.spec.mjs",
  });
  const calls = [];
  const summary = await runPostgresSuite({
    workerRoot: WORKER_ROOT,
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    run: async (...args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "" };
    },
    onOutput: () => {},
    plan: { ...plan, failures: [unregistered] },
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.failures, [unregistered]);
  assert.equal(summary.tests, 0);
  assert.deepEqual(calls, [], "no spec runs while the plan has failures");
});

test("the caller supplies only the SOCKET profile; the runner builds each pass environment", () => {
  assert.deepEqual(readSocketProfileInput({ PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" }),
    { socket: SOCKET, port: "5432" });
  for (const extra of ["PG_TEST_HOST", "PG_TEST_PASSWORD", "PG_TEST_USER"]) {
    assert.throws(() => readSocketProfileInput({ PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432", [extra]: "x" }),
      /CI_SUITE_PROFILE_INVALID/u);
  }
  assert.throws(() => readSocketProfileInput({ PG_TEST_SOCKET: "/tmp/socket", PG_TEST_PORT: "5432" }),
    /CI_SUITE_PROFILE_INVALID/u);
  assert.throws(() => readSocketProfileInput({ PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "0" }),
    /CI_SUITE_PROFILE_INVALID/u);
  assert.deepEqual(passEnvironment({ PATH: "/bin", PG_TEST_HOST: "stale" }, "SOCKET", { socket: SOCKET, port: "5432" }),
    { PATH: "/bin", PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" });
  assert.deepEqual(passEnvironment({ PATH: "/bin", PG_TEST_SOCKET: "stale" }, "HOST", { socket: SOCKET, port: "5432" }),
    { PATH: "/bin", PG_TEST_HOST: SOCKET, PG_TEST_PORT: "5432" });
});

test("the CI container's loopback TCP pair is its published port and passes the suite's profile reader", () => {
  assert.deepEqual(ciPostgresTcpProfile(), { PG_TEST_TCP_HOST: "127.0.0.1", PG_TEST_TCP_PORT: "55432" });
  assert.deepEqual(Object.keys(ciPostgresProfiles().socket), ["PG_TEST_SOCKET", "PG_TEST_PORT"],
    "the exported SOCKET profile stays socket-only");
  assert.deepEqual(readSocketProfileInput({ ...ciPostgresProfiles().socket, ...ciPostgresTcpProfile() }),
    { socket: ciPostgresProfiles().socket.PG_TEST_SOCKET, port: "5432", tcpHost: "127.0.0.1", tcpPort: "55432" });
  for (const publish of ["0.0.0.0:55432:5432", "127.0.0.1:55432:5433"]) {
    assert.throws(() => ciPostgresTcpProfile(publish), /CI_POSTGRES_PROFILE_INVALID/u, publish);
  }
});

test("the loopback TCP pair is optional, set together, loopback only, and reaches the SOCKET pass alone", () => {
  const tcp = { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432", PG_TEST_TCP_HOST: "127.0.0.1", PG_TEST_TCP_PORT: "55432" };
  const profile = readSocketProfileInput(tcp);
  assert.deepEqual(profile, { socket: SOCKET, port: "5432", tcpHost: "127.0.0.1", tcpPort: "55432" });
  assert.deepEqual(passEnvironment({ PATH: "/bin", ...tcp }, "SOCKET", profile),
    { PATH: "/bin", PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432", PG_TEST_TCP_HOST: "127.0.0.1", PG_TEST_TCP_PORT: "55432" });
  assert.deepEqual(passEnvironment({ PATH: "/bin", ...tcp }, "HOST", profile),
    { PATH: "/bin", PG_TEST_HOST: SOCKET, PG_TEST_PORT: "5432" }, "HOST specs never dial TCP");
  assert.deepEqual(passEnvironment({ PATH: "/bin", ...tcp }, "EDGE_E2E", profile),
    { PATH: "/bin", PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" });
  for (const edit of [
    (value) => { delete value.PG_TEST_TCP_PORT; },
    (value) => { delete value.PG_TEST_TCP_HOST; },
    (value) => { value.PG_TEST_TCP_HOST = "10.0.0.5"; },
    (value) => { value.PG_TEST_TCP_PORT = "0"; },
    (value) => { value.PG_TEST_TCP_PORT = "70000"; },
  ]) {
    const value = { ...tcp };
    edit(value);
    assert.throws(() => readSocketProfileInput(value), /CI_SUITE_PROFILE_INVALID/u, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// Extra registration scripts and the explicit EDGE_E2E profile
// ---------------------------------------------------------------------------

test("the extra registration scripts are frozen, and only edge:e2e has an explicit profile", () => {
  assert.deepEqual(EXTRA_REGISTRATION_SCRIPTS, ["edge:e2e", "postgres:production-migrations:check"]);
  assert.deepEqual(SCRIPT_PROFILES, { "edge:e2e": PROFILE_EDGE_E2E });
  assert.deepEqual(EXTRA_SCRIPT_PREREQUISITES, ["node ./cloud-run/build.mjs"]);
  for (const value of [EXTRA_REGISTRATION_SCRIPTS, SCRIPT_PROFILES, EXTRA_SCRIPT_PREREQUISITES]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("the real plan has no failures: edge-origin-e2e runs in EDGE_E2E and the production migration spec in SOCKET", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  assert.deepEqual(plan.failures, []);
  const edge = plan.files.find(({ file }) => file === EDGE_SPEC);
  assert.deepEqual({ runner: edge.runner, source: edge.source, profile: edge.profile, prerequisites: edge.prerequisites,
    testFlags: edge.testFlags }, {
    runner: "script:edge:e2e", source: "edge:e2e", profile: PROFILE_EDGE_E2E,
    prerequisites: ["node ./cloud-run/build.mjs"], testFlags: ["--test-concurrency=1"],
  });
  const production = plan.files.find(({ file }) => file === PRODUCTION_MIGRATIONS_SPEC);
  assert.deepEqual({ runner: production.runner, source: production.source, profile: production.profile },
    { runner: "node", source: "postgres:production-migrations:check", profile: "SOCKET" });
  assert.equal(plan.files.find(({ file }) => file === JOURNAL_TRANSFER_SPEC).profile, "SOCKET");
  assert.equal(plan.files.filter(({ profile }) => profile === PROFILE_EDGE_E2E).length, 1);
  for (const file of [EDGE_SPEC, PRODUCTION_MIGRATIONS_SPEC]) {
    assert.equal(UNREGISTERED_ALLOWLIST.includes(file), false, `${file} is registered, not allowlisted`);
  }
  const registration = await loadRegistration(WORKER_ROOT);
  const { registered } = checkRegistrationRatchet({ onDisk: await listPostgresTestFiles(WORKER_ROOT), registration });
  assert.deepEqual(registered.get(EDGE_SPEC), ["edge:e2e"]);
  assert.deepEqual(registered.get(PRODUCTION_MIGRATIONS_SPEC), ["postgres:production-migrations:check"]);
});

test("extra registration scripts parse closed: specs, non-PostgreSQL checks and allowlisted prerequisites only", () => {
  assert.deepEqual(parseExtraRegistrationScript("edge:e2e",
    "node ./cloud-run/build.mjs && node --test --test-concurrency=1 ./postgres-test/edge-origin-e2e.spec.mjs"), {
    nodeFiles: [EDGE_SPEC], testFlags: ["--test-concurrency=1"], prerequisites: ["node ./cloud-run/build.mjs"],
  });
  assert.deepEqual(parseExtraRegistrationScript("x",
    "node --test ./cloud-run/a.check.mjs ./scripts/b.check.mjs && node --test ./postgres-test/c.spec.mjs").nodeFiles,
  ["postgres-test/c.spec.mjs"], "non-PostgreSQL checks are accepted but never registered as specs");
  for (const script of [
    undefined,
    "",
    "node --test ./cloud-run/a.check.mjs",
    "npm run edge:e2e",
    "node ./scripts/other-build.mjs && node --test ./postgres-test/a.spec.mjs",
    "node --test ./postgres-test/a.spec.mjs && node ./cloud-run/build.mjs",
    "node --test ./cloud-run/server.mjs ./postgres-test/a.spec.mjs",
    "node --test ./test/a.spec.mjs",
    "node --test --import ./setup.mjs ./postgres-test/a.spec.mjs",
    "vitest run --config vitest.postgres.config.ts",
    "node --test ./postgres-test/a.spec.mjs; node --test ./postgres-test/b.spec.mjs",
  ]) {
    assert.throws(() => parseExtraRegistrationScript("synthetic", script), /REGISTRATION_PARSE_FAILED/u, String(script));
  }
});

test("removing, emptying or double-registering an extra script fails the plan closed", async () => {
  for (const [name, edit, expected] of [
    ["edge:e2e", (scripts) => { delete scripts["edge:e2e"]; }, ["REGISTRATION_PARSE_FAILED"]],
    ["postgres:production-migrations:check",
      (scripts) => { scripts["postgres:production-migrations:check"] = "node --test ./cloud-run/postgres-runtime-grants.check.mjs"; },
      ["REGISTRATION_PARSE_FAILED"]],
    ["postgres:domain:check", (scripts) => { scripts["postgres:domain:check"] += ` ./${PRODUCTION_MIGRATIONS_SPEC}`; },
      ["REGISTRATION_DUPLICATE"]],
  ]) {
    await withWorkerCopy(async (root) => {
      await editJson(join(root, "package.json"), (value) => edit(value.scripts));
      const plan = await planPostgresSuite({ workerRoot: root });
      assert.deepEqual(codes(plan.failures), expected, name);
    });
  }
});

test("an explicit-profile spec that derives HOST fails PROFILE_ROUTING_DRIFT", async () => {
  await withWorkerCopy(async (root) => {
    const edge = join(root, EDGE_SPEC);
    // Its gates read a local SKIP; rewrite them to read PG_TEST_HOST alone.
    await writeFile(edge, (await readFile(edge, "utf8")).replaceAll("skip: SKIP", "skip: !process.env.PG_TEST_HOST"));
    const plan = await planPostgresSuite({ workerRoot: root, expectedHostFiles: [...EXPECTED_HOST_PROFILE_FILES, EDGE_SPEC] });
    assert.deepEqual(plan.failures.map(({ code, file, detail }) => [code, file, detail]), [
      ["PROFILE_ROUTING_DRIFT", EDGE_SPEC, `explicit ${PROFILE_EDGE_E2E} specs read the SOCKET profile`],
    ]);
  });
});

test("the journal-transfer gate resolves statically; an unbound PG_TEST_* gate is still ambiguous", async () => {
  const source = await readFile(join(WORKER_ROOT, JOURNAL_TRANSFER_SPEC), "utf8");
  assert.match(source, /const PG_TEST_TCP_HOST = process\.env\.PG_TEST_TCP_HOST;/u,
    "no default host: a socket-only cluster never dials TCP");
  assert.match(source, /localFastpathTcpPort\(\{ PG_TEST_TCP_PORT: process\.env\.PG_TEST_TCP_PORT \}, PG_TEST_PORT\)/u);
  assert.match(source, /port: PG_TEST_TCP_PORT \}/u, "the TCP pool dials PG_TEST_TCP_PORT, not the socket's port");
  assert.match(source, /describe\.skipIf\(!PG_TEST_SOCKET \|\| !PG_TEST_TCP_HOST\)\(/u,
    "the second describe runs only where the suite (or the caller) supplies the loopback TCP pair");
  assert.deepEqual(deriveFileProfile(source), { profile: "SOCKET", ambiguous: false, gates: ["SOCKET", "SOCKET"], reasons: [] });
  const helper = deriveFileProfile(`
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_TCP_HOST = localFastpathTcpHost();
describe.skipIf(!PG_TEST_SOCKET || !PG_TEST_TCP_HOST)("suite", () => {});
`);
  assert.deepEqual([helper.ambiguous, helper.reasons], [true, ["unresolved PG_TEST_TCP_HOST"]],
    "the pre-fix binding stays ambiguous, so the planner never guesses");
});

test("without the EDGE_E2E runtime the spec is a named environment gap: never run, never green, never skipped", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const { run, calls } = fakeSuiteRunner({ plan });
  const summary = await runPostgresSuite({
    workerRoot: WORKER_ROOT,
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    run,
    onOutput: () => {},
    plan,
  });
  assert.equal(summary.status, "incomplete");
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.environmentGaps.length, 1);
  assert.deepEqual({ ...summary.environmentGaps[0], detail: undefined },
    { code: "ENVIRONMENT_GAP", file: EDGE_SPEC, profile: PROFILE_EDGE_E2E, detail: undefined });
  assert.match(summary.environmentGaps[0].detail, new RegExp(`${EDGE_E2E_NODE_VARIABLE} must name the Node v22\\.16\\.0`, "u"));
  assert.match(summary.environmentGaps[0].detail, new RegExp(`${EDGE_E2E_GOLDEN_VARIABLE} is unset`, "u"));
  assert.equal(calls.some(({ args }) => args.includes(`./${EDGE_SPEC}`) || args[0] === "./cloud-run/build.mjs"), false,
    "no edge process starts without its runtime");
  assert.equal(summary.passedByPass.EDGE_E2E, 0);
});

test("the EDGE_E2E probe names each missing piece and accepts only the image runtime", async () => {
  const version = (stdout, exitCode = 0) => async (command, args) => {
    assert.deepEqual([command, args], [EDGE_NODE, ["--version"]]);
    return { exitCode, stdout };
  };
  const environment = { [EDGE_E2E_NODE_VARIABLE]: EDGE_NODE, [EDGE_E2E_GOLDEN_VARIABLE]: EDGE_GOLDEN };
  assert.deepEqual(await probeEdgeE2eEnvironment({ workerRoot: WORKER_ROOT, environment,
    run: version(`${EDGE_E2E_NODE_VERSION}\n`) }), { available: true, node: EDGE_NODE });
  for (const [label, probe, reason] of [
    ["wrong Node", { environment, run: version("v26.2.0\n") }, /does not report v22\.16\.0/u],
    ["Node fails", { environment, run: version("", 1) }, /does not report v22\.16\.0/u],
    ["relative Node", { environment: { ...environment, [EDGE_E2E_NODE_VARIABLE]: "node" }, run: version("") },
      /must name the Node/u],
    ["no golden", { environment: { [EDGE_E2E_NODE_VARIABLE]: EDGE_NODE }, run: version(`${EDGE_E2E_NODE_VERSION}\n`) },
      /EDGE_E2E_GOLDEN is unset/u],
  ]) {
    const result = await probeEdgeE2eEnvironment({ workerRoot: WORKER_ROOT, ...probe });
    assert.equal(result.available, false, label);
    assert.match(result.reasons.join("; "), reason, label);
  }
  const withoutWorkerd = await probeEdgeE2eEnvironment({ workerRoot: tmpdir(), environment,
    run: version(`${EDGE_E2E_NODE_VERSION}\n`) });
  assert.deepEqual(withoutWorkerd, { available: false, reasons: ["workerd is not installed in the Worker's node_modules"] });
});

test("a failing EDGE_E2E prerequisite fails the run and the spec does not start", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const { run, calls } = fakeSuiteRunner({ plan, prerequisiteExit: 1 });
  const summary = await runPostgresSuite({
    workerRoot: WORKER_ROOT,
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    run,
    onOutput: () => {},
    plan,
    probeEdgeE2e: edgeAvailable,
  });
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.failures.map(({ code, file }) => [code, file]), [
    ["PREREQUISITE_FAILED", EDGE_SPEC],
    ["EMPTY_SPEC_FILE", EDGE_SPEC],
  ]);
  assert.equal(calls.some(({ args }) => args.includes(`./${EDGE_SPEC}`)), false);
});

test("only an explicit-profile spec may be a gap, and a gap may not also report results", () => {
  const plan = { files: [
    { file: EDGE_SPEC, profile: PROFILE_EDGE_E2E },
    { file: "postgres-test/socket.spec.mjs", profile: "SOCKET" },
  ] };
  const passing = tapParse(PASSING_TAP);
  const socketRecord = nodeRecord("SOCKET", "postgres-test/socket.spec.mjs", passing);
  let summary = evaluatePostgresSuite({ plan, records: [socketRecord], environmentGaps: [
    { code: "ENVIRONMENT_GAP", file: EDGE_SPEC, profile: PROFILE_EDGE_E2E, detail: "synthetic" },
  ] });
  assert.deepEqual([summary.status, summary.failures, summary.environmentGaps.length], ["incomplete", [], 1]);
  summary = evaluatePostgresSuite({ plan, records: [], environmentGaps: [
    { code: "ENVIRONMENT_GAP", file: "postgres-test/socket.spec.mjs", profile: "SOCKET", detail: "synthetic" },
    { code: "ENVIRONMENT_GAP", file: EDGE_SPEC, profile: PROFILE_EDGE_E2E, detail: "synthetic" },
  ] });
  assert.deepEqual(summary.failures.map(({ code, file }) => [code, file]), [
    ["UNPLANNED_SPEC_RESULT", "postgres-test/socket.spec.mjs"],
    ["EMPTY_SPEC_FILE", "postgres-test/socket.spec.mjs"],
  ]);
  summary = evaluatePostgresSuite({ plan, records: [socketRecord, nodeRecord(PROFILE_EDGE_E2E, EDGE_SPEC, passing)],
    environmentGaps: [{ code: "ENVIRONMENT_GAP", file: EDGE_SPEC, profile: PROFILE_EDGE_E2E, detail: "synthetic" }] });
  assert.deepEqual(codes(summary.failures), ["PROFILE_ROUTING_DRIFT"]);
  summary = evaluatePostgresSuite({ plan, records: [socketRecord, nodeRecord(PROFILE_EDGE_E2E, EDGE_SPEC, passing)] });
  assert.deepEqual([summary.status, summary.passedByPass.EDGE_E2E], ["passed", 2]);
});

// ---------------------------------------------------------------------------
// Container bring-up (fake docker, no database)
// ---------------------------------------------------------------------------

async function withPrivateTmp(callback) {
  const privateTmp = await mkdtemp(join(tmpdir(), "tibotattle-ci-private-tmp-"));
  await chmod(privateTmp, 0o1777);
  try {
    return await callback({
      privateTmpDirectory: privateTmp,
      workDirectory: join(privateTmp, "tibotattle-pg-ci"),
      privateTmpOwnerUid: process.getuid(),
    });
  } finally {
    await rm(privateTmp, { recursive: true, force: true });
  }
}

function fakeDocker({
  onRun = () => {},
  logs = `${INIT_COMPLETE_MARKER}\n`,
  state = "running",
  exists = false,
  readyAfter = 0,
  rmStatus = 0,
} = {}) {
  const calls = [];
  let readinessProbes = 0;
  const run = (command, args) => {
    assert.equal(command, "docker");
    calls.push(args);
    switch (args[0]) {
      case "ps": return { status: 0, stdout: exists ? "0123456789ab\n" : "", stderr: "" };
      case "pull": return { status: 0, stdout: "", stderr: "" };
      case "run": onRun(args); return { status: 0, stdout: "container-id\n", stderr: "" };
      case "inspect": return { status: 0, stdout: `${state}\n`, stderr: "" };
      case "logs": return { status: 0, stdout: logs, stderr: "" };
      case "exec": readinessProbes += 1; return { status: readinessProbes > readyAfter ? 0 : 2, stdout: "", stderr: "" };
      case "rm": return { status: rmStatus, stdout: "", stderr: "" };
      default: throw new Error(`unexpected docker ${args[0]}`);
    }
  };
  return { run, calls };
}

function fakeClient(row = { server_version_num: "170011", unix_socket: true }) {
  const seen = [];
  return {
    seen,
    createClient(config) {
      seen.push(config);
      return {
        async connect() {},
        async query() { return { rows: [row] }; },
        async end() {},
      };
    },
  };
}

test("the container runs the digest-pinned PostgreSQL 17 image as the caller with a private socket mount", () => {
  assert.match(POSTGRES_IMAGE, /^postgres:17\.\d+-bookworm@sha256:[0-9a-f]{64}$/u);
  const args = dockerRunArguments({ uid: 1001, gid: 118 });
  const pairs = (flag) => args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
  assert.deepEqual(pairs("--user"), ["1001:118"]);
  assert.deepEqual(pairs("--platform"), ["linux/amd64"], "the amd64 digest never runs under emulation");
  assert.deepEqual(pairs("--publish"), ["127.0.0.1:55432:5432"]);
  assert.deepEqual(pairs("--env"), ["POSTGRES_HOST_AUTH_METHOD=trust"]);
  assert.deepEqual(pairs("--volume"), [
    "/etc/passwd:/etc/passwd:ro",
    `${CI_WORK_DIRECTORY}/data:/var/lib/postgresql/data`,
    `${CI_WORK_DIRECTORY}/socket:${CONTAINER_SOCKET_DIRECTORY}`,
  ]);
  // The image entrypoint runs `chmod 03775 /var/run/postgresql`; never mount the socket there.
  assert.ok(!args.some((value) => value.includes(":/var/run/postgresql") || value.includes(":/run/postgresql")));
  // Its init step runs psql with PGHOST emptied, so the server must also listen
  // in the image's default (unmounted) directory or first-run init fails.
  assert.deepEqual(args.slice(args.indexOf(POSTGRES_IMAGE) + 1), [
    "-c", `unix_socket_directories=${CONTAINER_SOCKET_DIRECTORY},/var/run/postgresql`,
    "-c", "port=5432",
    "-c", "fsync=off",
  ]);
  assert.deepEqual(ciPostgresProfiles(SOCKET), {
    socket: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" },
    host: { PG_TEST_HOST: SOCKET, PG_TEST_PORT: "5432" },
  });
});

test("bring-up creates 0700 caller-owned directories, waits for the final server and proves PostgreSQL 17 over the socket", async () => {
  await withPrivateTmp(async (paths) => {
    const docker = fakeDocker({ readyAfter: 2 });
    const client = fakeClient();
    const result = await startCiPostgres({
      platform: "linux", arch: "x64", uid: process.getuid(), gid: process.getgid(),
      ...paths, run: docker.run, createClient: client.createClient, sleep: async () => {},
    });
    assert.equal(result.status, "ready");
    assert.equal(result.serverVersionNum, "170011");
    assert.deepEqual(result.profiles.socket, {
      PG_TEST_SOCKET: join(paths.workDirectory, "socket"),
      PG_TEST_PORT: "5432",
    });
    for (const directory of ["", "socket", "data"]) {
      const metadata = await stat(join(paths.workDirectory, directory));
      assert.equal(metadata.mode & 0o7777, 0o700);
      assert.equal(metadata.uid, process.getuid());
    }
    assert.deepEqual(docker.calls.map((args) => args[0]),
      ["ps", "pull", "run", "inspect", "logs", "exec", "inspect", "logs", "exec", "inspect", "logs", "exec"]);
    assert.deepEqual(client.seen.map(({ host, port, user, ssl }) => [host, port, user, ssl]),
      [[join(paths.workDirectory, "socket"), 5432, "postgres", false]]);
    assert.equal(client.seen[0].password, undefined);
  });
});

test("an entrypoint that loosens the socket directory fails CI_SOCKET_DIR_MODE_CHANGED", async () => {
  await withPrivateTmp(async (paths) => {
    const docker = fakeDocker({
      onRun: () => {
        chmodSync(join(paths.workDirectory, "socket"), 0o3775);
      },
    });
    await assert.rejects(startCiPostgres({
      platform: "linux", arch: "x64", uid: process.getuid(), gid: process.getgid(),
      ...paths, run: docker.run, createClient: fakeClient().createClient, sleep: async () => {},
    }), /CI_SOCKET_DIR_MODE_CHANGED/u);
  });
});

test("bring-up fails closed on the wrong server, a dead container, a timeout or unsafe directories", async () => {
  const base = { platform: "linux", arch: "x64", uid: process.getuid(), gid: process.getgid(), sleep: async () => {} };
  await withPrivateTmp(async (paths) => {
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker().run,
      createClient: fakeClient({ server_version_num: "160004", unix_socket: true }).createClient }),
    /CI_POSTGRES_VERSION_UNEXPECTED/u);
  });
  await withPrivateTmp(async (paths) => {
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker().run,
      createClient: fakeClient({ server_version_num: "170011", unix_socket: false }).createClient }),
    /CI_POSTGRES_NOT_UNIX_SOCKET/u);
  });
  await withPrivateTmp(async (paths) => {
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker({ state: "exited" }).run,
      createClient: fakeClient().createClient }), /CI_POSTGRES_CONTAINER_EXITED/u);
  });
  await withPrivateTmp(async (paths) => {
    let clock = 0;
    await assert.rejects(startCiPostgres({ ...base, ...paths,
      run: fakeDocker({ logs: "database system is ready to accept connections\n" }).run,
      createClient: fakeClient().createClient, now: () => (clock += 1_000), timeoutMs: 5_000 }),
    /CI_POSTGRES_READINESS_TIMEOUT/u, "the temporary init server never counts as ready");
  });
  await withPrivateTmp(async (paths) => {
    await mkdir(paths.workDirectory, { mode: 0o700 });
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker().run,
      createClient: fakeClient().createClient }), /CI_WORK_DIRECTORY_EXISTS/u);
  });
  await withPrivateTmp(async (paths) => {
    await chmod(paths.privateTmpDirectory, 0o777);
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker().run,
      createClient: fakeClient().createClient }), /CI_PRIVATE_TMP_UNSAFE/u);
  });
  await withPrivateTmp(async (paths) => {
    await assert.rejects(startCiPostgres({ ...base, ...paths, run: fakeDocker({ exists: true }).run,
      createClient: fakeClient().createClient }), /CI_POSTGRES_CONTAINER_EXISTS/u);
  });
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "arm64"], ["darwin", "x64"]]) {
    await assert.rejects(startCiPostgres({ ...base, platform, arch }),
      /CI_POSTGRES_PLATFORM_UNSUPPORTED/u, `${platform}/${arch}`);
  }
  await assert.rejects(verifyServer({ socketDirectory: SOCKET,
    createClient: fakeClient({ server_version_num: "180000", unix_socket: true }).createClient }),
  /CI_POSTGRES_VERSION_UNEXPECTED/u);
});

test("stop removes only the named container and tolerates its absence", () => {
  const absent = fakeDocker();
  assert.deepEqual(stopCiPostgres({ run: absent.run }), { status: "absent", container: CONTAINER_NAME });
  assert.deepEqual(absent.calls.map((args) => args[0]), ["ps"]);
  const present = fakeDocker({ exists: true });
  assert.deepEqual(stopCiPostgres({ run: present.run }), { status: "stopped", container: CONTAINER_NAME });
  assert.deepEqual(present.calls.at(-1), ["rm", "--force", CONTAINER_NAME]);
  assert.throws(() => stopCiPostgres({ run: fakeDocker({ exists: true, rmStatus: 1 }).run }),
    /CI_POSTGRES_STOP_FAILED/u);
});

test("the socket directory check rejects another owner, a symlink, a loose mode or a missing directory", async () => {
  await withPrivateTmp(async ({ privateTmpDirectory }) => {
    const directory = join(privateTmpDirectory, "socket");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const code = "CI_SOCKET_DIR_MODE_CHANGED";
    await verifyPrivateDirectory(directory, { uid: process.getuid(), code });
    await assert.rejects(verifyPrivateDirectory(directory, { uid: process.getuid() + 1, code }),
      /CI_SOCKET_DIR_MODE_CHANGED/u, "another uid owns it");
    const link = join(privateTmpDirectory, "socket-link");
    await symlink(directory, link);
    await assert.rejects(verifyPrivateDirectory(link, { uid: process.getuid(), code }),
      /CI_SOCKET_DIR_MODE_CHANGED/u, "a symlink to a private directory");
    await chmod(directory, 0o750);
    await assert.rejects(verifyPrivateDirectory(directory, { uid: process.getuid(), code }),
      /CI_SOCKET_DIR_MODE_CHANGED/u, "group-readable");
    await assert.rejects(verifyPrivateDirectory(join(privateTmpDirectory, "missing"), { uid: process.getuid(), code }),
      /CI_SOCKET_DIR_MODE_CHANGED/u, "missing");
  });
});

test("only the SOCKET profile is exported to the GitHub environment file", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-ci-github-env-"));
  try {
    const file = join(root, "github-env");
    await writeFile(file, "EXISTING=1\n");
    await exportSocketProfile(ciPostgresProfiles(SOCKET), file);
    assert.equal(await readFile(file, "utf8"),
      `EXISTING=1\nPG_TEST_SOCKET=${SOCKET}\nPG_TEST_PORT=5432\n`);
    await assert.rejects(exportSocketProfile(ciPostgresProfiles(SOCKET), "relative"),
      /CI_GITHUB_ENV_UNAVAILABLE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


// Complete CI scheduling proof: partition receipts never qualify the whole plan alone.
const receiptContextFixture = Object.freeze({ sourceHead: "a".repeat(40), planDigest: "b".repeat(64),
  runId: "1234", runAttempt: "2", toolchainNode: "v26.2.0", imageNode: "v22.16.0" });
const partitionJobsPassed = Object.freeze(Object.fromEntries(PARTITIONS.map((partition) => [partition, "success"])));
async function mockPartitionReceipts({ skipFile = null, probe = edgeAvailable } = {}) {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const receipts = [];
  const calls = [];
  for (const partition of PARTITIONS) {
    const mock = fakeSuiteRunner({ plan, skipFile });
    let execution = null;
    const summary = await runPostgresSuite({ workerRoot: WORKER_ROOT, plan, partition,
      environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" }, run: mock.run,
      onOutput: () => {}, onProgress: () => {}, probeEdgeE2e: probe,
      onRecords: (value) => { execution = value; } });
    receipts.push(createPostgresReceipt({ plan, context: receiptContextFixture, partition, execution, executionInputs: executionInputsFixture(partition) }));
    calls.push(...mock.calls);
    if (skipFile === null && probe === edgeAvailable) assert.equal(summary.status, "passed");
  }
  return { plan, receipts, calls };
}
const aggregateMock = ({ plan, receipts, context = receiptContextFixture, jobResults = partitionJobsPassed }) =>
  aggregatePostgresReceipts({ plan, receipts, context, jobResults, ownership: buildOwnershipFixture });

test("closed CORE shards and EDGE_E2E execute the exact full canonical plan once without splitting Vitest configs", async () => {
  const { plan, receipts, calls } = await mockPartitionReceipts();
  const core = PARTITIONS.filter((partition) => partition !== "EDGE_E2E")
    .map((partition) => partitionPostgresPlan(plan, partition));
  const edge = partitionPostgresPlan(plan, "EDGE_E2E");
  assert.equal(plan.files.length, 95, "canonical PostgreSQL suite size is reviewed explicitly");
  assert.equal(core.length, 2, "exactly two reviewed CORE shards");
  assert.deepEqual(core.map(({ files }) => files.length), [54, 40], "CORE_A/CORE_B cardinalities are reviewed explicitly");
  assert.equal(edge.files.length, 1, "exactly one reviewed EDGE file");
  assert.deepEqual(edge.files.map(({ file, runner, profile }) => ({ file, runner, profile })),
    [{ file: EDGE_SPEC, runner: "script:edge:e2e", profile: "EDGE_E2E" }]);
  const partitionFiles = [...core.flatMap(({ files }) => files), ...edge.files];
  assert.equal(partitionFiles.length, plan.files.length);
  assert.equal(new Set(partitionFiles.map(({ file }) => file)).size, plan.files.length);
  for (const config of VITEST_REGISTRATION_CONFIGS) {
    const groupFiles = plan.files.filter(({ runner }) => runner === `vitest:${config}`);
    const owners = core.filter(({ files }) => files.some(({ runner }) => runner === `vitest:${config}`));
    assert.equal(owners.length, groupFiles.length === 0 ? 0 : 1, `${config} remains indivisible`);
    assert.deepEqual(owners.flatMap(({ files }) => files.filter(({ runner }) => runner === `vitest:${config}`)), groupFiles);
  }
  assert.equal(calls.filter(({ command, args }) => command === EDGE_NODE && args[0] === "./cloud-run/build.mjs").length, 1);
  const aggregate = aggregateMock({ plan, receipts });
  assert.equal(aggregate.status, "passed");
  assert.equal(aggregate.scope, "complete");
  assert.equal(aggregate.files, plan.files.length);
  assert.equal(aggregate.tests, plan.files.length);
  assert.equal(aggregate.passedByPass.EDGE_E2E, 1);
  assert.deepEqual(aggregate.failures, []);
  assert.throws(() => partitionPostgresPlan(plan, "CORE"), /CI_SUITE_PARTITION_INVALID/u);
  assert.throws(() => partitionPostgresPlan({ ...plan, files: plan.files.filter(({ profile }) => profile !== "EDGE_E2E") }, "EDGE_E2E"), /empty partition/u);
  assert.throws(() => partitionPostgresPlan({ ...plan, files: [...plan.files, { file: "extra", profile: "UNKNOWN" }] }, "CORE_A"), /ownership drift/u);
  assert.throws(() => partitionPostgresPlan({ ...plan, files: [...plan.files, { file: "postgres-test/new-core.spec.mjs", profile: "SOCKET", runner: "node" }] }, "CORE_A"), /canonical CORE shard ownership drift/u);
  const edgeEntry = plan.files.find(({ profile }) => profile === "EDGE_E2E");
  assert.throws(() => partitionPostgresPlan({ ...plan, files: [...plan.files, { ...edgeEntry, file: "postgres-test/new-edge.spec.mjs" }] }, "EDGE_E2E"),
    /canonical EDGE partition ownership drift/u);
});

test("partition command modes are explicit, closed and preserve no-flag whole execution", () => {
  assert.deepEqual(parseSuiteArguments([]), { plan: false, partition: null, receipt: null, aggregate: null });
  assert.deepEqual(parseSuiteArguments(["--partition", "CORE_A", "--receipt", "/synthetic/core-a.json"]),
    { plan: false, partition: "CORE_A", receipt: "/synthetic/core-a.json", aggregate: null });
  assert.deepEqual(parseSuiteArguments(["--aggregate", "core-a.json", "core-b.json", "edge.json"]).aggregate,
    ["core-a.json", "core-b.json", "edge.json"]);
  for (const arguments_ of [["--partition", "CORE"], ["--receipt", "receipt.json"], ["--plan", "--receipt", "receipt.json"],
    ["--partition", "CORE_A", "--partition", "EDGE_E2E"], ["--aggregate", "one"], ["--aggregate", "one", "two"], ["--aggregate", "one", "two", "three", "four"],
    ["--plan", "--aggregate", "one", "two"], ["--filter", EDGE_SPEC]]) {
    assert.throws(() => parseSuiteArguments(arguments_), /CI_SUITE_USAGE/u, JSON.stringify(arguments_));
  }
});

test("aggregate refuses omitted, duplicate, extra or cross-owned partition inventories and records", async () => {
  const { plan, receipts } = await mockPartitionReceipts();
  for (const parts of [[receipts[0]], [receipts[0], receipts[0]], [...receipts, receipts[1]]]) {
    assert.equal(aggregateMock({ plan, receipts: parts }).status, "failed");
  }
  const mutate = (change) => { const copy = structuredClone(receipts); change(copy); return aggregateMock({ plan, receipts: copy }); };
  const first = (copy) => copy[0].records.find(({ files }) => files.length > 0);
  for (const [index, change] of [
    (copy) => copy[0].inventory.pop(),
    (copy) => copy[0].inventory.push({ file: "postgres-test/unplanned.spec.mjs", profile: "SOCKET", runner: "node" }),
    (copy) => copy[0].records.splice(0, 1),
    (copy) => first(copy).files.push(structuredClone(first(copy).files[0])),
    (copy) => first(copy).files[0].file = EDGE_SPEC,
    (copy) => first(copy).profile = "HOST",
    (copy) => first(copy).runner = "node",
    (copy) => { const record = first(copy); record.file = record.files[0].file; },
    (copy) => { const record = copy[0].records.find(({ runner }) => runner === "node"); record.file = null; },
    (copy) => first(copy).files[0].extra = "unknown",
    (copy) => copy[0].records.push({ profile: "SOCKET", runner: "node", file: null, exitCode: 0, cancelled: 0, parseFailures: [], files: [] }),
    (copy) => { const record = first(copy); const moved = record.files.pop(); copy[0].records.push({ ...record, files: [moved] }); },
    (copy) => copy[1].inventory[0].runner = "vitest:vitest.postgres.config.ts",
  ].entries()) assert.equal(mutate(change).status, "failed", `mutation ${index}`);
});

test("aggregate binds exact source, complete plan, runtimes and provider run attempt", async () => {
  const { plan, receipts } = await mockPartitionReceipts();
  for (const key of ["sourceHead", "planDigest", "toolchainNode", "imageNode", "runId", "runAttempt"]) {
    const copy = structuredClone(receipts); copy[1][key] += "1";
    assert.equal(aggregateMock({ plan, receipts: copy }).status, "failed", key);
  }
  const unknown = structuredClone(receipts); unknown[0].providerBranch = "untrusted";
  assert.equal(aggregateMock({ plan, receipts: unknown }).status, "failed");
  for (const partition of PARTITIONS) for (const result of ["failure", "cancelled", "skipped", undefined, "pending"]) {
    assert.equal(aggregateMock({ plan, receipts, jobResults: { ...partitionJobsPassed, [partition]: result } }).status, "failed", partition);
  }
  assert.equal(aggregateMock({ plan, receipts, jobResults: { ...partitionJobsPassed, EXTRA: "success" } }).status, "failed");
  assert.equal(aggregateMock({ plan, receipts, context: { ...receiptContextFixture, toolchainNode: "v26.2.1" } }).status, "failed");
});

test("aggregate never qualifies failures, skipped, todo, cancelled, parse failures or empty files", async () => {
  const { plan, receipts } = await mockPartitionReceipts();
  const countMismatch = structuredClone(receipts);
  countMismatch.find(({ partition }) => partition === "EDGE_E2E").records[0].parseFailures = ["TAP_TEST_COUNT_MISMATCH"];
  assert.deepEqual(aggregateMock({ plan, receipts: countMismatch }).failures.map(({ code, file }) => [code, file]), [
    ["TAP_TEST_COUNT_MISMATCH", EDGE_SPEC],
  ], "the content-free receipt carries the exact-count parse failure into aggregate refusal");
  for (const field of ["failed", "skipped", "todo"]) {
    const copy = structuredClone(receipts); const file = copy[0].records[0].files[0]; file.passed = 0; file[field] = 1;
    assert.equal(aggregateMock({ plan, receipts: copy }).status, "failed", field);
  }
  for (const change of [
    (record) => { record.cancelled = 1; },
    (record) => { record.exitCode = 1; },
    (record) => { record.parseFailures = ["TAP_INCOMPLETE"]; },
    (record) => { record.parseFailures = ["unreviewed"]; },
    (record) => { record.files[0].passed = 0; },
    (record) => { record.files[0].fileFailed = true; },
    (record) => { record.files[0].passed = -1; },
    (record) => { record.files[0].passed = 1.5; },
    (record) => { record.files[0].passed = 100_001; },
    (record) => { record.files[0].environmentFailed = 2; },
  ]) {
    const copy = structuredClone(receipts); change(copy[0].records[0]);
    assert.equal(aggregateMock({ plan, receipts: copy }).status, "failed");
  }
  const gap = structuredClone(receipts); gap.at(-1).environmentGaps.push({ code: "ENVIRONMENT_GAP", file: EDGE_SPEC, profile: "EDGE_E2E" });
  assert.equal(aggregateMock({ plan, receipts: gap }).status, "failed");
  const failedPlan = structuredClone(receipts); failedPlan[0].planFailureCodes.push("UNREGISTERED_POSTGRES_SPEC");
  assert.equal(aggregateMock({ plan, receipts: failedPlan }).status, "failed");
});

test("actual runner skips and edge environment gaps remain failing aggregate evidence", async () => {
  for (const options of [{ skipFile: "postgres-test/typed-v12-normalized.spec.mjs" },
    { probe: async () => ({ available: false, reasons: ["synthetic missing image runtime"] }) }]) {
    const { plan, receipts } = await mockPartitionReceipts(options);
    assert.equal(aggregateMock({ plan, receipts }).status, "failed");
  }
});

test("progress and receipts exclude child payload, test names, diagnostic paths and failure text", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const progress = []; let execution;
  await runPostgresSuite({ workerRoot: WORKER_ROOT, plan, partition: "CORE_B",
    environment: { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432" }, onOutput: () => {},
    onProgress: (entry) => progress.push(entry), now: () => 100,
    onRecords: (value) => { execution = value; },
    run: async () => ({ exitCode: 1, stdout: passingTapFor("SECRET_SYNTHETIC_TEST_NAME")
      .replace("ok 1 -", "not ok 1 -").replace("# pass 1", "# pass 0").replace("# fail 0", "# fail 1") }),
  });
  const firstRecordedFile = execution.records[0].files.keys().next().value;
  execution.records[0].files.get(firstRecordedFile).tests[0].detail = "SECRET_SYNTHETIC_PAYLOAD /private/path.sql";
  const receipt = createPostgresReceipt({ plan, context: receiptContextFixture, partition: "CORE_B", execution, executionInputs: executionInputsFixture("CORE_B") });
  const serialized = JSON.stringify({ progress, receipt });
  assert.doesNotMatch(serialized, /SECRET_SYNTHETIC|private\/path|path\.sql/u);
  assert.equal(progress.length, execution.records.length * 2);
  for (let index = 0; index < execution.records.length; index += 1) {
    assert.equal(progress[index * 2].phase, "started");
    assert.equal(progress[index * 2 + 1].phase, "completed");
    assert.equal(progress[index * 2].runner, execution.records[index].runner);
    assert.equal(progress[index * 2 + 1].runner, execution.records[index].runner);
  }
  for (const entry of progress) assert.deepEqual(Object.keys(entry).sort(), ["elapsedMs", "event", "files", "phase", "profile", "runner"]);
});

test("canonical plan digest is deterministic and changes when an owned spec or runner input changes", async () => {
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-plan-digest-"));
  try {
    await mkdir(join(root, "scripts")); await mkdir(join(root, "postgres-test"));
    for (const path of ["package.json", "vitest.postgres.config.ts", "vitest.node.config.ts", "scripts/ci-postgres-suite.mjs",
      ...plan.files.map(({ file }) => file)]) {
      await cp(join(WORKER_ROOT, path), join(root, path));
    }
    const before = await postgresPlanDigest(plan, { workerRoot: root });
    assert.match(before, /^[a-f0-9]{64}$/u);
    assert.equal(await postgresPlanDigest(plan, { workerRoot: root }), before);
    await writeFile(join(root, plan.files[0].file), "// synthetic modified spec\n");
    assert.notEqual(await postgresPlanDigest(plan, { workerRoot: root }), before);
    const changed = await postgresPlanDigest(plan, { workerRoot: root });
    await writeFile(join(root, "scripts/ci-postgres-suite.mjs"), "// synthetic modified runner\n");
    assert.notEqual(await postgresPlanDigest(plan, { workerRoot: root }), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const generatedOutputNames = ["server", "oauth-gateway", "test-migrations", "test-activation",
  "postgres-community-graph-benchmark", "postgres-community-graph-readback-diagnostic", "analytics-refresh",
  "analytics-reprice", "analytics-refresh-worker", "production-migrations", "postgres-maintenance-job",
  "ops-runtime-probe-job", "ops-backup-audit-job"].map((name) => `dist/${name}.mjs`).sort();
const buildOwnershipFixture = Object.freeze({ buildSourceSha256: "c".repeat(64), paths: generatedOutputNames });
const executionInputsFixture = (partition) => ({ buildSourceSha256: buildOwnershipFixture.buildSourceSha256,
  builderNode: partition === "EDGE_E2E" ? "v22.16.0" : "v26.2.0",
  bundles: generatedOutputNames.map((path) => ({ path, sha256: "d".repeat(64), bytes: 12 })) });

async function withGeneratedInputFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-bundle-binding-"));
  try {
    await mkdir(join(root, "cloud-run", "dist"), { recursive: true });
    await writeFile(join(root, "cloud-run", "build.mjs"), `const outputs = { outputs: ${JSON.stringify(generatedOutputNames)} };\n`);
    for (const path of generatedOutputNames) await writeFile(join(root, "cloud-run", path), "// synthetic bundle\n");
    return await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("generated execution bindings derive all13 canonical outputs, bind bytes and refuse missing/extra/links", async () => {
  await withGeneratedInputFixture(async (root) => {
    const ownership = await postgresBuildOwnership({ workerRoot: root });
    assert.deepEqual(ownership.paths, generatedOutputNames);
    const first = await postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" });
    assert.equal(first.bundles.length, 13);
    assert.deepEqual(first, await postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" }));
    const changed = join(root, "cloud-run", generatedOutputNames[0]);
    await writeFile(changed, "// synthetic changed bundle\n");
    const next = await postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" });
    assert.notEqual(next.bundles[0].sha256, first.bundles[0].sha256);
    await writeFile(join(root, "cloud-run", "dist", "extra.mjs"), "extra");
    await assert.rejects(postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" }), /inventory differs/u);
    await rm(join(root, "cloud-run", "dist", "extra.mjs"));
    await rm(changed); await symlink(join(root, "cloud-run", generatedOutputNames[1]), changed);
    await assert.rejects(postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" }), /unsafe or empty/u);
  });
  await withGeneratedInputFixture(async (root) => {
    await rm(join(root, "cloud-run", generatedOutputNames[0]));
    await assert.rejects(postgresExecutionInputs({ workerRoot: root, builderNode: "v26.2.0" }), /inventory differs/u);
  });
});

test("complete aggregate binds perpartition generated bytes and exact canonical ownership without inventing cross-runtime equality", async () => {
  const { plan, receipts } = await mockPartitionReceipts();
  assert.deepEqual(receipts[0].executionInputs, receipts[1].executionInputs,
    "CORE_A and CORE_B on the same Node toolchain must bind identical build outputs");
  const different = structuredClone(receipts);
  different[2].executionInputs.bundles[0].sha256 = "e".repeat(64);
  assert.equal(aggregateMock({ plan, receipts: different }).status, "passed", "actual runtime-specific outputs are recorded independently");
  for (const mutate of [
    (inputs) => { inputs.bundles[0].sha256 = "e".repeat(64); },
    (inputs) => { inputs.bundles[0].bytes += 1; },
  ]) {
    const changedCore = structuredClone(receipts);
    mutate(changedCore[1].executionInputs);
    assert.equal(aggregateMock({ plan, receipts: changedCore }).status, "failed",
      "same-runtime CORE receipts cannot disagree on bundle bytes or digest");
  }
  for (const mutate of [
    (inputs) => { inputs.bundles.pop(); },
    (inputs) => { inputs.bundles.push(structuredClone(inputs.bundles[0])); },
    (inputs) => { inputs.bundles[0].sha256 = "wrong"; },
    (inputs) => { inputs.bundles[0].bytes = 0; },
    (inputs) => { inputs.bundles[0].path = "dist/unowned.mjs"; },
    (inputs) => { inputs.builderNode = "v22.16.0"; },
    (inputs) => { inputs.buildSourceSha256 = "e".repeat(64); },
    (inputs) => { inputs.unreviewed = true; },
  ]) {
    const copy = structuredClone(receipts); mutate(copy[0].executionInputs);
    assert.equal(aggregateMock({ plan, receipts: copy }).status, "failed");
  }
});

test("source guards refuse an imported non-spec root module or staged index mutation under unchanged HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-clean-source-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    await mkdir(join(root, "apps", "worker"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "imported.mjs"), "export const synthetic = 1;\n");
    for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic"]]) {
      const result = git(args); assert.equal(result.status, 0, result.stderr);
    }
    const head = git(["rev-parse", "HEAD"]).stdout;
    assert.doesNotThrow(() => assertCleanPostgresCheckout({ workerRoot: join(root, "apps", "worker") }));
    await writeFile(join(root, "src", "imported.mjs"), "export const synthetic = 2;\n");
    assert.equal(git(["rev-parse", "HEAD"]).stdout, head);
    assert.throws(() => assertCleanPostgresCheckout({ workerRoot: join(root, "apps", "worker") }), /tracked source or index differs/u);
    assert.equal(git(["add", "src/imported.mjs"]).status, 0);
    assert.throws(() => assertCleanPostgresCheckout({ workerRoot: join(root, "apps", "worker") }), /tracked source or index differs/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function injectableCli(plan, { skipFile = null, context = receiptContextFixture, inputsChanged = false } = {}) {
  const summaries = []; const exits = []; let bindings = 0;
    const environment = { PG_TEST_SOCKET: SOCKET, PG_TEST_PORT: "5432",
      ...Object.fromEntries(PARTITIONS.map((partition) => [`CI_POSTGRES_${partition}_RESULT`, "success"])) };
  return { summaries, exits, environment, dependencies: {
    loadPlan: async () => plan, readContext: async () => context, environment,
    execute: async (options) => runPostgresSuite({ ...options, workerRoot: WORKER_ROOT,
      run: fakeSuiteRunner({ plan, skipFile }).run, onOutput: () => {}, onProgress: () => {}, probeEdgeE2e: edgeAvailable }),
    loadOwnership: async () => buildOwnershipFixture,
    bindInputs: async ({ builderNode }) => {
      const inputs = executionInputsFixture(builderNode === "v26.2.0" ? "CORE_A" : "EDGE_E2E");
      if (inputsChanged && bindings++ > 0) inputs.bundles[0].sha256 = "e".repeat(64);
      return inputs;
    },
    writeSummary: (summary) => summaries.push(summary), setExitCode: (code) => exits.push(code),
  } };
}

test("actual CLI orchestration writes exclusive0600 CORE_A/CORE_B/EDGE receipts and one aggregate summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-cli-check-"));
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  try {
    const paths = [];
    for (const partition of PARTITIONS) {
      const path = join(root, `${partition}.json`); paths.push(path);
      const cli = await injectableCli(plan);
      await main(["--partition", partition, "--receipt", path], cli.dependencies);
      assert.equal(cli.summaries.length, 1); assert.equal(cli.summaries[0].scope, "partition");
      assert.equal(cli.summaries[0].partition, partition); assert.deepEqual(cli.exits, []);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const receipt = JSON.parse(await readFile(path, "utf8"));
      assert.equal(receipt.partition, partition); assert.equal(receipt.sourceHead, receiptContextFixture.sourceHead);
      await assert.rejects(main(["--partition", partition, "--receipt", path], cli.dependencies), { code: "EEXIST" });
    }
    const cli = await injectableCli(plan);
    await main(["--aggregate", ...paths], cli.dependencies);
    assert.equal(cli.summaries.length, 1); assert.equal(cli.summaries[0].scope, "complete");
    assert.equal(cli.summaries[0].status, "passed"); assert.deepEqual(cli.exits, []);
    const whole = await injectableCli(plan); await main([], whole.dependencies);
    assert.equal(whole.summaries.length, 1); assert.equal(whole.summaries[0].scope, undefined);
    assert.equal(whole.summaries[0].files, plan.files.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual CLI orchestration refuses missing/unsafe receipts, provider failure and changed execution inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-cli-refusal-"));
  const plan = await planPostgresSuite({ workerRoot: WORKER_ROOT });
  try {
    const paths = PARTITIONS.map((partition) => join(root, `${partition}.json`));
    const { receipts } = await mockPartitionReceipts();
    for (let index = 0; index < paths.length; index += 1) await writeFile(paths[index], JSON.stringify(receipts[index]));
    const failedJob = await injectableCli(plan); failedJob.environment.CI_POSTGRES_EDGE_E2E_RESULT = "cancelled";
    await main(["--aggregate", ...paths], failedJob.dependencies);
    assert.equal(failedJob.summaries[0].status, "failed"); assert.deepEqual(failedJob.exits, [1]);
    const skipped = await injectableCli(plan, { skipFile: "postgres-test/typed-v12-normalized.spec.mjs" });
    await main(["--partition", "CORE_B", "--receipt", join(root, "skipped.json")], skipped.dependencies);
    assert.equal(skipped.summaries[0].status, "failed"); assert.deepEqual(skipped.exits, [1]);
    const changed = await injectableCli(plan, { inputsChanged: true });
    await assert.rejects(main(["--partition", "CORE_A", "--receipt", join(root, "changed.json")], changed.dependencies), /generated execution inputs are absent or changed/u);
    const drift = await injectableCli(plan); let reads = 0;
    drift.dependencies.readContext = async () => reads++ === 0 ? receiptContextFixture : { ...receiptContextFixture, sourceHead: "e".repeat(40) };
    await assert.rejects(main(["--partition", "CORE_A", "--receipt", join(root, "drift.json")], drift.dependencies), /source or runtime changed/u);
    const missing = await injectableCli(plan);
    await assert.rejects(main(["--aggregate", join(root, "missing.json"), paths[1], paths[2]], missing.dependencies), { code: "ENOENT" });
    const link = join(root, "link.json"); await symlink(paths[0], link);
    await assert.rejects(main(["--aggregate", link, paths[1], paths[2]], missing.dependencies), /bounded regular file/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("producer context compares immutable expected HEAD, actual clean checkout, provider strings and both pinned runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-pg-context-"));
  const workerRoot = join(root, "apps", "worker");
  try {
    await mkdir(join(workerRoot, "scripts"), { recursive: true });
    await mkdir(join(workerRoot, "postgres-test"));
    for (const file of ["package.json", "vitest.postgres.config.ts", "vitest.node.config.ts", "scripts/ci-postgres-suite.mjs", "postgres-test/synthetic.spec.mjs"]) {
      await writeFile(join(workerRoot, file), "// synthetic source\n");
    }
    for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic"]]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    }
    const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const plan = { files: [{ file: "postgres-test/synthetic.spec.mjs", profile: "SOCKET", runner: "node", source: "synthetic" }], hostProfileFiles: [], failures: [] };
    const environment = { ...process.env, CI_POSTGRES_EXPECTED_HEAD: sourceHead, GITHUB_SHA: "f".repeat(40), GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2", EDGE_E2E_NODE: "/synthetic/node22" };
    const probe = async () => ({ exitCode: 0, stdout: "v22.16.0\n" });
    const context = await receiptContext({ workerRoot, plan, environment, probeImage: true, probe });
    assert.equal(context.sourceHead, sourceHead); assert.notEqual(context.sourceHead, environment.GITHUB_SHA, "a PR provider merge SHA does not replace its explicitly selected head");
    assert.equal(context.toolchainNode, "v26.2.0"); assert.equal(context.imageNode, "v22.16.0");
    for (const changed of [{ CI_POSTGRES_EXPECTED_HEAD: "a".repeat(40) }, { CI_POSTGRES_EXPECTED_HEAD: undefined },
      { GITHUB_RUN_ID: "1234x" }, { GITHUB_RUN_ATTEMPT: "0" }, { EDGE_E2E_NODE: "relative" }]) {
      await assert.rejects(receiptContext({ workerRoot, plan, environment: { ...environment, ...changed }, probeImage: true, probe }), /CI_SUITE_RECEIPT_CONTEXT_INVALID/u);
    }
    await assert.rejects(receiptContext({ workerRoot, plan, environment, probeImage: true,
      probe: async () => ({ exitCode: 0, stdout: "v22.17.0\n" }) }), /image runtime version differs/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
