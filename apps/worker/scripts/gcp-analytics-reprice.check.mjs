/**
 * Offline check of the OPS-REPRICE operator verb (gcp-analytics-reprice.mjs).
 * Every gcloud call goes to an in-memory stub; PATH is blanked so an
 * accidental spawn fails closed. Targets, receipts and registries are
 * synthetic and content-free.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ANALYTICS_REPRICE_REFUSALS, ANALYTICS_REPRICE_USAGE } from "../cloud-run/analytics-reprice.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as verb from "./gcp-analytics-reprice.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"f".repeat(64)}`;
const PLAN_HASH = "a".repeat(64);
const REGISTRY_SHA = "b".repeat(64);
const RUN = "12345678-1234-4234-8234-123456789abc";
const KERNEL = 17;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const REGISTRY = Object.freeze({ kernels: [{ kernelId: 16, priceRegistrySha256: "9".repeat(64) },
  { kernelId: KERNEL, priceRegistrySha256: REGISTRY_SHA }] });
const TARGET = Object.freeze({
  environment: "production",
  project: "example-ops-prod1",
  region: "us-east1",
  job: "synthetic-analytics-reprice",
  refreshJob: "synthetic-analytics-refresh",
  migrationJob: "synthetic-production-migrate",
  imageRepository: "us-east1-docker.pkg.dev/example-ops-prod1/synthetic-images/synthetic-host",
  entry: "dist/analytics-reprice.mjs",
});
const BOUNDS = ["--from-day=2026-09-01", "--through-day=2026-09-30", "--max-days=32", "--max-members=1000",
  "--max-input-bytes=16777216"];
const BOUNDS_OBJECT = Object.freeze({ fromDay: "2026-09-01", throughDay: "2026-09-30", maxDays: 32, maxMembers: 1000,
  maxInputBytes: 16_777_216 });
const refusals = () => Object.fromEntries(ANALYTICS_REPRICE_REFUSALS.map((key) => [key, 0]));

function planResult(overrides = {}) {
  return { schema: "analytics-v2-reprice-plan-v1", status: "planned", planSha256: PLAN_HASH,
    counts: { heads: 3, members: 12, inputBytes: 4096 }, caps: { heads: false, members: false, inputBytes: false },
    target: { kernelId: KERNEL, manifestVersion: 1, registrySha256: REGISTRY_SHA, pricingMethodVersion: "v0.9" },
    ...overrides };
}
function executionResult(overrides = {}) {
  return { schema: "analytics-v2-reprice-execution-v1", status: "complete", planSha256: PLAN_HASH,
    counts: { planned: 3, changed: 1, equivalent: 1, unchanged: 0, refused: 1, contributionVersions: 2 },
    refusals: { ...refusals(), price_input_association_unproven: 1 }, replayed: false, ...overrides };
}
function okReceipt(mode, result, overrides = {}) {
  return { schemaVersion: "analytics-reprice-receipt-v1", status: "ok", mode, target: "production",
    now: "2026-10-12T11:59:00.000Z", clock: "wall", kernel: { kernelId: KERNEL, manifestVersion: 1 }, result, ...overrides };
}
function planArgs(extra = []) {
  return ["--environment=production", "--mode=plan", `--commit=${COMMIT}`, `--expected-kernel=${KERNEL}`, ...BOUNDS, ...extra];
}
function executeArgs(planPath, extra = []) {
  return ["--environment=production", "--mode=execute", `--commit=${COMMIT}`, `--expected-kernel=${KERNEL}`, ...BOUNDS,
    `--plan-receipt=${planPath}`, `--expected-plan-sha256=${PLAN_HASH}`, `--run-id=${RUN}`, ...extra];
}

function jobResource({ image = `${TARGET.imageRepository}@${DIGEST}`, commit = COMMIT, args = [TARGET.entry] } = {}) {
  return { metadata: { name: TARGET.job }, spec: { template: { spec: { template: { spec: {
    containers: [{ image, args, env: [{ name: "ANALYTICS_REFRESH_TARGET", value: "production" },
      { name: "DEPLOYMENT_SOURCE_COMMIT", value: commit }] }] } } } } } };
}
const terminal = (succeeded) => ({ status: { completionTime: "2026-10-12T11:59:30Z", runningCount: 0,
  succeededCount: succeeded ? 1 : 0, failedCount: succeeded ? 0 : 1,
  conditions: [{ type: "Completed", status: succeeded ? "True" : "False" }] } });

/** An in-memory gcloud: the reprice Job, its neighbours' executions, one execution and its log. */
function stubGcloud({ job = jobResource(), running = {}, outcome = "succeeded", polls = 1, payloads = [], emptyReads = 0,
  executionName = `${TARGET.job}-x7k2p`, failOn = null } = {}) {
  const calls = [];
  let describes = 0;
  let reads = 0;
  const runner = (argv) => {
    calls.push(argv);
    const head = argv.slice(0, 5).join(" ");
    if (failOn !== null && failOn(argv)) return { status: 1, stdout: "" };
    if (head === `gcloud run jobs describe ${TARGET.job}`) return { status: 0, stdout: JSON.stringify(job) };
    if (head === "gcloud run jobs executions list") {
      const name = argv.find((part) => part.startsWith("--job=")).slice("--job=".length);
      const open = running[name] ? [{ metadata: { name: `${name}-open` }, status: { runningCount: 1 } }] : [];
      return { status: 0, stdout: JSON.stringify([...open, { metadata: { name: `${name}-done` }, ...terminal(true) }]) };
    }
    if (head === `gcloud run jobs execute ${TARGET.job}`) {
      return { status: 0, stdout: JSON.stringify({ metadata: { name: executionName } }) };
    }
    if (head === "gcloud run jobs executions describe") {
      describes += 1;
      const body = describes <= polls ? { status: { runningCount: 1 } } : terminal(outcome === "succeeded");
      return { status: 0, stdout: JSON.stringify({ metadata: { name: argv[5] }, ...body }) };
    }
    if (head.startsWith("gcloud logging read")) {
      reads += 1;
      if (reads <= emptyReads) return { status: 0, stdout: "[]" };
      return { status: 0, stdout: JSON.stringify(payloads.map((payload) => ({
        resource: { type: "cloud_run_job", labels: { job_name: TARGET.job } },
        labels: { "run.googleapis.com/execution_name": executionName }, jsonPayload: payload }))) };
    }
    return { status: 1, stdout: "" };
  };
  return { calls, runner, describes: () => describes };
}

