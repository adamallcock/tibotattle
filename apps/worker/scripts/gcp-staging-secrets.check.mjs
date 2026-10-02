/**
 * Offline check of the synthetic staging-secret provisioner (STG-PREP): a
 * dry run by default that makes no call, staging-only ids, values made in
 * process and handed to gcloud on stdin only, never in argv, output, a
 * report or an error, resumable provisioning, and version pins written into
 * the committed staging desired state. The gcloud runner is an in-memory
 * fake; PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as configuration from "../cloud-run/postgres-production-configuration.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as secrets from "./gcp-staging-secrets.mjs";
import { unpinnedStagingText } from "./fixtures/gcp-ops-infra/staging-unpinned.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(SCRIPTS_ROOT, "..");
const STAGING_PATH = join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json");
// The committed file before its pins, so these checks hold once the pins are committed too.
const STAGING_TEXT = unpinnedStagingText(readFileSync(STAGING_PATH, "utf8"));
const FIXTURE = JSON.parse(readFileSync(join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json"), "utf8"));
const PROJECT_NUMBER = "806510610397";
const VARIABLES = Object.freeze([...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES]);

function staging(mutate = () => {}) {
  manifest.loadCommittedDesiredState("staging");
  const value = JSON.parse(STAGING_TEXT);
  mutate(value);
  return manifest.assertCommittedDesiredState(manifest.validateDesiredState(value));
}

/** An in-memory Secret Manager: id -> [{ version, state }], recording every call and every stdin value. */
function secretManager(initial = {}) {
  const state = structuredClone(initial);
  const calls = [];
  const inputs = [];
  let failAddAt = null;
  const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });
  const runner = (argv, options = {}) => {
    calls.push({ argv: [...argv], stdin: options.input !== undefined });
    if (argv[0] === "secrets" && argv[1] === "list") {
      return ok(Object.keys(state).map((id) => ({ name: `projects/${PROJECT_NUMBER}/secrets/${id}`,
        replication: { userManaged: { replicas: [{ location: "us-east1" }] } } })));
    }
    if (argv.slice(0, 3).join(" ") === "secrets versions list") {
      const id = argv[3];
      return ok((state[id] ?? []).map(({ version, state: versionState }) => ({
        name: `projects/${PROJECT_NUMBER}/secrets/${id}/versions/${version}`, state: versionState })));
    }
    if (argv[0] === "secrets" && argv[1] === "create") {
      state[argv[2]] = [];
      return ok({ name: `projects/${PROJECT_NUMBER}/secrets/${argv[2]}` });
    }
    if (argv.slice(0, 3).join(" ") === "secrets versions add") {
      const id = argv[3];
      if (failAddAt !== null && inputs.length === failAddAt) return { status: 1, stdout: "" };
      inputs.push({ id, value: options.input });
      const version = String((state[id] ?? []).length + 1);
      state[id].push({ version, state: "ENABLED" });
      return ok({ name: `projects/${PROJECT_NUMBER}/secrets/${id}/versions/${version}`, state: "ENABLED",
        createTime: "2026-10-02T00:00:00Z" });
    }
    return { status: 2, stdout: "" };
  };
  return { state, calls, inputs, runner, failAddAt: (index) => { failAddAt = index; } };
}

function mutations(calls) {
  return calls.filter(({ argv }) => argv[1] === "create" || argv[2] === "add");
}

