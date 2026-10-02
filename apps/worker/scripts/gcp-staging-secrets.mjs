#!/usr/bin/env node

/**
 * Synthetic staging-secret provisioner (STG-PREP).
 *
 *   node scripts/gcp-staging-secrets.mjs --environment=staging [--dry-run]
 *   node scripts/gcp-staging-secrets.mjs --environment=staging --apply
 *        --authorize=staging-secrets:<project>:<id-set digest>
 *        [--write-pins] [--report-out=<absolute path>]
 *
 * For each Secret Manager secret the committed staging desired state names
 * (cloud-run/infra/staging.desired-state.json), it makes one synthetic value
 * in this process and adds it as a new secret version, piping it to
 * `gcloud secrets versions add <id> --data-file=-` through stdin. A value is
 * never printed, logged, written to disk, put in argv or attached to an
 * error; the output names secret ids, value kinds and version numbers only.
 *
 * Values (STAGING_SECRET_KINDS), synthetic and staging-only:
 * - IDENTITY_LINK_SECRET, POSTGRES_RATE_LIMIT_SECRET: 48 random bytes,
 *   base64url (64 characters; CR-3 needs at least 32).
 * - ENVELOPE_PUBLIC_JWK, ENVELOPE_PRIVATE_JWK: one freshly generated RSA-2048
 *   pair, as JWKs with one key id `key:staging-<uuid>` (CR-3's staging plane
 *   requires the staging token on the key id). The pair is one unit: both
 *   keys get a version from the same pair in the same run, the public key
 *   first (ENVELOPE_PAIR), and values for half a pair are never made.
 * - GOOGLE_OIDC_CLIENT_SECRET, DISTRIBUTION_GITHUB_API_TOKEN: INERT,
 *   `staging-inert-` plus 32 random bytes. They are no Google client secret
 *   and no GitHub token; Google sign-in on staging cannot complete, and a
 *   GitHub call with the token is refused by GitHub.
 * - APPLE_PRIVATE_KEY: INERT, a freshly generated P-256 PKCS#8 PEM that no
 *   Apple key id names; Apple sign-in on staging cannot complete.
 * The staging template pairs these with inert identifiers
 * (STAGING_INERT_IDENTITY_PROVIDER_VARS in gcp-ops-infra-manifest.mjs).
 *
 * Only staging: --environment must be staging, every id must be the staging
 * plane's (`tibotattle-staging-...`, STAGING_SECRET_ID) and none may carry a
 * production or test token (STAGING_SECRET_ID_REFUSED), and the desired state
 * must be the committed, non-synthetic staging file.
 *
 * Dry run (the default, or --dry-run) makes no call: it prints the plan, the
 * exact --authorize value and a generation self-test (values made, checked
 * against CR-3's grammar, and discarded). --apply needs --authorize equal to
 * that value. It then reads the project's secret list and each existing
 * secret's version list (names and states only), and:
 * - creates a missing secret container exactly as OPS-2 apply would
 *   (user-managed replication in the plane's region), so the OPS-2 readback
 *   sees it as converged and only binds the runtime's accessor role;
 * - skips a secret that already has an ENABLED version (resumable: a rerun
 *   after a partial failure provisions only what is missing) and reports the
 *   version to pin (the pinned one when it is ENABLED, else the highest
 *   ENABLED one);
 * - adds the envelope pair as one unit: when either key has no ENABLED
 *   version, a fresh pair and a new version on BOTH keys. When the other key
 *   already had one, that is a reissue (envelopePairReissued): the forward
 *   path after a failure between the two adds, which leaves a public version
 *   with no private partner. That orphan stays ENABLED but unpinned, and only
 *   pinned versions are read. A reissue that would move a committed pin
 *   refuses (STAGING_ENVELOPE_PAIR_PARTIAL). Because the private key is only
 *   ever added right after its public key succeeded in the same run, whenever
 *   both keys have an ENABLED version the highest of each comes from one
 *   pair;
 * - refuses a secret whose versions are all disabled or destroyed
 *   (STAGING_SECRET_VERSIONS_UNUSABLE), for a human to decide.
 * It never disables, destroys or deletes anything and never reads a value
 * back (`secrets versions access` is not a shape it can issue).
 *
 * Every gcloud call carries --no-log-http (the guard refuses one without it,
 * GCLOUD_LOG_HTTP_REQUIRED_OFF). The flag outranks core/log_http from the
 * gcloud config and CLOUDSDK_CORE_LOG_HTTP, so gcloud never writes a
 * `versions add` request body, which carries the value, to its log files.
 *
 * --write-pins then pins every reported version into the committed staging
 * desired state (gcp-staging-desired-state.mjs). --report-out names the
 * content-free report file. It is reserved (created exclusively, owner-only,
 * never through a symlink) before the first gcloud call, so an unusable path
 * refuses with nothing called. It is filled at the end and removed when the
 * run fails, so the same command can be rerun.
 *
 * Output: one content-free JSON document on stdout; exit 0 on success, 1 on
 * error, with {"status":"error","code":...} on stderr (plus the content-free
 * outcomes when a failure follows a change). gcloud's stderr is discarded,
 * never echoed.
 */