function lockStub(events) {
  return ({ environment, ref }) => ({
    ref,
    async createOwner(record) { events.push(["owner", environment, record]); return record; },
    async acquire() { events.push(["acquire"]); },
    assertOwned() { events.push(["owned"]); },
    async release() { events.push(["release"]); },
  });
}

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-reprice-verb-"));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function deps(gcloud, overrides = {}) {
  const lockLog = [];
  return {
    run: gcloud.runner,
    loadTarget: async () => TARGET,
    readKernelRegistry: async () => REGISTRY,
    lockFactory: lockStub(lockLog),
    lockLog,
    lockEvents: [],
    now: () => NOW,
    uuid: () => "99999999-9999-4999-8999-999999999999",
    sleep: async () => {},
    ...overrides,
  };
}

async function writePlanReceipt(directory, mutate = (body) => body, { seal = true } = {}) {
  const body = mutate({
    schema: verb.REPRICE_RECEIPT_SCHEMA, mode: "plan", outcome: "ok", environment: "production",
    project: TARGET.project, region: TARGET.region, job: TARGET.job, execution: `${TARGET.job}-p1an0`,
    commit: COMMIT, imageDigest: DIGEST, kernel: { kernelId: KERNEL, manifestVersion: 1 }, bounds: { ...BOUNDS_OBJECT },
    planSha256: PLAN_HASH, runId: null, result: planResult(), failure: null, completedAt: "2026-10-12T10:00:00.000Z",
  });
  const receipt = seal ? verb.sealRepriceReceipt(body) : body;
  const path = join(directory, `plan-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
  return path;
}

const rejectsCode = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

test("arguments are closed per mode, bounded by the CLI's own caps, and authorization binds mode, plane and plan", () => {
  const out = "--receipt-out=/private/synthetic/out.json";
  const parsed = verb.parseRepriceArguments(planArgs([out]));
  assert.deepEqual({ ...parsed.bounds }, BOUNDS_OBJECT);
  assert.equal(parsed.execute, false);
  assert.equal(parsed.expectedKernel, KERNEL);
  for (const [argv, code] of [
    [[], "REPRICE_MODE_INVALID"],
    [planArgs().filter((arg) => arg !== "--mode=plan"), "REPRICE_MODE_INVALID"],
    [[...planArgs(), "--mode=plan"], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, "--schema=primary"], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, "--now=2026-01-01T00:00:00Z"], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, `--run-id=${RUN}`], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, `--expected-plan-sha256=${PLAN_HASH}`], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, "--execute", "--execute"], "REPRICE_ARGUMENT_INVALID"],
    [[...planArgs(), out, "-x"], "REPRICE_ARGUMENT_INVALID"],
    [planArgs(), "REPRICE_ARGUMENT_MISSING"],
    [[...planArgs().map((arg) => arg.replace("--environment=production", "--environment=test")), out],
      "REPRICE_ENVIRONMENT_INVALID"],
    [[...planArgs().map((arg) => arg.replace(`--commit=${COMMIT}`, "--commit=HEAD")), out], "REPRICE_COMMIT_INVALID"],
    [[...planArgs().map((arg) => arg.replace(`--expected-kernel=${KERNEL}`, "--expected-kernel=017")), out],
      "REPRICE_KERNEL_INVALID"],
    [[...planArgs().map((arg) => arg.replace("--max-days=32", "--max-days=33")), out], "REPRICE_BOUNDS_INVALID"],
    [[...planArgs().map((arg) => arg.replace("--max-members=1000", "--max-members=1001")), out], "REPRICE_BOUNDS_INVALID"],
    [[...planArgs().map((arg) => arg.replace("--max-input-bytes=16777216", "--max-input-bytes=16777217")), out],
      "REPRICE_BOUNDS_INVALID"],
    [[...planArgs().map((arg) => arg.replace("--through-day=2026-09-30", "--through-day=2026-08-31")), out],
      "REPRICE_BOUNDS_INVALID"],
    [[...planArgs().map((arg) => arg.replace("--from-day=2026-09-01", "--from-day=2026-02-30")), out],
      "REPRICE_BOUNDS_INVALID"],
    [[...planArgs(), "--receipt-out=relative.json"], "REPRICE_PATH_INVALID"],
    [[...planArgs(), out, "--execute"], "REPRICE_AUTHORIZATION_REQUIRED"],
    [[...planArgs(), out, `--authorize=reprice-plan:staging:${COMMIT}`], "REPRICE_AUTHORIZATION_MISMATCH"],
    [[...planArgs(), out, `--authorize=reprice-execute:production:${COMMIT}`], "REPRICE_AUTHORIZATION_MISMATCH"],
    [[...planArgs(), out, `--authorize=reprice-plan:production:${OTHER_COMMIT}`], "REPRICE_AUTHORIZATION_MISMATCH"],
    [executeArgs("/private/synthetic/plan.json").filter((arg) => !arg.startsWith("--run-id=")).concat(out),
      "REPRICE_ARGUMENT_MISSING"],
    [executeArgs("/private/synthetic/plan.json").filter((arg) => !arg.startsWith("--expected-plan-sha256="))
      .concat(out), "REPRICE_ARGUMENT_MISSING"],
    [executeArgs("/private/synthetic/plan.json").filter((arg) => !arg.startsWith("--plan-receipt=")).concat(out),
      "REPRICE_ARGUMENT_MISSING"],
    [executeArgs("/private/synthetic/plan.json", [out]).map((arg) => arg.startsWith("--run-id=") ? "--run-id=sentinel" : arg),
      "REPRICE_RUN_ID_INVALID"],
    [executeArgs("/private/synthetic/plan.json", [out]).map((arg) => arg.startsWith("--expected-plan-sha256=")
      ? `--expected-plan-sha256=${PLAN_HASH.toUpperCase()}` : arg), "REPRICE_PLAN_DIGEST_INVALID"],
    [executeArgs("/private/synthetic/plan.json", [out, `--authorize=reprice-execute:production:${"0".repeat(64)}`]),
      "REPRICE_AUTHORIZATION_MISMATCH"],
    [executeArgs("relative-plan.json", [out]), "REPRICE_PATH_INVALID"],
  ]) {
    assert.throws(() => verb.parseRepriceArguments(argv), rejectsCode(code), `${code}: ${argv.join(" ")}`);
  }
  assert.equal(verb.parseRepriceArguments([...planArgs(), out, `--authorize=reprice-plan:production:${COMMIT}`,
    "--execute"]).execute, true);
  assert.equal(verb.parseRepriceArguments(executeArgs("/private/synthetic/plan.json",
    [out, `--authorize=reprice-execute:production:${PLAN_HASH}`, "--execute"])).execute, true);
});

test("the Job receives the entry and the CLI's own explicit arguments, which its parser accepts under a production target", () => {
  const plan = verb.repriceJobArguments({ mode: "plan", bounds: BOUNDS_OBJECT });
  assert.deepEqual([...plan], ["dist/analytics-reprice.mjs", "--mode=plan", ...BOUNDS]);
  const execute = verb.repriceJobArguments({ mode: "execute", bounds: BOUNDS_OBJECT, runId: RUN,
    expectedPlanSha256: PLAN_HASH });
  assert.deepEqual([...execute], ["dist/analytics-reprice.mjs", "--mode=execute", ...BOUNDS, `--run-id=${RUN}`,
    `--expected-plan-sha256=${PLAN_HASH}`]);
  assert.equal(execute.some((arg) => arg.startsWith("--schema=") || arg.startsWith("--now=")), false);
  // The CLI refuses execute without its authorization, so the verb refuses to build it.
  assert.throws(() => verb.repriceJobArguments({ mode: "execute", bounds: BOUNDS_OBJECT }),
    rejectsCode("REPRICE_JOB_ARGUMENTS_INVALID"));
  assert.throws(() => verb.repriceJobArguments({ mode: "plan", bounds: { ...BOUNDS_OBJECT, maxDays: 0 } }),
    rejectsCode("REPRICE_JOB_ARGUMENTS_INVALID"));
  // The gcloud argv carries them as one comma-separated --args list, then --async.
  assert.deepEqual(verb.REPRICE_ARGV.jobExecute(TARGET, plan), ["gcloud", "run", "jobs", "execute", TARGET.job,
    `--args=${plan.join(",")}`, "--async", "--project=example-ops-prod1", "--region=us-east1", "--format=json"]);
  assert.match(ANALYTICS_REPRICE_USAGE, /--max-input-bytes/u);
});

test("a dry run is offline: it validates against the committed desired state and the registry and prints the argv", async () => {
  await withDirectory(async (directory) => {
    const out = join(directory, "plan-receipt.json");
    const calls = [];
    // The real loaders: the committed production desired state and this checkout's kernel registry.
    const registry = JSON.parse(await readFile(new URL("../src/analytics-v2/kernel-registry.json", import.meta.url), "utf8"));
    const latest = registry.kernels.at(-1).kernelId;
    const result = await verb.runAnalyticsRepriceVerb(
      [...planArgs().map((arg) => arg.replace(`--expected-kernel=${KERNEL}`, `--expected-kernel=${latest}`)),
        `--receipt-out=${out}`],
      { run: (argv) => { calls.push(argv); throw new Error("no call expected"); } });
    assert.equal(calls.length, 0);
    assert.equal(result.status, "dry-run");
    assert.equal(result.job, "tibotattle-analytics-reprice");
    assert.equal(result.lockRef, "refs/heads/codex/production-deployment-lock");
    assert.deepEqual(result.kernel, { kernelId: latest });
    const argv = result.steps.map((step) => step.argv);
    assert.deepEqual(argv[0], ["gcloud", "run", "jobs", "describe", "tibotattle-analytics-reprice",
      "--project=tibotattle-prod", "--region=us-east1", "--format=json"]);
    assert.deepEqual(argv.slice(1, 4).map((step) => step[5]), ["--job=tibotattle-analytics-reprice",
      "--job=tibotattle-analytics-refresh", "--job=tibotattle-migrate"]);
    assert.equal(argv[4][3], "execute");
    assert.equal(argv[4][5], `--args=dist/analytics-reprice.mjs,--mode=plan,${BOUNDS.join(",")}`);
    assert.match(argv[6][3], /jsonPayload\.schemaVersion="analytics-reprice-receipt-v1"/u);
    assert.equal((await stat(out).catch(() => null)), null, "a dry run writes no receipt");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(directory.replaceAll("/", "\\/"), "u"));
    // An unregistered kernel and an existing receipt path refuse before anything else.
    await assert.rejects(verb.runAnalyticsRepriceVerb([...planArgs().map((arg) =>
      arg.replace(`--expected-kernel=${KERNEL}`, `--expected-kernel=${latest + 1}`)), `--receipt-out=${out}`]),
    rejectsCode("REPRICE_KERNEL_UNREGISTERED"));
    await writeFile(out, "{}");
    await assert.rejects(verb.runAnalyticsRepriceVerb([...planArgs().map((arg) =>
      arg.replace(`--expected-kernel=${KERNEL}`, `--expected-kernel=${latest}`)), `--receipt-out=${out}`]),
    rejectsCode("REPRICE_RECEIPT_EXISTS"));
  });
  // Staging reads its own committed plane.
  const staging = await verb.loadRepriceTargetFromInfraManifest("staging");
  assert.deepEqual(verb.validateRepriceTarget(staging, "staging").job, "tibotattle-staging-analytics-reprice");
});

test("the target is the manifest's closed reprice target, on its own plane and repository", async () => {
  assert.deepEqual([...verb.REPRICE_TARGET_KEYS], [...manifest.ANALYTICS_REPRICE_TARGET_KEYS]);
  assert.equal(verb.REPRICE_ENTRY, manifest.ANALYTICS_REPRICE_JOB_CONTRACT.entry);
  assert.deepEqual(verb.validateRepriceTarget(TARGET, "production"), TARGET);
  for (const [mutate, code] of [
    [(value) => { value.extra = "x"; }, "REPRICE_TARGET_INVALID"],
    [(value) => { value.environment = "staging"; }, "REPRICE_TARGET_INVALID"],
    [(value) => { value.refreshJob = value.job; }, "REPRICE_TARGET_INVALID"],
    [(value) => { value.entry = "dist/analytics-refresh.mjs"; }, "REPRICE_TARGET_INVALID"],
    [(value) => { value.imageRepository = value.imageRepository.replace("example-ops-prod1", "example-other1"); },
      "REPRICE_TARGET_INVALID"],
    [(value) => { value.job = "synthetic-staging-reprice"; }, "REPRICE_TARGET_PLANE_MISMATCH"],
  ]) {
    const value = structuredClone(TARGET);
    mutate(value);
    assert.throws(() => verb.validateRepriceTarget(value, "production"), rejectsCode(code), code);
  }
  assert.throws(() => verb.validateRepriceTarget({ ...TARGET, environment: "staging" }, "staging"),
    rejectsCode("REPRICE_TARGET_PLANE_MISMATCH"));
  await assert.rejects(verb.runAnalyticsRepriceVerb([...planArgs(), "--receipt-out=/private/synthetic/x.json"],
    { ...deps(stubGcloud()), loadTarget: async () => { throw new Error("synthetic"); } }),
  rejectsCode("REPRICE_INFRA_MANIFEST_UNAVAILABLE"));
  assert.throws(() => verb.registeredKernel({ kernels: [] }, KERNEL), rejectsCode("REPRICE_KERNEL_UNREGISTERED"));
  assert.throws(() => verb.registeredKernel({ kernels: [{ kernelId: KERNEL, priceRegistrySha256: "x" }] }, KERNEL),
    rejectsCode("REPRICE_KERNEL_REGISTRY_INVALID"));
  assert.throws(() => verb.registeredKernel(null, KERNEL), rejectsCode("REPRICE_KERNEL_REGISTRY_INVALID"));
});

test("plan executes once under the lock, polls to completion, validates the receipt and writes it owner-only", async () => {
  await withDirectory(async (directory) => {
    const out = join(directory, "plan.json");
    const gcloud = stubGcloud({ polls: 2, emptyReads: 2, payloads: [okReceipt("plan", planResult())] });
    const dependencies = deps(gcloud);
    const authorize = `--authorize=reprice-plan:production:${COMMIT}`;
    const result = await verb.runAnalyticsRepriceVerb([...planArgs(), `--receipt-out=${out}`, authorize, "--execute"],
      dependencies);
    assert.deepEqual(gcloud.calls.map((argv) => (argv[1] === "logging" ? "logging read" : argv.slice(1, 5).join(" "))), [
      "run jobs describe synthetic-analytics-reprice",
      "run jobs executions list", "run jobs executions list", "run jobs executions list",
      "run jobs execute synthetic-analytics-reprice",
      "run jobs executions describe", "run jobs executions describe", "run jobs executions describe",
      "logging read", "logging read", "logging read",
    ]);
    assert.deepEqual(gcloud.calls.at(-1), verb.REPRICE_ARGV.receiptLog(TARGET, `${TARGET.job}-x7k2p`));
    assert.equal(gcloud.calls[4][5], `--args=dist/analytics-reprice.mjs,--mode=plan,${BOUNDS.join(",")}`);
    assert.deepEqual(dependencies.lockLog.map((event) => event[0]), ["owner", "acquire", "owned", "release"]);
    assert.deepEqual(dependencies.lockEvents, ["acquired", "released"]);
    assert.deepEqual(dependencies.lockLog[0][2], { id: "99999999-9999-4999-8999-999999999999",
      sourceCommit: COMMIT, previousSourceCommit: COMMIT });
    assert.deepEqual(result, {
      status: "ok", mode: "plan", environment: "production", job: TARGET.job,
      execution: `${TARGET.job}-x7k2p`, commit: COMMIT, imageDigest: DIGEST,
      kernel: { kernelId: KERNEL, manifestVersion: 1 }, planSha256: PLAN_HASH, runId: null,
      counts: { heads: 3, members: 12, inputBytes: 4096 }, caps: { heads: false, members: false, inputBytes: false },
      executable: true, receiptDigestSha256: result.receiptDigestSha256,
    });
    const written = JSON.parse(await readFile(out, "utf8"));
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(written), [...verb.REPRICE_RECEIPT_KEYS]);
    assert.equal(written.digestSha256, result.receiptDigestSha256);
    assert.deepEqual(verb.verifyRepriceReceipt(written, { registry: REGISTRY }), written);
    // Content-free: counts, digests and closed names only.
    assert.doesNotMatch(JSON.stringify([result, written]), /owner|participant|password|SELECT|\/private\/|sentinel/iu);
    // A capped plan is recorded but marked not executable.
    const capped = stubGcloud({ payloads: [okReceipt("plan", planResult({ counts: { heads: 32, members: 12,
      inputBytes: 4096 }, caps: { heads: true, members: false, inputBytes: false } }))] });
    const cappedResult = await verb.runAnalyticsRepriceVerb([...planArgs(), `--receipt-out=${join(directory, "c.json")}`,
      authorize, "--execute"], deps(capped));
    assert.equal(cappedResult.executable, false);
  });
});

test("plan refuses an unrecognized Job, a running neighbour and an untrusted receipt, never executing twice", async () => {
  await withDirectory(async (directory) => {
    let index = 0;
    const run = async (gcloud, code, mutateArgs = (argv) => argv) => {
      index += 1;
      const out = join(directory, `refused-${index}.json`);
      await assert.rejects(verb.runAnalyticsRepriceVerb(mutateArgs([...planArgs(), `--receipt-out=${out}`,
        `--authorize=reprice-plan:production:${COMMIT}`, "--execute"]), deps(gcloud)), rejectsCode(code), code);
      assert.ok(gcloud.calls.filter((argv) => argv[3] === "execute").length <= 1, code);
      return { gcloud, out };
    };
    // The live Job must be the reviewed render at --commit, from the plane's repository.
    for (const [job, code] of [
      [jobResource({ commit: OTHER_COMMIT }), "REPRICE_JOB_COMMIT_MISMATCH"],
      [jobResource({ image: `us-east1-docker.pkg.dev/example-other1/x/y@${DIGEST}` }), "REPRICE_JOB_IMAGE_UNRECOGNIZED"],
      [jobResource({ image: `${TARGET.imageRepository}:latest` }), "REPRICE_JOB_IMAGE_UNRECOGNIZED"],
      [jobResource({ args: [TARGET.entry, "--mode=execute"] }), "REPRICE_JOB_UNRECOGNIZED"],
    ]) {
      const { gcloud } = await run(stubGcloud({ job }), code);
      assert.equal(gcloud.calls.some((argv) => argv[3] === "execute"), false, code);
    }
    // A running refresh (shared advisory lock), reprice or migration refuses before the execution.
    for (const name of [TARGET.refreshJob, TARGET.job, TARGET.migrationJob]) {
      const { gcloud } = await run(stubGcloud({ running: { [name]: true } }), "REPRICE_OVERLAP_REFUSED");
      assert.equal(gcloud.calls.some((argv) => argv[3] === "execute"), false, name);
    }
    // A gcloud failure on execute is a closed code.
    await run(stubGcloud({ failOn: (argv) => argv[3] === "execute" }), "REPRICE_EXECUTION_FAILED");
    await run(stubGcloud({ executionName: "another-job-x7k2p" }), "REPRICE_EXECUTION_UNRECOGNIZED");
    // Receipt refusals: unexpected kernel, untrusted registry or method, raw fields, wrong plane or clock.
    for (const [payload, code] of [
      [okReceipt("plan", planResult(), { kernel: { kernelId: 16, manifestVersion: 1 } }), "REPRICE_KERNEL_UNEXPECTED"],
      [okReceipt("plan", planResult({ target: { kernelId: KERNEL, manifestVersion: 1, registrySha256: PLAN_HASH,
        pricingMethodVersion: "v0.9" } })), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("plan", planResult({ target: { kernelId: KERNEL, manifestVersion: 1, registrySha256: REGISTRY_SHA,
        pricingMethodVersion: "sentinel with spaces" } })), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("plan", { ...planResult(), ownerDigest: "sentinel" }), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("plan", planResult({ counts: { heads: 33, members: 12, inputBytes: 4096 } })), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("plan", planResult(), { target: "staging" }), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("plan", planResult(), { clock: "test" }), "REPRICE_RECEIPT_INVALID"],
      [okReceipt("execute", executionResult()), "REPRICE_RECEIPT_INVALID"],
      [{ ...okReceipt("plan", planResult()), detail: "SELECT sentinel" }, "REPRICE_RECEIPT_INVALID"],
      // Another schema's line is not this Job's receipt at all.
      [{ ...okReceipt("plan", planResult()), schemaVersion: "analytics-refresh-receipt-v1" }, "REPRICE_RECEIPT_UNAVAILABLE"],
    ]) {
      const { out } = await run(stubGcloud({ payloads: [payload] }), code);
      assert.equal((await stat(out).catch(() => null)), null, `${code}: no receipt for an untrusted result`);
    }
    // Exactly one receipt line; none after the bounded retries is unavailable, two are ambiguous.
    const missing = await run(stubGcloud({ payloads: [] }), "REPRICE_RECEIPT_UNAVAILABLE");
    assert.equal(missing.gcloud.calls.filter((argv) => argv[1] === "logging").length, verb.RECEIPT_READ_ATTEMPTS);
    await run(stubGcloud({ payloads: [okReceipt("plan", planResult()), okReceipt("plan", planResult())] }),
      "REPRICE_RECEIPT_AMBIGUOUS");
    // The execution outcome and the receipt must agree.
    await run(stubGcloud({ outcome: "failed", payloads: [okReceipt("plan", planResult())] }), "REPRICE_RECEIPT_INVALID");
    await run(stubGcloud({ payloads: [{ schemaVersion: "analytics-reprice-receipt-v1", status: "failed",
      code: "ANALYTICS_V2_REPRICE_FAILED", phase: "plan" }] }), "REPRICE_RECEIPT_INVALID");
    // An execution that never completes is bounded.
    const stuck = await run(stubGcloud({ polls: Number.MAX_SAFE_INTEGER }), "REPRICE_EXECUTION_TIMEOUT");
    assert.equal(stuck.gcloud.describes(), verb.EXECUTION_POLL_LIMIT);
  });
});

test("a refused Job yields its closed code and phase, a failure receipt and a non-zero exit", async () => {
  await withDirectory(async (directory) => {
    const out = join(directory, "failed.json");
    const gcloud = stubGcloud({ outcome: "failed", payloads: [{ schemaVersion: "analytics-reprice-receipt-v1",
      status: "failed", code: "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE", phase: "plan" }] });
    const io = { out: [], err: [] };
    const dependencies = deps(gcloud);
    const status = await verb.runAnalyticsRepriceCli([...planArgs(), `--receipt-out=${out}`,
      `--authorize=reprice-plan:production:${COMMIT}`, "--execute"], dependencies,
    { stdout: (text) => io.out.push(text), stderr: (text) => io.err.push(text) });
    assert.equal(status, 1);
    // The coordination lock is released on a refusal too.
    assert.deepEqual(dependencies.lockEvents, ["acquired", "released"]);
    assert.deepEqual(io.out, []);
    assert.deepEqual(JSON.parse(io.err.join("")), { status: "error", code: "REPRICE_JOB_REFUSED",
      jobCode: "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE", jobPhase: "plan" });
    const written = JSON.parse(await readFile(out, "utf8"));
    assert.equal(written.outcome, "failed");
    assert.deepEqual(written.failure, { code: "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE", phase: "plan" });
    assert.equal(written.result, null);
    assert.deepEqual(verb.verifyRepriceReceipt(written, { registry: REGISTRY }), written);
    // A raw driver code in a receipt line is not a closed code, so it is refused, not echoed.
    const raw = stubGcloud({ outcome: "failed", payloads: [{ schemaVersion: "analytics-reprice-receipt-v1",
      status: "failed", code: "57014 private_owner_sentinel" }] });
    await assert.rejects(verb.runAnalyticsRepriceVerb([...planArgs(), `--receipt-out=${join(directory, "raw.json")}`,
      `--authorize=reprice-plan:production:${COMMIT}`, "--execute"], deps(raw)), rejectsCode("REPRICE_RECEIPT_INVALID"));
  });
  // The printed error is closed: unknown errors collapse, unsafe job codes are dropped.
  assert.deepEqual(verb.safeRepriceError(new Error("SELECT sentinel")), { status: "error", code: "REPRICE_FAILED" });
  assert.deepEqual(verb.safeRepriceError({ code: "REPRICE_JOB_REFUSED", jobCode: "private sentinel", jobPhase: "x" }),
    { status: "error", code: "REPRICE_JOB_REFUSED" });
  assert.deepEqual(verb.safeRepriceError({ code: "PRODUCTION_COORDINATION_LOCK_HELD" }),
    { status: "error", code: "PRODUCTION_COORDINATION_LOCK_HELD" });
});

test("execute requires the matching, sealed, fresh, uncapped plan and the same image, and forwards exact authorization", async () => {
  await withDirectory(async (directory) => {
    const planPath = await writePlanReceipt(directory);
    const out = join(directory, "execute.json");
    const authorize = `--authorize=reprice-execute:production:${PLAN_HASH}`;
    const gcloud = stubGcloud({ payloads: [okReceipt("execute", executionResult())] });
    // Dry run first: offline, with the plan's binding in the output.
    const dry = await verb.runAnalyticsRepriceVerb(executeArgs(planPath, [`--receipt-out=${out}`]),
      deps({ runner: () => { throw new Error("no call expected"); } }));
    assert.equal(dry.status, "dry-run");
    assert.deepEqual([dry.planSha256, dry.imageDigest, dry.runId], [PLAN_HASH, DIGEST, RUN]);
    const result = await verb.runAnalyticsRepriceVerb(executeArgs(planPath, [`--receipt-out=${out}`, authorize,
      "--execute"]), deps(gcloud));
    assert.equal(gcloud.calls.filter((argv) => argv[3] === "execute").length, 1);
    assert.equal(gcloud.calls.find((argv) => argv[3] === "execute")[5], `--args=${[
      "dist/analytics-reprice.mjs", "--mode=execute", ...BOUNDS, `--run-id=${RUN}`,
      `--expected-plan-sha256=${PLAN_HASH}`].join(",")}`);
    assert.deepEqual(result, {
      status: "ok", mode: "execute", environment: "production", job: TARGET.job,
      execution: `${TARGET.job}-x7k2p`, commit: COMMIT, imageDigest: DIGEST,
      kernel: { kernelId: KERNEL, manifestVersion: 1 }, planSha256: PLAN_HASH, runId: RUN,
      counts: executionResult().counts, refusals: executionResult().refusals, replayed: false,
      receiptDigestSha256: result.receiptDigestSha256,
    });
    const written = JSON.parse(await readFile(out, "utf8"));
    assert.equal(written.runId, RUN);
    assert.deepEqual(verb.verifyRepriceReceipt(written, { registry: REGISTRY }), written);
    // Same-operation replay is reported as such (the CLI returns its stored receipt).
    const replayed = await verb.runAnalyticsRepriceVerb(executeArgs(planPath, [`--receipt-out=${join(directory, "r.json")}`,
      authorize, "--execute"]), deps(stubGcloud({ payloads: [okReceipt("execute", executionResult({ replayed: true }))] })));
    assert.equal(replayed.replayed, true);

    let index = 0;
    const refused = async (path, code, { gcloudOptions = {}, extra = [], now = NOW } = {}) => {
      index += 1;
      const stub = stubGcloud({ payloads: [okReceipt("execute", executionResult())], ...gcloudOptions });
      await assert.rejects(verb.runAnalyticsRepriceVerb(executeArgs(path, [`--receipt-out=${join(directory, `x${index}.json`)}`,
        authorize, "--execute", ...extra]), deps(stub, { now: () => now })), rejectsCode(code), code);
      return stub;
    };
    // The plan receipt must exist, be sealed and match this execution exactly.
    for (const [mutate, code, options] of [
      [(body) => ({ ...body, planSha256: "0".repeat(64), result: planResult({ planSha256: "0".repeat(64) }) }),
        "REPRICE_PLAN_DIGEST_MISMATCH"],
      [(body) => ({ ...body, bounds: { ...BOUNDS_OBJECT, maxDays: 31 } }), "REPRICE_PLAN_BOUNDS_MISMATCH"],
      [(body) => ({ ...body, commit: OTHER_COMMIT }), "REPRICE_PLAN_RECEIPT_MISMATCH"],
      [(body) => ({ ...body, job: "synthetic-other-reprice" }), "REPRICE_PLAN_RECEIPT_MISMATCH"],
      [(body) => ({ ...body, environment: "staging" }), "REPRICE_PLAN_RECEIPT_MISMATCH"],
      [(body) => ({ ...body, kernel: { kernelId: 16, manifestVersion: 1 },
        result: planResult({ target: { kernelId: 16, manifestVersion: 1, registrySha256: "9".repeat(64),
          pricingMethodVersion: "v0.9" } }) }), "REPRICE_KERNEL_UNEXPECTED"],
      [(body) => ({ ...body, result: planResult({ caps: { heads: true, members: false, inputBytes: false } }) }),
        "REPRICE_PLAN_CAPPED"],
      [(body) => ({ ...body, result: planResult({ counts: { heads: 0, members: 0, inputBytes: 0 } }) }),
        "REPRICE_PLAN_EMPTY"],
      [(body) => ({ ...body, completedAt: "2026-10-11T11:59:59.000Z" }), "REPRICE_PLAN_RECEIPT_STALE"],
      [(body) => ({ ...body, mode: "execute", runId: RUN, result: executionResult() }), "REPRICE_PLAN_RECEIPT_MISMATCH"],
      [(body) => ({ ...body, outcome: "failed", kernel: null, result: null,
        failure: { code: "ANALYTICS_V2_REPRICE_FAILED", phase: "plan" } }), "REPRICE_PLAN_RECEIPT_MISMATCH"],
      [(body) => ({ ...body, result: { ...planResult(), ownerDigest: "sentinel" } }), "REPRICE_RECEIPT_FILE_INVALID"],
      [(body) => ({ ...body, extra: true }), "REPRICE_RECEIPT_FILE_INVALID"],
    ]) {
      const stub = await refused(await writePlanReceipt(directory, mutate, options), code);
      assert.equal(stub.calls.length, 0, `${code}: refused before any call`);
    }
    // A hand-edited sealed receipt fails its digest.
    const sealed = JSON.parse(await readFile(planPath, "utf8"));
    const tampered = join(directory, "tampered.json");
    await writeFile(tampered, JSON.stringify({ ...sealed, bounds: { ...sealed.bounds, maxMembers: 999 } }));
    await refused(tampered, "REPRICE_RECEIPT_FILE_INVALID");
    await refused(join(directory, "absent.json"), "REPRICE_PLAN_RECEIPT_REQUIRED");
    // A roll since the plan (another image) refuses before the execution.
    const rolled = await refused(planPath, "REPRICE_PLAN_IMAGE_MISMATCH",
      { gcloudOptions: { job: jobResource({ image: `${TARGET.imageRepository}@${OTHER_DIGEST}` }) } });
    assert.equal(rolled.calls.some((argv) => argv[3] === "execute"), false);
    // The execution receipt must bind the reviewed plan hash, kernel and manifest version.
    await refused(planPath, "REPRICE_RECEIPT_INVALID",
      { gcloudOptions: { payloads: [okReceipt("execute", executionResult({ planSha256: "0".repeat(64) }))] } });
    await refused(planPath, "REPRICE_KERNEL_UNEXPECTED",
      { gcloudOptions: { payloads: [okReceipt("execute", executionResult(), { kernel: { kernelId: KERNEL,
        manifestVersion: 2 } })] } });
    await refused(planPath, "REPRICE_RECEIPT_INVALID",
      { gcloudOptions: { payloads: [okReceipt("execute", executionResult({ counts: { planned: 3, changed: 3,
        equivalent: 1, unchanged: 0, refused: 1, contributionVersions: 2 } }))] } });
  });
});

test("the source keeps every command an argv, mutates only through execute, and never retries or mints a run id", async () => {
  const source = await readFile(new URL("./gcp-analytics-reprice.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /shell:\s*true|execSync|child_process/u);
  assert.equal([...source.matchAll(/REPRICE_ARGV\.jobExecute\(/gu)].length, 2, "one execution, plus the dry-run listing");
  assert.match(source, /context\.uuid\(\)/u);
  // The run id comes only from --run-id: the verb's uuid source names only the lock owner.
  assert.equal([...source.matchAll(/context\.uuid\(\)/gu)].length, 1);
  for (const argv of Object.values(verb.REPRICE_ARGV).map((build) => build(TARGET, ["dist/analytics-reprice.mjs"]))) {
    assert.equal(argv[0], "gcloud");
    assert.equal(argv.some((part) => /^(?:delete|update|replace|deploy|remove-iam-policy-binding)$/u.test(part)), false);
  }
});
