/**
 * Offline check of the OPS-2 operator CLI (scripts/gcp-infra.mjs): closed
 * arguments, a dry run by default, render with no call, plan and readback
 * through read shapes only, apply only under --authorize and never for the
 * synthetic fixture, OPS-10's `readback --require-clean --environment=<env>`
 * form, and named error codes that never echo gcloud output. The runner is
 * the synthetic in-memory gcloud; PATH is blanked for this process and for
 * the spawned CLI, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyGcloudCommand } from "./gcp-ops-infra-operations.mjs";
import { main, parseGcpInfraArgs } from "./gcp-infra.mjs";
import { INFRA_READBACK_ARGV, ROLLOUT_ARGV } from "./gcp-production-rollout.mjs";
import {
  bornBucket,
  createFakeGcloud,
  emptyWorld,
  memoryWriter,
  withSecretValues,
} from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = dirname(SCRIPTS_ROOT);
const FIXTURE_PATH = join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const UNMARKED_PATH = "/synthetic-desired/example-ops-prod1.json";
const UNMARKED_TEXT = FIXTURE_TEXT.replaceAll("synthetic-ops-project", "example-ops-prod1");
const IMAGE = ["--bootstrap-image-digest=" + "c".repeat(64), "--bootstrap-source-commit=" + "d".repeat(40)];

function readFile(path) {
  if (path === FIXTURE_PATH) return FIXTURE_TEXT;
  if (path === UNMARKED_PATH) return UNMARKED_TEXT;
  throw new Error("synthetic: unexpected read");
}

function world(project) {
  const value = withSecretValues(emptyWorld(), { project, region: "us-east1",
    names: ["IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET", "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK",
      "GOOGLE_OIDC_CLIENT_SECRET", "APPLE_PRIVATE_KEY"] });
  value.buckets.push(bornBucket({ name: "synthetic-ops-quarantine", location: "US-EAST1" }));
  return value;
}

async function run(argv, { project = "synthetic-ops-project", gcloud, writer = memoryWriter(), env = {} } = {}) {
  const fake = gcloud ?? createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  const out = [];
  const err = [];
  const code = await main(argv, {
    runner: fake.runner,
    fetchImpl: async () => { throw new Error("synthetic: no network in this check"); },
    readFile,
    env,
    createSpecWriter: () => writer.create(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join(""), err: err.join(""), calls: fake.calls, fake };
}

test("arguments are closed and dangerous combinations are refused", () => {
  assert.deepEqual(parseGcpInfraArgs(["plan", `--desired-state=${FIXTURE_PATH}`]), {
    command: "plan", desiredStatePath: FIXTURE_PATH, environment: null, bootstrap: null, authorize: null, apply: false,
    requireClean: false, receiptPath: null,
  });
  // OPS-10's preflight argv (ROLLOUT_ARGV.infraReadback): no path, the environment's variable names it.
  assert.deepEqual(parseGcpInfraArgs(["readback", "--require-clean", "--environment=production"]), {
    command: "readback", desiredStatePath: null, environment: "production", bootstrap: null, authorize: null,
    apply: false, requireClean: true, receiptPath: null,
  });
  const cases = [
    [[], "GCP_INFRA_COMMAND_INVALID"],
    [["destroy", `--desired-state=${FIXTURE_PATH}`], "GCP_INFRA_COMMAND_INVALID"],
    [["plan"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["plan", "--desired-state=relative.json"], "GCP_INFRA_DESIRED_STATE_PATH_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, `--desired-state=${FIXTURE_PATH}`], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--authorize=" + "a".repeat(64)], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--apply"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", `--desired-state=${FIXTURE_PATH}`, ...IMAGE], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, IMAGE[0]], "BOOTSTRAP_IMAGE_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--bootstrap-image-digest=latest", IMAGE[1]], "BOOTSTRAP_IMAGE_INVALID"],
    [["apply", `--desired-state=${FIXTURE_PATH}`], "APPLY_AUTHORIZATION_REQUIRED"],
    [["apply", `--desired-state=${FIXTURE_PATH}`, "--authorize"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply"], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--authorize=bucket-birth:x:y"], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--receipt-out=/synthetic/receipt.json"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply", "--authorize=bucket-birth:x:y",
      "--receipt-out=relative.json"], "BUCKET_BIRTH_RECEIPT_PATH_INVALID"],
    [["plan", `--desired-state=${FIXTURE_PATH}`, "--force"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["readback", "--require-clean"], "GCP_INFRA_ARGUMENT_MISSING"],
    [["readback", "--environment=test"], "GCP_INFRA_ENVIRONMENT_INVALID"],
    [["readback", "--environment="], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--environment=staging"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean", "--require-clean"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["readback", "--environment=production", "--require-clean=yes"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["plan", "--environment=production", "--require-clean"], "GCP_INFRA_ARGUMENT_INVALID"],
    [["apply", "--environment=production", "--require-clean", "--authorize=" + "a".repeat(64)],
      "GCP_INFRA_ARGUMENT_INVALID"],
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => parseGcpInfraArgs(argv), { code }, argv.join(" "));
  }
});

test("render makes no call and shows the estate", async () => {
  const result = await run(["render", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 0);
  const rendered = JSON.parse(result.out);
  assert.equal(rendered.schema, "tibotattle-gcp-ops-infra-render-v1");
  assert.equal(rendered.synthetic, true);
  assert.equal(rendered.connectionBudget.total, 82);
  assert.deepEqual(rendered.service, { unavailable: "BOOTSTRAP_IMAGE_REQUIRED" });
  assert.deepEqual(rendered.scheduler, { "analytics-refresh": { unavailable: "SCHEDULER_CADENCE_UNSET" } });
  assert.deepEqual(Object.keys(rendered.jobs), ["production-migrate", "analytics-refresh"]);
  const withImage = JSON.parse((await run(["render", `--desired-state=${FIXTURE_PATH}`, ...IMAGE])).out);
  assert.equal(withImage.service.kind, "Service");
  assert.equal(withImage.jobs["production-migrate"].kind, "Job");
  // Deferred while its entry refuses a production target.
  assert.deepEqual(withImage.jobs["analytics-refresh"], { unavailable: "ANALYTICS_REFRESH_PRODUCTION_TARGET_UNAVAILABLE" });
  assert.doesNotMatch(JSON.stringify(withImage), /LEDGER|ERASURE_BUCKET_HISTORY_PROOF/u);
  // OD-2: the service carries the quarantine bucket's pinned birth proof.
  assert.match(JSON.stringify(withImage), /GCS_QUARANTINE_BUCKET_HISTORY_PROOF/u);
});

test("readback and plan issue read shapes only and the plan is a dry run", async () => {
  const readback = await run(["readback", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(readback.code, 0, readback.err);
  assert.ok(readback.calls.length > 0);
  assert.ok(readback.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  const first = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE]);
  const second = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE]);
  assert.equal(first.code, 0, first.err);
  assert.ok(first.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  assert.equal(JSON.parse(first.out).planDigest, JSON.parse(second.out).planDigest);
  assert.equal(first.calls.map((argv) => argv.join(" ")).join("\n").includes("versions access"), false);
  // A plan that apply would refuse exits 2.
  const stale = createFakeGcloud(world("synthetic-ops-project"), { project: "synthetic-ops-project", region: "us-east1" });
  stale.world.buckets[0].metageneration = "2";
  const refused = await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE], { gcloud: stale });
  assert.equal(refused.code, 2);
  assert.deepEqual(JSON.parse(refused.out).findings, ["BUCKET_PROOF_STALE"]);
});

test("apply refuses the synthetic fixture before any call, and runs an authorized plan otherwise", async () => {
  const plan = JSON.parse((await run(["plan", `--desired-state=${FIXTURE_PATH}`, ...IMAGE])).out);
  const refused = await run(["apply", `--desired-state=${FIXTURE_PATH}`, `--authorize=${plan.planDigest}`, ...IMAGE]);
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.err), { status: "error", code: "APPLY_SYNTHETIC_TARGET_REFUSED" });
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.out, "");

  const project = "example-ops-prod1";
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  const unmarked = JSON.parse((await run(["plan", `--desired-state=${UNMARKED_PATH}`, ...IMAGE], { gcloud })).out);
  gcloud.calls.length = 0;
  const stale = await run(["apply", `--desired-state=${UNMARKED_PATH}`, `--authorize=${"0".repeat(64)}`, ...IMAGE],
    { gcloud });
  assert.deepEqual(JSON.parse(stale.err), { status: "error", code: "APPLY_PLAN_DIGEST_MISMATCH" });
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  gcloud.calls.length = 0;
  const applied = await run(["apply", `--desired-state=${UNMARKED_PATH}`, `--authorize=${unmarked.planDigest}`, ...IMAGE],
    { gcloud, writer });
  assert.equal(applied.code, 0, applied.err);
  const receipt = JSON.parse(applied.out);
  assert.equal(receipt.planDigest, unmarked.planDigest);
  assert.equal(receipt.remaining.executable, 0);
  assert.ok(gcloud.calls.some((argv) => classifyGcloudCommand(argv) === "mutate"));
  // A failed step is reported with what ran, never with gcloud output.
  const failing = createFakeGcloud(world(project), { project, region: "us-east1",
    failWhen: (argv) => argv[0] === "iam" && argv[2] === "create" });
  const failingPlan = JSON.parse((await run(["plan", `--desired-state=${UNMARKED_PATH}`, ...IMAGE],
    { gcloud: failing })).out);
  const broken = await run(["apply", `--desired-state=${UNMARKED_PATH}`, `--authorize=${failingPlan.planDigest}`, ...IMAGE],
    { gcloud: failing });
  assert.equal(broken.code, 1);
  const error = JSON.parse(broken.err);
  assert.equal(error.code, "APPLY_OPERATION_FAILED");
  assert.equal(error.operation, "service-account:create:runtime");
  assert.deepEqual(error.outcomes, [{ id: "service-account:create:runtime", outcome: "failed" }]);
  assert.equal(broken.err.includes("MARKER"), false);
});

test("readback --require-clean --environment is OPS-10's preflight: exit 0 only when clean", async () => {
  const project = "example-ops-prod1";
  const env = { GCP_INFRA_DESIRED_STATE_PRODUCTION: UNMARKED_PATH };
  // Exactly the argv OPS-10's rollout runs (from apps/worker), less `node <script>`.
  const rolloutArgv = ROLLOUT_ARGV.infraReadback("production");
  assert.deepEqual(rolloutArgv.slice(0, 2), ["node", "scripts/gcp-infra.mjs"]);
  assert.deepEqual(rolloutArgv.slice(0, INFRA_READBACK_ARGV.length), [...INFRA_READBACK_ARGV]);
  const preflight = rolloutArgv.slice(2);
  assert.deepEqual(preflight, ["readback", "--require-clean", "--environment=production"]);
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world(project), { files: writer.files, project, region: "us-east1" });
  // An estate apply has not built yet is not clean.
  const empty = await run(preflight, { gcloud, env });
  assert.equal(empty.code, 2, empty.err);
  const dirty = JSON.parse(empty.out);
  assert.equal(dirty.schema, "tibotattle-gcp-ops-infra-clean-v1");
  assert.equal(dirty.clean, false);
  assert.ok(dirty.reasons.includes("EXECUTABLE:cloud-sql:create"));
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  // Converge it, then the preflight passes; the readback is carried for OPS-10's digest.
  const plan = JSON.parse((await run(["plan", "--environment=production", ...IMAGE], { gcloud, env })).out);
  assert.equal((await run(["apply", "--environment=production", `--authorize=${plan.planDigest}`, ...IMAGE],
    { gcloud, writer, env })).code, 0);
  gcloud.calls.length = 0;
  const clean = await run(preflight, { gcloud, env });
  assert.equal(clean.code, 0, clean.out);
  const verdict = JSON.parse(clean.out);
  assert.deepEqual([verdict.clean, verdict.reasons, verdict.environment, verdict.project],
    [true, [], "production", project]);
  assert.deepEqual(verdict.summary, { executable: 0, deferred: 3, refused: 0 });
  assert.equal(verdict.readback.schema, "tibotattle-gcp-ops-infra-readback-v1");
  assert.ok(gcloud.calls.every((argv) => classifyGcloudCommand(argv) === "read"));
  // A running trigger, a stale proof or any drift fails it.
  gcloud.world.buckets[0].metageneration = "2";
  const stale = await run(preflight, { gcloud, env });
  assert.equal(stale.code, 2);
  assert.deepEqual(JSON.parse(stale.out).reasons, ["FINDING:BUCKET_PROOF_STALE"]);
  // The path comes only from the environment's own variable, and the file must describe it.
  for (const [argv, environment, code] of [
    [preflight, {}, "GCP_INFRA_DESIRED_STATE_UNCONFIGURED"],
    [preflight, { GCP_INFRA_DESIRED_STATE_PRODUCTION: "relative.json" }, "GCP_INFRA_DESIRED_STATE_PATH_INVALID"],
    [["readback", "--require-clean", "--environment=staging"], { GCP_INFRA_DESIRED_STATE_STAGING: UNMARKED_PATH },
      "GCP_INFRA_ENVIRONMENT_MISMATCH"],
    [["readback", "--environment=staging", `--desired-state=${UNMARKED_PATH}`], {}, "GCP_INFRA_ENVIRONMENT_MISMATCH"],
  ]) {
    const refused = await run(argv, { gcloud, env: environment });
    assert.equal(refused.code, 1, code);
    assert.deepEqual(JSON.parse(refused.err), { status: "error", code }, code);
    assert.equal(refused.out, "", code);
  }
});

test("bucket birth is a dry run by default and refuses the synthetic fixture", async () => {
  const dry = await run(["bucket-birth", `--desired-state=${FIXTURE_PATH}`]);
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.out).status, "dry_run");
  assert.equal(dry.calls.length, 0);
  const refused = await run(["bucket-birth", `--desired-state=${FIXTURE_PATH}`, "--apply",
    "--authorize=bucket-birth:synthetic-ops-project:synthetic-ops-quarantine"]);
  assert.deepEqual(JSON.parse(refused.err), { status: "error", code: "BUCKET_BIRTH_SYNTHETIC_TARGET_REFUSED" });
  assert.equal(refused.calls.length, 0);
});

test("a bad desired state is a named error", async () => {
  const result = await run(["plan", "--desired-state=/synthetic-desired/absent.json"]);
  assert.deepEqual(JSON.parse(result.err), { status: "error", code: "DESIRED_STATE_UNREADABLE" });
  assert.equal(result.calls.length, 0);
});

test("the CLI runs through a symlinked path, fails closed and finds no gcloud", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-infra-cli-"));
  try {
    const realPath = join(SCRIPTS_ROOT, "gcp-infra.mjs");
    const linkedPath = join(directory, "gcp-infra.mjs");
    await symlink(realPath, linkedPath);
    const env = { PATH: "/nonexistent-gcloud-guard" };
    for (const entry of [realPath, linkedPath]) {
      const invalid = spawnSync(process.execPath, [entry, "destroy"], { encoding: "utf8", env, cwd: WORKER_ROOT });
      assert.equal(invalid.status, 1, entry);
      assert.equal(invalid.stdout, "", entry);
      assert.deepEqual(JSON.parse(invalid.stderr), { status: "error", code: "GCP_INFRA_COMMAND_INVALID" }, entry);
    }
    // With no gcloud on PATH, a real plan fails closed rather than reporting an empty estate.
    const plan = spawnSync(process.execPath, [realPath, "plan", `--desired-state=${FIXTURE_PATH}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(plan.status, 1);
    assert.deepEqual(JSON.parse(plan.stderr), { status: "error", code: "GCLOUD_CALL_FAILED:iam-service-accounts-list" });
    const render = spawnSync(process.execPath, [realPath, "render", `--desired-state=${FIXTURE_PATH}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(render.status, 0, render.stderr);
    assert.equal(JSON.parse(render.stdout).project, "synthetic-ops-project");
    // A desired state written elsewhere is read from its absolute path.
    const copy = join(directory, "desired.json");
    await writeFile(copy, FIXTURE_TEXT);
    const fromCopy = spawnSync(process.execPath, [realPath, "render", `--desired-state=${copy}`],
      { encoding: "utf8", env, cwd: WORKER_ROOT });
    assert.equal(fromCopy.status, 0, fromCopy.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no OPS-2 module uses a shell, and the package runs exactly these checks", () => {
  for (const name of ["gcp-infra.mjs", "gcp-ops-infra-manifest.mjs", "gcp-ops-infra-operations.mjs",
    "gcp-ops-bucket-birth.mjs"]) {
    const source = readFileSync(join(SCRIPTS_ROOT, name), "utf8");
    // A regular expression's .exec() is not a process call.
    assert.doesNotMatch(source, /\bexecSync\b|(?<![.\w])exec\(|\bexecFile|shell:\s*true|["'`](?:sh|bash|zsh)["'`]/u, name);
    assert.doesNotMatch(source, /postgres-ledger-authority/u, name);
  }
  const scripts = JSON.parse(readFileSync(join(WORKER_ROOT, "package.json"), "utf8")).scripts;
  const gate = scripts["gcp:ops:infra:check"];
  for (const check of ["gcp-ops-infra-manifest.check.mjs", "gcp-ops-infra-operations.check.mjs",
    "gcp-ops-bucket-birth.check.mjs", "gcp-infra.check.mjs"]) {
    assert.ok(gate.includes(`./scripts/${check}`), check);
  }
  assert.doesNotMatch(gate, /gcloud|wrangler|--apply|apply /u);
});