import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  GcpOpsInfraError,
  STAGING_SECRET_ID,
  deepFreeze,
  fail,
  loadCommittedDesiredState,
} from "./gcp-ops-infra-manifest.mjs";
import { pinStagingSecretVersions, updateStagingDesiredState } from "./gcp-staging-desired-state.mjs";

export const STAGING_SECRETS_REPORT_SCHEMA = "tibotattle-gcp-staging-secrets-v1";
export const STAGING_SECRETS_ENVIRONMENT = "staging";

/** Each staging secret's synthetic value kind. INERT values authorize nothing anywhere. */
export const STAGING_SECRET_KINDS = Object.freeze({
  IDENTITY_LINK_SECRET: "random-48-bytes-base64url",
  POSTGRES_RATE_LIMIT_SECRET: "random-48-bytes-base64url",
  ENVELOPE_PUBLIC_JWK: "rsa-2048-public-jwk-staging-kid",
  ENVELOPE_PRIVATE_JWK: "rsa-2048-private-jwk-staging-kid",
  GOOGLE_OIDC_CLIENT_SECRET: "inert-random",
  APPLE_PRIVATE_KEY: "inert-p256-pkcs8-pem",
  DISTRIBUTION_GITHUB_API_TOKEN: "inert-random",
});
export const ENVELOPE_PAIR = Object.freeze(["ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK"]);
export const INERT_VALUE_PREFIX = "staging-inert-";

/** Turns gcloud's HTTP logging off for the call, whatever the config or environment says. */
export const GCLOUD_NO_LOG_HTTP = "--no-log-http";

/** gcloud command shapes this tool may issue, and nothing else. */
export const STAGING_SECRETS_COMMANDS = Object.freeze({
  "secrets list": "read",
  "secrets versions list": "read",
  "secrets create": "mutate",
  "secrets versions add": "mutate",
});

const GCLOUD_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const GCLOUD_TIMEOUT_MS = 120_000;
const VERSION_NAME = /^projects\/[a-z0-9-]+\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9][0-9]{0,9})$/u;
const VERSION = /^[1-9][0-9]{0,9}$/u;
const KID = /^key:[A-Za-z0-9._-]{1,64}$/u;
const PKCS8_PEM = /-----BEGIN PRIVATE KEY-----([\sA-Za-z0-9+/=]+)-----END PRIVATE KEY-----/u;
const MAX_SECRET_BYTES = 65_536;
const FORBIDDEN_ID_TOKENS = Object.freeze(["production", "prod", "test", "rehearsal", "synthetic"]);

/** The exact argv of each call, for the dry run and the apply alike. */
function secretsArgv(desired) {
  const project = `--project=${desired.project}`;
  const common = ["--format=json", GCLOUD_NO_LOG_HTTP];
  return Object.freeze({
    list: () => ["secrets", "list", project, ...common],
    versions: (secretId) => ["secrets", "versions", "list", secretId, project, ...common],
    create: (secretId) => ["secrets", "create", secretId, project, "--replication-policy=user-managed",
      `--locations=${desired.region}`, ...common],
    add: (secretId) => ["secrets", "versions", "add", secretId, project, "--data-file=-", ...common],
  });
}

