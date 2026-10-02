import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  checkRegistrationRatchet,
  classifyFailureDetail,
  deriveFileProfile,
  EDGE_E2E_GOLDEN_VARIABLE,
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
  readSocketProfileInput,
  runPostgresSuite,
  SCRIPT_PROFILES,
  UNREGISTERED_ALLOWLIST,
} from "./ci-postgres-suite.mjs";
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
    "postgres-test/postgres-community-daily-publisher.spec.mjs",
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

function fakeSuiteRunner({ plan, skipFile = null, prerequisiteExit = 0 }) {
  const calls = [];
  const run = async (command, args, { cwd, env, captureStdout }) => {
    calls.push({ command, args, cwd, env: { ...env }, captureStdout });
    if (command === EDGE_NODE) {
      if (args[0] === "./cloud-run/build.mjs") return { exitCode: prerequisiteExit, stdout: "" };
      assert.equal(args[0], "--test");
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
    ["--test", "--test-concurrency=1", "--test-reporter=tap", `./${EDGE_SPEC}`],
  ], "EDGE_E2E runs last, through edge:e2e's own steps, under the image runtime");
  assert.ok(calls.indexOf(edgeCalls[0]) > calls.findLastIndex(({ env }) => env.PG_TEST_HOST !== undefined));
  for (const call of edgeCalls) {
    assert.equal(call.env.PG_TEST_SOCKET, SOCKET);
    assert.equal(call.env.PG_TEST_HOST, undefined);
  }
  assert.equal(summary.passedByPass.EDGE_E2E, 1);
  assert.deepEqual(summary.environmentGaps, []);
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
        spawnSync("chmod", ["3775", join(paths.workDirectory, "socket")]);
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