/** Every value handed to gcloud, absent from a text. */
function assertNoValues(text, inputs) {
  for (const { value } of inputs) {
    assert.equal(text.includes(value), false);
    for (const piece of value.split(/[\s"{},:]+/u).filter((part) => part.length >= 24)) {
      assert.equal(text.includes(piece), false);
    }
  }
  assert.doesNotMatch(text, /BEGIN PRIVATE KEY|"kty"|"d":|staging-inert-[A-Za-z0-9_-]/u);
}

test("arguments are closed: staging only, dry run by default, apply only with its authorization", () => {
  assert.deepEqual({ ...secrets.parseStagingSecretsArgs(["--environment=staging"]) },
    { apply: false, authorize: null, writePins: false, reportOut: null });
  assert.equal(secrets.parseStagingSecretsArgs(["--environment=staging", "--dry-run"]).apply, false);
  for (const [argv, code] of [
    [[], "STAGING_SECRETS_ENVIRONMENT_REFUSED"],
    [["--environment=production"], "STAGING_SECRETS_ENVIRONMENT_REFUSED"],
    [["--environment=test"], "STAGING_SECRETS_ENVIRONMENT_REFUSED"],
    [["--environment=staging", "--apply"], "STAGING_SECRETS_AUTHORIZATION_REQUIRED"],
    [["--environment=staging", "--authorize=staging-secrets:x:y"], "STAGING_SECRETS_AUTHORIZATION_REQUIRED"],
    [["--environment=staging", "--apply", "--dry-run", "--authorize=x"], "STAGING_SECRETS_ARGUMENT_INVALID"],
    [["--environment=staging", "--write-pins"], "STAGING_SECRETS_ARGUMENT_INVALID"],
    [["--environment=staging", "--report-out=/tmp/x.json"], "STAGING_SECRETS_ARGUMENT_INVALID"],
    [["--environment=staging", "--apply", "--authorize=x", "--report-out=relative.json"], "STAGING_SECRETS_REPORT_PATH_INVALID"],
    [["--environment=staging", "--value=x"], "STAGING_SECRETS_ARGUMENT_INVALID"],
    [["--environment=staging", "--environment=staging"], "STAGING_SECRETS_ARGUMENT_INVALID"],
  ]) {
    assert.throws(() => secrets.parseStagingSecretsArgs(argv), { code }, argv.join(" "));
  }
});

test("the dry run makes no call, prints the plan and authorization, and keeps no value", async () => {
  const world = secretManager();
  let out = "";
  const code = await secrets.main(["--environment=staging"], { runner: world.runner, loadDesired: () => staging(),
    stdout: (text) => { out += text; } });
  assert.equal(code, 0);
  assert.equal(world.calls.length, 0);
  const dry = JSON.parse(out);
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.project, "tibotattle");
  assert.match(dry.authorization, /^staging-secrets:tibotattle:[a-f0-9]{16}$/u);
  assert.equal(dry.authorization, secrets.stagingSecretsAuthorization(staging()));
  assert.deepEqual(dry.generationSelfTest, { valuesGenerated: 7, valuesChecked: 7, valuesKept: 0 });
  assert.deepEqual(dry.secrets.map((entry) => entry.variable), Object.keys(staging().secrets));
  for (const entry of dry.secrets) {
    assert.match(entry.secretId, /^tibotattle-staging-/u);
    assert.deepEqual(entry.addVersion, ["secrets", "versions", "add", entry.secretId, "--project=tibotattle", "--data-file=-",
      "--format=json"]);
    assert.deepEqual(entry.createIfMissing, ["secrets", "create", entry.secretId, "--project=tibotattle",
      "--replication-policy=user-managed", "--locations=us-east1", "--format=json"]);
    assert.equal(entry.kind, secrets.STAGING_SECRET_KINDS[entry.variable]);
  }
  assert.doesNotMatch(out, /BEGIN PRIVATE KEY|"kty"|staging-inert-[A-Za-z0-9_-]/u);
});

test("only staging plane ids are provisioned; production, test and unmarked ids are refused", () => {
  assert.equal(secrets.assertStagingSecretId("tibotattle-staging-identity-link-secret"), "tibotattle-staging-identity-link-secret");
  for (const id of ["IDENTITY_LINK_SECRET", "tibotattle-identity-link-secret", "tibotattle-staging-", "staging-identity",
    "tibotattle-test-identity-link-secret-20260922", "tibotattle-staging-production-identity", "tibotattle-staging-prod-key",
    "tibotattle-staging-test-key", "tibotattle-staging-rehearsal-key", "tibotattle-staging-synthetic-key", "", null]) {
    assert.throws(() => secrets.assertStagingSecretId(id), { code: "STAGING_SECRET_ID_REFUSED" }, String(id));
  }
  // A production desired state, or the synthetic fixture, is never a target.
  const production = manifest.validateDesiredState(JSON.parse(JSON.stringify(FIXTURE).replaceAll("synthetic-ops-project", "example-ops-prod1")));
  assert.throws(() => secrets.stagingSecretTargets(production), { code: "STAGING_SECRETS_ENVIRONMENT_REFUSED" });
  assert.throws(() => secrets.stagingSecretTargets({ ...staging(), synthetic: true }), { code: "STAGING_SECRETS_SYNTHETIC_TARGET_REFUSED" });
  // Defence in depth: an unvalidated object naming a non-staging id is refused by the provisioner itself.
  const forged = structuredClone(staging());
  forged.secrets.IDENTITY_LINK_SECRET.secretName = "IDENTITY_LINK_SECRET";
  assert.throws(() => secrets.stagingSecretTargets(forged), { code: "STAGING_SECRET_ID_REFUSED" });
  const missing = structuredClone(staging());
  delete missing.secrets.DISTRIBUTION_GITHUB_API_TOKEN;
  assert.throws(() => secrets.stagingSecretTargets(missing), { code: "STAGING_SECRETS_SET_MISMATCH" });
});

test("apply creates missing containers as OPS-2 would and adds one stdin-fed version each", () => {
  const desired = staging();
  const world = secretManager();
  const report = secrets.provisionStagingSecrets(desired, { authorize: secrets.stagingSecretsAuthorization(desired),
    runner: world.runner });
  assert.equal(report.status, "provisioned");
  assert.deepEqual(report.pins, Object.fromEntries(VARIABLES.map((name) => [name, "1"])));
  assert.ok(report.secrets.every((entry) => entry.container === "created" && entry.outcome === "added"));
  // Reads first, then per secret: create, then add.
  assert.deepEqual(world.calls[0].argv, ["secrets", "list", "--project=tibotattle", "--format=json"]);
  const changes = mutations(world.calls);
  assert.equal(changes.length, 14);
  for (const name of VARIABLES) {
    const id = desired.secrets[name].secretName;
    const create = changes.find(({ argv }) => argv[1] === "create" && argv[2] === id);
    assert.deepEqual(create.argv, ["secrets", "create", id, "--project=tibotattle", "--replication-policy=user-managed",
      "--locations=us-east1", "--format=json"]);
    assert.equal(create.stdin, false);
    const add = changes.find(({ argv }) => argv[2] === "add" && argv[3] === id);
    assert.deepEqual(add.argv, ["secrets", "versions", "add", id, "--project=tibotattle", "--data-file=-", "--format=json"]);
    assert.equal(add.stdin, true);
  }
  // Every read and create carries no stdin; no call reads a value back.
  assert.ok(world.calls.filter(({ argv }) => argv[2] !== "add").every(({ stdin }) => stdin === false));
  assert.equal(world.calls.some(({ argv }) => argv.includes("access")), false);
  // The values: fresh, staging-shaped, CR-3-valid, and nowhere in argv or the report.
  const values = new Map(world.inputs.map(({ id, value }) => [VARIABLES.find((name) => desired.secrets[name].secretName === id), value]));
  assert.equal(values.size, 7);
  secrets.assertStagingSecretValues(values);
  const publicJwk = JSON.parse(values.get("ENVELOPE_PUBLIC_JWK"));
  const privateJwk = JSON.parse(values.get("ENVELOPE_PRIVATE_JWK"));
  assert.match(publicJwk.kid, /^key:staging-[0-9a-f-]{36}$/u);
  assert.equal(privateJwk.kid, publicJwk.kid);
  assert.equal(publicJwk.d, undefined);
  assert.equal(typeof privateJwk.d, "string");
  assert.match(values.get("APPLE_PRIVATE_KEY"), /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/u);
  for (const name of ["GOOGLE_OIDC_CLIENT_SECRET", "DISTRIBUTION_GITHUB_API_TOKEN"]) {
    assert.match(values.get(name), /^staging-inert-[A-Za-z0-9_-]{43}$/u, name);
  }
  for (const name of ["IDENTITY_LINK_SECRET", "POSTGRES_RATE_LIMIT_SECRET"]) {
    assert.match(values.get(name), /^[A-Za-z0-9_-]{64}$/u, name);
  }
  assert.equal(new Set(values.values()).size, 7, "every value is distinct");
  const text = JSON.stringify(report) + JSON.stringify(world.calls);
  assertNoValues(text, world.inputs);
  // A second run makes different values: nothing is derived or cached.
  const again = secretManager();
  secrets.provisionStagingSecrets(desired, { authorize: secrets.stagingSecretsAuthorization(desired), runner: again.runner });
  for (const { value } of again.inputs) assert.equal(world.inputs.some((entry) => entry.value === value), false);
});

test("a rerun is resumable: secrets with an ENABLED version are reported, not re-added", () => {
  const desired = staging((value) => { value.secrets.IDENTITY_LINK_SECRET.version = "1"; });
  const id = (name) => desired.secrets[name].secretName;
  const world = secretManager({
    [id("IDENTITY_LINK_SECRET")]: [{ version: "1", state: "ENABLED" }, { version: "2", state: "ENABLED" }],
    [id("POSTGRES_RATE_LIMIT_SECRET")]: [{ version: "1", state: "DISABLED" }, { version: "3", state: "ENABLED" }],
    [id("ENVELOPE_PUBLIC_JWK")]: [{ version: "1", state: "ENABLED" }],
    [id("ENVELOPE_PRIVATE_JWK")]: [{ version: "1", state: "ENABLED" }],
    [id("APPLE_PRIVATE_KEY")]: [],
  });
  const report = secrets.provisionStagingSecrets(desired, { authorize: secrets.stagingSecretsAuthorization(desired),
    runner: world.runner });
  const byName = Object.fromEntries(report.secrets.map((entry) => [entry.variable, entry]));
  // The pinned ENABLED version is kept; otherwise the highest ENABLED one.
  assert.deepEqual([byName.IDENTITY_LINK_SECRET.outcome, byName.IDENTITY_LINK_SECRET.version], ["already_provisioned", "1"]);
  assert.deepEqual([byName.POSTGRES_RATE_LIMIT_SECRET.outcome, byName.POSTGRES_RATE_LIMIT_SECRET.version], ["already_provisioned", "3"]);
  assert.equal(byName.ENVELOPE_PUBLIC_JWK.outcome, "already_provisioned");
  // An empty existing container gets its first version, without a create.
  assert.deepEqual([byName.APPLE_PRIVATE_KEY.container, byName.APPLE_PRIVATE_KEY.outcome, byName.APPLE_PRIVATE_KEY.version],
    ["existing", "added", "1"]);
  assert.deepEqual([byName.GOOGLE_OIDC_CLIENT_SECRET.container, byName.GOOGLE_OIDC_CLIENT_SECRET.outcome],
    ["created", "added"]);
  assert.deepEqual(world.inputs.map((entry) => entry.id).sort(),
    [id("APPLE_PRIVATE_KEY"), id("DISTRIBUTION_GITHUB_API_TOKEN"), id("GOOGLE_OIDC_CLIENT_SECRET")].sort());
});

test("half an envelope pair, unusable versions or a wrong authorization refuse before any change", () => {
  const desired = staging();
  const id = (name) => desired.secrets[name].secretName;
  const authorize = secrets.stagingSecretsAuthorization(desired);
  for (const [initial, code] of [
    [{ [id("ENVELOPE_PUBLIC_JWK")]: [{ version: "1", state: "ENABLED" }] }, "STAGING_ENVELOPE_PAIR_PARTIAL"],
    [{ [id("APPLE_PRIVATE_KEY")]: [{ version: "1", state: "DESTROYED" }, { version: "2", state: "DISABLED" }] },
      "STAGING_SECRET_VERSIONS_UNUSABLE:APPLE_PRIVATE_KEY"],
  ]) {
    const world = secretManager(initial);
    assert.throws(() => secrets.provisionStagingSecrets(desired, { authorize, runner: world.runner }), { code }, code);
    assert.equal(mutations(world.calls).length, 0, code);
  }
  for (const wrong of [undefined, "staging-secrets:tibotattle:0000000000000000", `${authorize}x`,
    "bucket-birth:tibotattle:tibotattle-staging-quarantine"]) {
    const world = secretManager();
    assert.throws(() => secrets.provisionStagingSecrets(desired, { authorize: wrong, runner: world.runner }),
      { code: "STAGING_SECRETS_AUTHORIZATION_MISMATCH" });
    assert.equal(world.calls.length, 0);
  }
  assert.throws(() => secrets.generateStagingSecretValues(["ENVELOPE_PRIVATE_JWK"]), { code: "STAGING_ENVELOPE_PAIR_PARTIAL" });
});

test("a failure after a change reports content-free outcomes, and the CLI never echoes a value", async () => {
  const desired = staging();
  const world = secretManager();
  world.failAddAt(2);
  let error;
  try {
    secrets.provisionStagingSecrets(desired, { authorize: secrets.stagingSecretsAuthorization(desired), runner: world.runner });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, "GCLOUD_CALL_FAILED:secrets-versions-add");
  assert.deepEqual(error.outcomes.map((entry) => entry.outcome), ["added", "added", "pending"]);
  assert.deepEqual(error.outcomes.map((entry) => entry.container), ["created", "created", "created"]);
  assertNoValues(JSON.stringify(error.outcomes) + error.message, world.inputs);
  const cli = secretManager();
  cli.failAddAt(1);
  let out = "";
  let err = "";
  const code = await secrets.main(["--environment=staging", "--apply", `--authorize=${secrets.stagingSecretsAuthorization(desired)}`],
    { runner: cli.runner, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
  assert.equal(code, 1);
  assert.equal(out, "");
  const reported = JSON.parse(err);
  assert.equal(reported.code, "GCLOUD_CALL_FAILED:secrets-versions-add");
  assert.equal(reported.outcomes[0].version, "1");
  assertNoValues(err, cli.inputs);
});

test("the gcloud guard admits only its shapes, the plane's project, JSON, and stdin only for a version add", () => {
  const seen = [];
  const runner = (argv, options) => { seen.push({ argv, options }); return { status: 0, stdout: "[]" }; };
  const values = new Map([["IDENTITY_LINK_SECRET", "synthetic-guard-value-0000000000000000000001"]]);
  const call = secrets.guardedStagingSecretsGcloud(runner, { project: "tibotattle", values });
  const project = "--project=tibotattle";
  for (const [argv, options, code] of [
    [["secrets", "versions", "access", "latest", "--secret=x", project, "--format=json"], {}, "GCLOUD_COMMAND_FORBIDDEN"],
    [["secrets", "delete", "x", project, "--format=json"], {}, "GCLOUD_COMMAND_FORBIDDEN"],
    [["secrets", "versions", "destroy", "1", project, "--format=json"], {}, "GCLOUD_COMMAND_FORBIDDEN"],
    [["run", "services", "list", project, "--format=json"], {}, "GCLOUD_COMMAND_FORBIDDEN"],
    [["secrets", "list", "--format=json"], {}, "GCLOUD_PROJECT_FLAG_INVALID"],
    [["secrets", "list", "--project=other-project", "--format=json"], {}, "GCLOUD_PROJECT_FLAG_INVALID"],
    [["secrets", "list", project, "--project=other", "--format=json"], {}, "GCLOUD_PROJECT_FLAG_INVALID"],
    [["secrets", "list", project], {}, "GCLOUD_READ_FORMAT_REQUIRED"],
    [["secrets", "list", project, "--format=json"], { input: "x" }, "GCLOUD_STDIN_CONTRACT_BROKEN"],
    [["secrets", "versions", "add", "x", project, "--data-file=-", "--format=json"], {}, "GCLOUD_STDIN_CONTRACT_BROKEN"],
    [["secrets", "versions", "add", "x", project, "--data-file=/tmp/value", "--format=json"], { input: "x" },
      "GCLOUD_STDIN_CONTRACT_BROKEN"],
    [["secrets", "create", "x", project, `--labels=v=${values.get("IDENTITY_LINK_SECRET")}`, "--format=json"], {},
      "GCLOUD_ARGV_VALUE_FORBIDDEN"],
  ]) {
    assert.throws(() => call(argv, options), { code }, argv.join(" "));
  }
  assert.equal(seen.length, 0);
  assert.deepEqual(call(["secrets", "list", project, "--format=json"]), []);
  call(["secrets", "versions", "add", "x", project, "--data-file=-", "--format=json"], { input: "v" });
  assert.deepEqual(seen.at(-1).options, { input: "v" });
  assert.deepEqual(seen[0].options, {});
});

test("--write-pins pins every reported version into the committed staging file, and nothing else", async () => {
  const desired = staging();
  const world = secretManager();
  let written = null;
  const pinStore = { readFile: () => STAGING_TEXT, writeFile: (text) => { written = text; } };
  let out = "";
  const code = await secrets.main(["--environment=staging", "--apply", "--write-pins",
    `--authorize=${secrets.stagingSecretsAuthorization(desired)}`],
  { runner: world.runner, pinStore, loadDesired: () => desired, stdout: (text) => { out += text; } });
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.pinned.changed, true);
  assert.deepEqual(result.pinned.applied, Object.fromEntries(VARIABLES.map((name) => [name, "1"])));
  const pinned = JSON.parse(written);
  const expected = JSON.parse(STAGING_TEXT);
  for (const name of VARIABLES) expected.secrets[name].version = "1";
  assert.deepEqual(pinned, expected);
  // Only the seven version lines differ.
  const before = STAGING_TEXT.split("\n");
  const after = written.split("\n");
  assert.equal(before.length, after.length);
  const changed = before.filter((line, index) => line !== after[index]);
  assert.equal(changed.length, 7);
  assert.ok(changed.every((line) => /"version": null \},?$/u.test(line)));
  assertNoValues(out + written, world.inputs);
  assert.equal(manifest.validateDesiredState(pinned).secrets.APPLE_PRIVATE_KEY.version, "1");
});

test("--report-out writes the content-free report exclusively and owner-only", async () => {
  const desired = staging();
  const directory = await mkdtemp(join(tmpdir(), "gcp-staging-secrets-"));
  try {
    const path = join(directory, "report.json");
    const world = secretManager();
    const code = await secrets.main(["--environment=staging", "--apply", `--report-out=${path}`,
      `--authorize=${secrets.stagingSecretsAuthorization(desired)}`],
    { runner: world.runner, loadDesired: () => desired, stdout: () => {} });
    assert.equal(code, 0);
    const text = await readFile(path, "utf8");
    assert.equal(JSON.parse(text).schema, secrets.STAGING_SECRETS_REPORT_SCHEMA);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assertNoValues(text, world.inputs);
    // An existing report path refuses; the versions were already added, so the outcomes are reported.
    let err = "";
    const again = await secrets.main(["--environment=staging", "--apply", `--report-out=${path}`,
      `--authorize=${secrets.stagingSecretsAuthorization(desired)}`],
    { runner: secretManager().runner, loadDesired: () => desired, stdout: () => {}, stderr: (value) => { err += value; } });
    assert.equal(again, 1);
    assert.equal(JSON.parse(err).code, "STAGING_SECRETS_REPORT_PATH_UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the provisioner source keeps values off disk, out of argv and out of output", () => {
  const source = readFileSync(join(SCRIPTS_ROOT, "gcp-staging-secrets.mjs"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /writeFileSync|appendFile|console\.|versions", "access"|--data-file=\/|process\.env/u);
  assert.match(code, /stdio: \[input === undefined \? "ignore" : "pipe", "pipe", "ignore"\]/u);
  // The one file it writes is the content-free report.
  assert.equal([...code.matchAll(/handle\.writeFile\(/gu)].length, 1);
  assert.match(code, /handle\.writeFile\(`\$\{JSON\.stringify\(report, null, 2\)\}\\n`/u);
});