function tokens(value) {
  return String(value).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

/** A staging plane secret id, or STAGING_SECRET_ID_REFUSED. */
export function assertStagingSecretId(id) {
  if (typeof id !== "string" || !STAGING_SECRET_ID.test(id)
      || tokens(id).some((token) => FORBIDDEN_ID_TOKENS.includes(token))) {
    fail("STAGING_SECRET_ID_REFUSED");
  }
  return id;
}

/** The provisioning targets of a validated staging desired state, in desired-state order. */
export function stagingSecretTargets(desired) {
  if (desired?.environment !== STAGING_SECRETS_ENVIRONMENT) fail("STAGING_SECRETS_ENVIRONMENT_REFUSED");
  if (desired.synthetic) fail("STAGING_SECRETS_SYNTHETIC_TARGET_REFUSED");
  const names = Object.keys(desired.secrets);
  if (names.slice().sort().join() !== Object.keys(STAGING_SECRET_KINDS).sort().join()) {
    fail("STAGING_SECRETS_SET_MISMATCH");
  }
  return deepFreeze(names.map((variable) => ({
    variable,
    secretId: assertStagingSecretId(desired.secrets[variable].secretName),
    kind: STAGING_SECRET_KINDS[variable],
    pinned: desired.secrets[variable].version,
  })));
}

/** The exact --authorize value: the project and a digest of the variable-to-id map. */
export function stagingSecretsAuthorization(desired) {
  const targets = stagingSecretTargets(desired);
  const digest = createHash("sha256")
    .update(canonicalJson(targets.map(({ variable, secretId }) => [variable, secretId])), "utf8")
    .digest("hex").slice(0, 16);
  return `staging-secrets:${desired.project}:${digest}`;
}

// ---------------------------------------------------------------------------
// Synthetic values (in process only)

function randomToken() {
  return randomBytes(48).toString("base64url");
}

function inertToken() {
  return `${INERT_VALUE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function envelopePair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const kid = `key:staging-${randomUUID()}`;
  return {
    ENVELOPE_PUBLIC_JWK: JSON.stringify({ ...publicKey.export({ format: "jwk" }), kid }),
    ENVELOPE_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
  };
}

function inertAppleKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

/**
 * Fresh synthetic values for `variables` (a Map; the caller drops it). The
 * envelope pair is always made together.
 */
export function generateStagingSecretValues(variables) {
  const values = new Map();
  const wanted = new Set(variables);
  if (ENVELOPE_PAIR.some((name) => wanted.has(name))) {
    if (!ENVELOPE_PAIR.every((name) => wanted.has(name))) fail("STAGING_ENVELOPE_PAIR_PARTIAL");
    const pair = envelopePair();
    for (const name of ENVELOPE_PAIR) values.set(name, pair[name]);
  }
  for (const name of wanted) {
    if (values.has(name)) continue;
    const kind = STAGING_SECRET_KINDS[name];
    if (kind === undefined) fail(`STAGING_SECRET_UNKNOWN:${name}`);
    if (kind === "random-48-bytes-base64url") values.set(name, randomToken());
    else if (kind === "inert-random") values.set(name, inertToken());
    else if (kind === "inert-p256-pkcs8-pem") values.set(name, inertAppleKey());
    else fail(`STAGING_SECRET_UNKNOWN:${name}`);
  }
  assertStagingSecretValues(values);
  return values;
}

function parseJwk(raw) {
  let jwk;
  try { jwk = JSON.parse(raw); } catch { return null; }
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk) || jwk.kty !== "RSA"
      || typeof jwk.kid !== "string" || !KID.test(jwk.kid) || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    return null;
  }
  return jwk;
}

/**
 * Checks synthetic values against CR-3's grammar for each secret
 * (postgres-production-configuration.mjs readSecrets) and the staging plane's
 * key-id marker, by code only; no value reaches an error.
 */
export function assertStagingSecretValues(values) {
  for (const [name, value] of values) {
    if (typeof value !== "string" || value.length === 0
        || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) {
      fail(`STAGING_SECRET_VALUE_INVALID:${name}`);
    }
    const kind = STAGING_SECRET_KINDS[name];
    if ((kind === "random-48-bytes-base64url" && !/^[A-Za-z0-9_-]{64}$/u.test(value))
        || (kind === "inert-random" && !value.startsWith(INERT_VALUE_PREFIX))
        || (kind === "inert-p256-pkcs8-pem" && !PKCS8_PEM.test(value))) {
      fail(`STAGING_SECRET_VALUE_INVALID:${name}`);
    }
  }
  if (values.has("ENVELOPE_PUBLIC_JWK") || values.has("ENVELOPE_PRIVATE_JWK")) {
    const publicJwk = parseJwk(values.get("ENVELOPE_PUBLIC_JWK"));
    const privateJwk = parseJwk(values.get("ENVELOPE_PRIVATE_JWK"));
    if (publicJwk === null || publicJwk.d !== undefined) fail("STAGING_SECRET_VALUE_INVALID:ENVELOPE_PUBLIC_JWK");
    if (privateJwk === null || typeof privateJwk.d !== "string") fail("STAGING_SECRET_VALUE_INVALID:ENVELOPE_PRIVATE_JWK");
    if (publicJwk.kid !== privateJwk.kid || publicJwk.n !== privateJwk.n
        || !tokens(publicJwk.kid).includes("staging") || tokens(publicJwk.kid).includes("production")) {
      fail("STAGING_SECRET_VALUE_INVALID:ENVELOPE_KEY_ID");
    }
  }
}

// ---------------------------------------------------------------------------
// gcloud

/** The default runner: argv only, no shell, stdin only for a value, stderr discarded. */
export function defaultStagingSecretsRunner(argv, { input } = {}) {
  const result = spawnSync("gcloud", argv, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    maxBuffer: GCLOUD_MAX_BUFFER_BYTES,
    timeout: GCLOUD_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function commandShape(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith("-") || positional.length >= 3) break;
    positional.push(arg);
  }
  for (const length of [3, 2]) {
    const shape = positional.slice(0, length).join(" ");
    if (Object.hasOwn(STAGING_SECRETS_COMMANDS, shape)) return shape;
  }
  return null;
}

/**
 * The guarded gcloud call: a closed set of shapes, exactly one --project for
 * the plane's project, JSON output and HTTP logging off on every call, stdin
 * only for `versions add --data-file=-`, and never a value in argv. Failures
 * name the command shape only.
 */
export function guardedStagingSecretsGcloud(runner, { project, values = new Map() }) {
  if (typeof runner !== "function") fail("GCLOUD_RUNNER_INVALID");
  return function call(argv, { input } = {}) {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) fail("GCLOUD_COMMAND_FORBIDDEN");
    const shape = commandShape(argv);
    if (shape === null) fail("GCLOUD_COMMAND_FORBIDDEN");
    if (argv.filter((arg) => arg.startsWith("--project=")).length !== 1 || !argv.includes(`--project=${project}`)) {
      fail("GCLOUD_PROJECT_FLAG_INVALID");
    }
    if (!argv.includes("--format=json")) fail("GCLOUD_READ_FORMAT_REQUIRED");
    if (argv.filter((arg) => arg === GCLOUD_NO_LOG_HTTP).length !== 1
        || argv.some((arg) => arg === "--log-http" || arg.startsWith("--log-http="))) {
      fail("GCLOUD_LOG_HTTP_REQUIRED_OFF");
    }
    const adding = shape === "secrets versions add";
    if (adding !== argv.includes("--data-file=-") || adding !== (typeof input === "string")) {
      fail("GCLOUD_STDIN_CONTRACT_BROKEN");
    }
    for (const value of values.values()) {
      if (typeof value === "string" && argv.some((arg) => arg.includes(value))) fail("GCLOUD_ARGV_VALUE_FORBIDDEN");
    }
    let result;
    try {
      result = runner([...argv], adding ? { input } : {});
    } catch {
      fail(`GCLOUD_CALL_FAILED:${shape.replaceAll(" ", "-")}`);
    }
    if (result === null || typeof result !== "object" || result.status !== 0
        || (result.error !== undefined && result.error !== null) || typeof result.stdout !== "string") {
      fail(`GCLOUD_CALL_FAILED:${shape.replaceAll(" ", "-")}`);
    }
    try {
      // gcloud prints nothing for an empty listing.
      return JSON.parse(result.stdout.trim() === "" ? (STAGING_SECRETS_COMMANDS[shape] === "read" ? "[]" : "null")
        : result.stdout);
    } catch {
      return fail(`GCLOUD_OUTPUT_INVALID:${shape.replaceAll(" ", "-")}`);
    }
  };
}

function tail(name) {
  return typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : null;
}

function versionStates(list) {
  if (!Array.isArray(list)) fail("GCLOUD_OUTPUT_INVALID:secrets-versions-list");
  const states = new Map();
  for (const entry of list) {
    const version = tail(entry?.name);
    if (version === null || !VERSION.test(version) || typeof entry.state !== "string") {
      fail("GCLOUD_OUTPUT_INVALID:secrets-versions-list");
    }
    states.set(version, entry.state);
  }
  return states;
}

function addedVersion(output, secretId) {
  const match = VERSION_NAME.exec(output?.name ?? "");
  if (match === null || match[1] !== secretId || (output.state !== undefined && output.state !== "ENABLED")) {
    fail("GCLOUD_OUTPUT_INVALID:secrets-versions-add");
  }
  return match[2];
}

// ---------------------------------------------------------------------------
// Plan, dry run, apply

/** The dry-run document: no call, and a self-test of value generation. */
export function stagingSecretsDryRun(desired) {
  const targets = stagingSecretTargets(desired);
  // Make every value once, check it, and drop it: proof that generation works
  // here, with nothing kept, printed or sent.
  const values = generateStagingSecretValues(targets.map((target) => target.variable));
  const checked = values.size;
  values.clear();
  const argv = secretsArgv(desired);
  return deepFreeze({
    schema: STAGING_SECRETS_REPORT_SCHEMA,
    status: "dry_run",
    environment: desired.environment,
    project: desired.project,
    authorization: stagingSecretsAuthorization(desired),
    generationSelfTest: { valuesGenerated: checked, valuesChecked: checked, valuesKept: values.size },
    reads: [argv.list(), ...targets.map((target) => argv.versions(target.secretId))],
    secrets: targets.map((target) => ({
      variable: target.variable,
      secretId: target.secretId,
      kind: target.kind,
      pinned: target.pinned,
      createIfMissing: argv.create(target.secretId),
      addVersion: argv.add(target.secretId),
      stdin: `<${target.kind}, generated in process at apply>`,
    })),
  });
}

function stagingSecretsError(code, outcomes) {
  return Object.assign(new GcpOpsInfraError(code), { outcomes: deepFreeze(outcomes) });
}

/**
 * Applies the plan: reads, then creates missing containers, then adds one
 * version per secret without an ENABLED version, reissuing the envelope pair
 * as one unit (see the header). Returns the content-free report. A failure
 * after any change carries the outcomes so far.
 */
export function provisionStagingSecrets(desired, { authorize, runner = defaultStagingSecretsRunner } = {}) {
  const targets = stagingSecretTargets(desired);
  if (desired.synthetic) fail("STAGING_SECRETS_SYNTHETIC_TARGET_REFUSED");
  if (authorize !== stagingSecretsAuthorization(desired)) fail("STAGING_SECRETS_AUTHORIZATION_MISMATCH");
  const argv = secretsArgv(desired);
  const read = guardedStagingSecretsGcloud(runner, { project: desired.project });
  const listed = read(argv.list());
  if (!Array.isArray(listed)) fail("GCLOUD_OUTPUT_INVALID:secrets-list");
  const existing = new Set(listed.map((entry) => tail(entry?.name)).filter((name) => name !== null));

  const plan = targets.map((target) => {
    if (!existing.has(target.secretId)) return { ...target, container: "missing", states: new Map() };
    const states = versionStates(read(argv.versions(target.secretId)));
    return { ...target, container: "existing", states };
  });
  for (const entry of plan) {
    const enabled = [...entry.states].filter(([, state]) => state === "ENABLED").map(([version]) => version);
    if (entry.states.size > 0 && enabled.length === 0) fail(`STAGING_SECRET_VERSIONS_UNUSABLE:${entry.variable}`);
    entry.enabledVersion = enabled.length === 0 ? null
      : entry.pinned !== null && enabled.includes(entry.pinned) ? entry.pinned
        : enabled.sort((left, right) => Number(right) - Number(left))[0];
  }
  // The envelope pair is one unit: when either key has no ENABLED version,
  // both get a version of one fresh pair. An earlier public version without
  // a private partner stays, ENABLED and unpinned. A pin is never moved.
  const pair = ENVELOPE_PAIR.map((name) => plan.find((entry) => entry.variable === name));
  let envelopePairReissued = false;
  if (pair.some((entry) => entry.enabledVersion === null)) {
    envelopePairReissued = pair.some((entry) => entry.enabledVersion !== null);
    if (envelopePairReissued && pair.some((entry) => entry.pinned !== null)) fail("STAGING_ENVELOPE_PAIR_PARTIAL");
    for (const entry of pair) entry.enabledVersion = null;
  }
  // The private key is added right after the public key, so it is only ever
  // added once its public partner succeeded in the same run.
  const order = plan.filter((entry) => entry !== pair[1]);
  order.splice(order.indexOf(pair[0]) + 1, 0, pair[1]);
  const pending = order.filter((entry) => entry.enabledVersion === null).map((entry) => entry.variable);

  const values = generateStagingSecretValues(pending);
  const call = guardedStagingSecretsGcloud(runner, { project: desired.project, values });
  const outcomes = [];
  try {
    for (const entry of order) {
      const outcome = { variable: entry.variable, secretId: entry.secretId, kind: entry.kind,
        container: entry.container === "missing" ? "pending" : "existing", outcome: "pending", version: null };
      outcomes.push(outcome);
      if (entry.enabledVersion !== null) {
        Object.assign(outcome, { outcome: "already_provisioned", version: entry.enabledVersion });
        continue;
      }
      if (entry.container === "missing") {
        call(argv.create(entry.secretId));
        outcome.container = "created";
      }
      const output = call(argv.add(entry.secretId), { input: values.get(entry.variable) });
      values.delete(entry.variable);
      Object.assign(outcome, { outcome: "added", version: addedVersion(output, entry.secretId) });
    }
  } catch (error) {
    values.clear();
    const code = error instanceof GcpOpsInfraError ? error.code : "STAGING_SECRETS_FAILED";
    const changed = outcomes.some((outcome) => outcome.container === "created" || outcome.outcome === "added");
    throw changed ? stagingSecretsError(code, outcomes) : new GcpOpsInfraError(code);
  }
  values.clear();
  return deepFreeze({
    schema: STAGING_SECRETS_REPORT_SCHEMA,
    status: "provisioned",
    environment: desired.environment,
    project: desired.project,
    authorization: authorize,
    envelopePairReissued,
    secrets: outcomes,
    pins: Object.fromEntries(outcomes.map((outcome) => [outcome.variable, outcome.version])),
  });
}

/**
 * Reserves the report file before anything changes: created exclusively,
 * owner-only and never through a symlink. Returns { write(report), release() }:
 * write fills and syncs it once; release removes the still-empty reservation
 * when the run ends without a report. A failed write removes this run's file.
 */
export async function reserveStagingSecretsReport(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("STAGING_SECRETS_REPORT_PATH_INVALID");
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    fail("STAGING_SECRETS_REPORT_PATH_UNAVAILABLE");
  }
  let settled = false;
  const discardFile = async () => {
    try { await handle.close(); } catch { /* keep the original outcome */ }
    try { await unlink(path); } catch { /* only this run's own file */ }
  };
  return Object.freeze({
    async write(report) {
      if (settled) fail("STAGING_SECRETS_REPORT_WRITE_FAILED");
      settled = true;
      try {
        await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
      } catch {
        await discardFile();
        fail("STAGING_SECRETS_REPORT_WRITE_FAILED");
      }
    },
    async release() {
      if (settled) return;
      settled = true;
      await discardFile();
    },
  });
}

// ---------------------------------------------------------------------------
// CLI

const FLAGS = Object.freeze(["--environment", "--authorize", "--report-out"]);
const BOOLEANS = Object.freeze(["--apply", "--dry-run", "--write-pins"]);

/** Closed argument parsing. */
export function parseStagingSecretsArgs(argv) {
  if (!Array.isArray(argv)) fail("STAGING_SECRETS_ARGUMENT_INVALID");
  const values = new Map();
  for (const argument of argv) {
    if (typeof argument !== "string") fail("STAGING_SECRETS_ARGUMENT_INVALID");
    if (BOOLEANS.includes(argument)) {
      if (values.has(argument)) fail("STAGING_SECRETS_ARGUMENT_INVALID");
      values.set(argument, true);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? "" : argument.slice(separator + 1);
    if (!FLAGS.includes(name) || value.length === 0 || values.has(name)) fail("STAGING_SECRETS_ARGUMENT_INVALID");
    values.set(name, value);
  }
  if (values.get("--environment") !== STAGING_SECRETS_ENVIRONMENT) fail("STAGING_SECRETS_ENVIRONMENT_REFUSED");
  const apply = values.get("--apply") === true;
  if (apply && values.get("--dry-run") === true) fail("STAGING_SECRETS_ARGUMENT_INVALID");
  if (apply !== values.has("--authorize")) fail("STAGING_SECRETS_AUTHORIZATION_REQUIRED");
  if (!apply && (values.has("--write-pins") || values.has("--report-out"))) fail("STAGING_SECRETS_ARGUMENT_INVALID");
  const reportOut = values.get("--report-out") ?? null;
  if (reportOut !== null && !isAbsolute(reportOut)) fail("STAGING_SECRETS_REPORT_PATH_INVALID");
  return deepFreeze({
    apply,
    authorize: values.get("--authorize") ?? null,
    writePins: values.get("--write-pins") === true,
    reportOut: reportOut === null ? null : resolve(reportOut),
  });
}

/** CLI entry; returns the exit code. */
export async function main(argv = process.argv.slice(2), {
  runner = defaultStagingSecretsRunner,
  loadDesired = () => loadCommittedDesiredState(STAGING_SECRETS_ENVIRONMENT),
  pinStore,
  reserveReport = reserveStagingSecretsReport,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseStagingSecretsArgs(argv);
    const desired = loadDesired();
    if (!config.apply) {
      print(stagingSecretsDryRun(desired));
      return 0;
    }
    // Checked before the report is reserved, so a wrong authorization leaves no file.
    if (config.authorize !== stagingSecretsAuthorization(desired)) fail("STAGING_SECRETS_AUTHORIZATION_MISMATCH");
    // Reserved before the first gcloud call; released on any failure, so the
    // same command can be rerun with the same --report-out.
    const reservation = config.reportOut === null ? null : await reserveReport(config.reportOut);
    try {
      const report = provisionStagingSecrets(desired, { authorize: config.authorize, runner });
      let pinned = null;
      if (config.writePins) {
        try {
          pinned = updateStagingDesiredState((text) => pinStagingSecretVersions(text, report.pins), pinStore);
        } catch (error) {
          throw stagingSecretsError(error instanceof GcpOpsInfraError ? error.code : "STAGING_SECRETS_PIN_FAILED",
            report.secrets);
        }
      }
      if (reservation !== null) {
        try {
          await reservation.write(report);
        } catch (error) {
          throw stagingSecretsError(error instanceof GcpOpsInfraError ? error.code : "STAGING_SECRETS_REPORT_WRITE_FAILED",
            report.secrets);
        }
      }
      print({ ...report, pinned });
      return 0;
    } catch (error) {
      await reservation?.release();
      throw error;
    }
  } catch (error) {
    const code = error instanceof GcpOpsInfraError ? error.code : "STAGING_SECRETS_FAILED";
    stderr(`${JSON.stringify({ status: "error", code, ...(error?.outcomes === undefined ? {} : { outcomes: error.outcomes }) })}\n`);
    return 1;
  }
}

/** Compares real paths, so a symlinked entry still runs main(). */
export function isCliEntry(argvPath, moduleUrl = import.meta.url) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1])) {
  process.exitCode = await main();
}
