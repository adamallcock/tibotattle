/**
 * Offline check of the staging service (STG-PREP): the staging template
 * rendered by the OPS-2 manifest from the committed staging desired state,
 * its stagingOrigin block, the OD-2 bucket proof, the CR-3 staging
 * configuration the render produces, and the refusals that keep the planes
 * apart. Every value here is synthetic or a committed non-secret staging
 * identifier. Nothing calls gcloud: PATH is blanked for this process.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as configuration from "../cloud-run/postgres-production-configuration.mjs";
import * as maintenanceJob from "../cloud-run/postgres-maintenance-job-contract.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as operations from "./gcp-ops-infra-operations.mjs";
import { CLEAN_DEFERRALS } from "./gcp-ops-infra-operations.mjs";
import {
  bornBucket,
  createFakeGcloud,
  emptyWorld,
  INJECTED_SCHEDULER_HEADERS,
  memoryWriter,
  withCloudBuildBucket,
  withSecretValues,
} from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { generateStagingSecretValues, STAGING_SECRET_KINDS } from "./gcp-staging-secrets.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(SCRIPTS_ROOT, "..");
const STAGING_TEMPLATE = readFileSync(join(WORKER_ROOT, manifest.SERVICE_TEMPLATE_FILES.staging), "utf8");
const PRODUCTION_TEMPLATE = readFileSync(join(WORKER_ROOT, manifest.SERVICE_TEMPLATE_FILES.production), "utf8");
const COMMITTED_STAGING = readFileSync(join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json"), "utf8");
const COMMITTED_PRODUCTION = readFileSync(join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json"), "utf8");
const FIXTURE = JSON.parse(readFileSync(join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json"), "utf8"));
const IMAGE = Object.freeze({ imageDigest: "c".repeat(64), sourceCommit: "d".repeat(40) });
const SYNTHETIC_AUD = "5a".repeat(32);
// The AUD tag of the staging admin host's Access application (owner-supplied
// 2026-10-03; Google IdP, allow policy for the owner's email only). Not a secret.
const STAGING_ACCESS_AUD = "b000414465233b6feb03671fa4ec60cfc505d8bc10e435fd77e8fb78656474ad";
const PROOF = Object.freeze({ bucketGeneration: "1700000000000001", bucketMetageneration: "1" });

/** The committed staging file with the values the main session pins, synthetic where not committed. */
function filledStaging(mutate = () => {}) {
  const value = JSON.parse(COMMITTED_STAGING);
  value.stagingOrigin.accessAud = SYNTHETIC_AUD;
  value.bucket.proof = { ...PROOF };
  for (const secret of Object.values(value.secrets)) secret.version = "1";
  mutate(value);
  return value;
}

function desired(mutate) {
  return manifest.validateDesiredState(filledStaging(mutate));
}

function refused(mutate, code) {
  assert.throws(() => manifest.validateDesiredState(filledStaging(mutate)), { code }, code);
}

function envOf(service) {
  return new Map(service.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]));
}

test("the staging template renders from the committed staging desired state, IAM-private and plane-marked", () => {
  const staging = desired();
  const service = manifest.renderService(staging, IMAGE);
  const env = envOf(service);
  assert.equal(service.metadata.name, "tibotattle-staging-origin");
  assert.equal(service.metadata.namespace, "tibotattle");
  assert.equal(service.metadata.annotations["run.googleapis.com/ingress"], "all");
  assert.equal(service.metadata.annotations["run.googleapis.com/invoker-iam-disabled"], "false");
  assert.deepEqual(JSON.parse(service.metadata.annotations["run.googleapis.com/custom-audiences"]),
    ["tibotattle-staging-edge-origin"]);
  // Staging-plane limits: scale to zero, at most the budgeted instance count.
  assert.equal(service.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"], "0");
  assert.equal(service.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"], "4");
  assert.equal(service.spec.template.spec.containerConcurrency, 40);
  assert.equal(service.spec.template.spec.timeoutSeconds, 300);
  assert.equal(service.spec.template.spec.serviceAccountName,
    "tibotattle-staging-runtime@tibotattle.iam.gserviceaccount.com");
  assert.equal(service.spec.template.spec.containers[0].image,
    `us-east1-docker.pkg.dev/tibotattle/tibotattle-staging-images/tibotattle-host@sha256:${"c".repeat(64)}`);
  assert.deepEqual([...env.keys()], [...manifest.STAGING_SERVICE_ENV_NAMES]);
  const plain = (name) => env.get(name).value;
  assert.equal(plain("HOST_MODE"), "staging");
  assert.equal(plain("HOST_ORIGIN"), "https://tibotattle-staging-origin-806510610397.us-east1.run.app");
  assert.equal(plain("PUBLIC_ORIGIN"), "https://staging.tibotattle.com");
  assert.equal(plain("ADMIN_HOST_ORIGIN"), "https://admin.staging.tibotattle.com");
  assert.equal(plain("STAGING_ADMISSION_MODE"), "closed");
  assert.equal(plain("ACCESS_AUD"), SYNTHETIC_AUD);
  assert.equal(plain("IDENTITY_LINK_SECRET_VERSION"), "staging-gcp-v1");
  assert.equal(plain("TELEMETRY_STORAGE_NAMESPACE"), "tibotattle-staging-synthetic");
  assert.equal(plain("EDGE_INVOKER_SERVICE_ACCOUNT"), "tibotattle-staging-invoker@tibotattle.iam.gserviceaccount.com");
  assert.equal(plain("EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS"), "tibotattle-staging-verifier@tibotattle.iam.gserviceaccount.com");
  assert.equal(plain("PRIMARY_INSTANCE_CONNECTION_NAME"), "tibotattle:us-east1:tibotattle-staging-primary");
  assert.equal(plain("POSTGRES_IAM_USER"), "tibotattle-staging-runtime@tibotattle.iam");
  assert.equal(plain("GCS_BUCKET_NAME"), "tibotattle-staging-quarantine");
  for (const [name, value] of Object.entries(manifest.STAGING_INERT_IDENTITY_PROVIDER_VARS)) assert.equal(plain(name), value, name);
  // Each secret is its staging Secret Manager id at its pinned version.
  for (const name of [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES]) {
    assert.deepEqual(env.get(name).valueFrom.secretKeyRef, { name: staging.secrets[name].secretName, key: "1" }, name);
    assert.match(env.get(name).valueFrom.secretKeyRef.name, /^tibotattle-staging-/u, name);
  }
  // No production value, no ledger and no retired proof anywhere.
  const text = JSON.stringify(service);
  for (const [, value] of Object.entries(configuration.PRODUCTION_RESOURCE_FINGERPRINT)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      assert.equal([...env.values()].some((entry) => entry.value === item), false, item);
    }
  }
  assert.doesNotMatch(text, /LEDGER|GCS_ERASURE_BUCKET_HISTORY_PROOF|EDGE_PROOF_|SPARKLE_|allUsers|tibotattle-test|production/u);
  // The optional token is omitted when its version is null, as in EP-7.
  const withoutToken = manifest.renderService(desired((value) => { value.secrets.DISTRIBUTION_GITHUB_API_TOKEN.version = null; }), IMAGE);
  assert.equal(envOf(withoutToken).has("DISTRIBUTION_GITHUB_API_TOKEN"), false);
});

test("OD-2: the rendered quarantine proof is the pinned birth proof of the rendered bucket, as the store reads it", () => {
  const env = envOf(manifest.renderService(desired(), IMAGE));
  const proof = JSON.parse(env.get(manifest.QUARANTINE_BUCKET_HISTORY_PROOF_ENV).value);
  assert.deepEqual(proof, { bucket: "tibotattle-staging-quarantine", ...PROOF, softDeleteRetentionDurationSeconds: "0" });
  // The GCS store's proof primitive (src/gcs-erasure-object-store.ts
  // createGcsErasureBucketHistoryProof) takes exactly these fields.
  const store = readFileSync(join(WORKER_ROOT, "src/gcs-erasure-object-store.ts"), "utf8");
  for (const field of ["bucket", "bucketGeneration", "bucketMetageneration", "softDeleteRetentionDurationSeconds"]) {
    assert.match(store, new RegExp(`readonly ${field}: string;`, "u"), field);
  }
  // C-SIMP's CR-3 validator shape: closed sorted keys, decimal generations, soft delete "0".
  assert.equal(Object.keys(proof).sort().join(","), "bucket,bucketGeneration,bucketMetageneration,softDeleteRetentionDurationSeconds");
  assert.ok(new TextEncoder().encode(env.get(manifest.QUARANTINE_BUCKET_HISTORY_PROOF_ENV).value).byteLength <= 1024);
});

test("the rendered staging env, with provisioner-made secrets, is a staging configuration CR-3 accepts", () => {
  const staging = desired();
  const env = { K_SERVICE: staging.service.name };
  for (const entry of manifest.renderService(staging, IMAGE).spec.template.spec.containers[0].env) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
  }
  // The values gcp-staging-secrets.mjs would add, made in process and never printed.
  const secrets = generateStagingSecretValues(Object.keys(STAGING_SECRET_KINDS));
  for (const [name, value] of secrets) env[name] = value;
  const config = configuration.readProductionConfiguration(env, "staging");
  secrets.clear();
  assert.equal(config.plane, "staging");
  assert.equal(config.environment, "staging");
  assert.equal(config.stagingAdmissionMode, "closed");
  assert.deepEqual(config.rateLimits.originTier, configuration.STAGING_ORIGIN_TIER_RATE_LIMITS);
  assert.equal(config.vars.ENROLLMENT_MODE, "disabled");
  assert.equal(config.vars.ACCOUNTLESS_ENROLLMENT_MODE, "disabled");
  assert.equal(config.vars.PUBLIC_ORIGIN, "https://staging.tibotattle.com");
  assert.equal(Object.hasOwn(config.vars, "INCREMENTAL_EXTERNAL_PARTICIPANTS"), false);
  assert.deepEqual(config.origins, { public: "https://staging.tibotattle.com", admin: "https://admin.staging.tibotattle.com",
    wwwHost: null, host: "https://tibotattle-staging-origin-806510610397.us-east1.run.app" });
  assert.deepEqual(config.resources, {
    primary: { instanceConnectionName: "tibotattle:us-east1:tibotattle-staging-primary", database: "tibotattle_staging",
      schema: "tibotattle_staging" },
    iamUser: "tibotattle-staging-runtime@tibotattle.iam",
    bucket: "tibotattle-staging-quarantine",
    // OD-2 (C-SIMP): CR-3 parses the rendered birth proof into its resources.
    bucketHistoryProof: { bucket: "tibotattle-staging-quarantine", ...PROOF, softDeleteRetentionDurationSeconds: "0" },
  });
  assert.equal(config.edge.invokerServiceAccount, staging.serviceAccounts.edgeInvoker.email);
  // The synthetic-rehearsal admission mode opens accountless admission only.
  env.STAGING_ADMISSION_MODE = "synthetic-rehearsal";
  const rehearsal = configuration.readProductionConfiguration(env, "staging");
  assert.equal(rehearsal.vars.ACCOUNTLESS_ENROLLMENT_MODE, "enabled");
  assert.equal(rehearsal.vars.ENROLLMENT_MODE, "disabled");
  // The same env is no production configuration.
  assert.throws(() => configuration.readProductionConfiguration(env, "production"), (error) => typeof error.code === "string");
});

/** A rendered job's container, and its plain env as a name-to-value map. */
function jobContainer(job) {
  return job.spec.template.spec.template.spec.containers[0];
}

test("STAGING-MAINT-RENDER: the staging maintenance job reads stagingOrigin as the service does, and CR-3's staging-maintenance-job profile accepts it", () => {
  const staging = desired();
  const job = manifest.renderJob(staging, "maintenance", IMAGE);
  const container = jobContainer(job);
  assert.equal(job.metadata.name, "tibotattle-staging-maintenance");
  assert.equal(job.spec.template.spec.template.spec.serviceAccountName,
    "tibotattle-staging-runtime@tibotattle.iam.gserviceaccount.com");
  assert.deepEqual(container.args, ["dist/postgres-maintenance-job.mjs", "--profile=staging-maintenance-job"]);
  const contract = manifest.MAINTENANCE_JOB_CONTRACT;
  assert.equal(contract.stagingProfile, maintenanceJob.POSTGRES_MAINTENANCE_JOB_PROFILES[1]);
  // The plane's own values are CR-3's staging-provided names plus the derived admin origin.
  assert.deepEqual([...contract.stagingPlaneEnv].sort(),
    [...configuration.STAGING_PROVIDED_VAR_NAMES, "ADMIN_HOST_ORIGIN"].sort());
  // Only the staging profile's secret: the plane's GitHub token container is
  // pinned, but the staging profile refuses it, so the job never names it.
  assert.deepEqual([...contract.stagingSecrets], [
    ...configuration.PRODUCTION_PROFILE_SECRET_NAMES["staging-maintenance-job"].required,
    ...configuration.PRODUCTION_PROFILE_SECRET_NAMES["staging-maintenance-job"].optional]);
  assert.equal(staging.secrets.DISTRIBUTION_GITHUB_API_TOKEN.version, "1");
  const references = container.env.filter((entry) => entry.valueFrom !== undefined);
  assert.deepEqual(references.map((entry) => [entry.name, entry.valueFrom.secretKeyRef]),
    [["IDENTITY_LINK_SECRET", { name: "tibotattle-staging-identity-link-secret", key: "1" }]]);
  const plain = Object.fromEntries(container.env.filter((entry) => entry.valueFrom === undefined)
    .map((entry) => [entry.name, entry.value]));
  assert.deepEqual(Object.keys(plain), [...contract.configurationEnv, ...contract.stagingPlaneEnv, ...contract.provenanceEnv]);
  // Every value the job shares with the service is the service's, byte for byte.
  const service = envOf(manifest.renderService(staging, IMAGE));
  for (const [name, value] of Object.entries(plain)) {
    if (name === "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED") continue;
    assert.equal(value, service.get(name).value, name);
  }
  assert.equal(plain.ACCESS_AUD, SYNTHETIC_AUD);
  assert.equal(plain.ADMIN_HOST_ORIGIN, "https://admin.staging.tibotattle.com");
  // The service-only settings never reach the job: CR-3 refuses STAGING_ADMISSION_MODE outside the service profile.
  for (const name of ["HOST_MODE", "HOST_ORIGIN", "STAGING_ADMISSION_MODE", "EDGE_ORIGIN_MODE", "K_SERVICE"]) {
    assert.equal(Object.hasOwn(plain, name), false, name);
  }
  assert.doesNotMatch(JSON.stringify(job), /LEDGER|GCS_ERASURE_BUCKET_HISTORY_PROOF|EDGE_PROOF_|SPARKLE_|production/u);

  // The job's own refusals (postgres-maintenance-job-contract.mjs) find nothing in the render.
  for (const name of Object.keys(maintenanceJob.POSTGRES_MAINTENANCE_JOB_FORBIDDEN_VARIABLES)) {
    assert.equal(Object.hasOwn(plain, name), false, name);
  }
  for (const prefix of Object.keys(maintenanceJob.POSTGRES_MAINTENANCE_JOB_FORBIDDEN_PREFIXES)) {
    assert.equal(Object.keys(plain).some((name) => name.startsWith(prefix)), false, prefix);
  }
  // CR-3's staging-maintenance-job profile (the configuration the job's reader
  // reads) accepts the render as the job reads its environment; the
  // production maintenance profile refuses it.
  const env = { ...plain, CLOUD_RUN_JOB: job.metadata.name };
  const secrets = generateStagingSecretValues(["IDENTITY_LINK_SECRET"]);
  for (const [name, value] of secrets) env[name] = value;
  const config = configuration.readProductionConfiguration(env, "staging-maintenance-job");
  assert.throws(() => configuration.readProductionConfiguration(env, "maintenance-job"),
    (error) => typeof error.code === "string");
  secrets.clear();
  assert.equal(config.profile, "staging-maintenance-job");
  assert.equal(config.plane, "staging");
  assert.equal(config.deployment.workload.kind, "job");
  assert.equal(config.deployment.workload.name, "tibotattle-staging-maintenance");
  assert.equal(config.jobSwitches.POSTGRES_SCHEDULED_MAINTENANCE_ENABLED, "enabled");
  assert.equal(config.vars.ACCESS_AUD, SYNTHETIC_AUD);
  assert.equal(config.vars.ENROLLMENT_MODE, "disabled");
  assert.deepEqual(config.origins, { public: "https://staging.tibotattle.com", admin: "https://admin.staging.tibotattle.com",
    wwwHost: null, host: null });
  assert.equal(config.resources.bucket, "tibotattle-staging-quarantine");
  assert.deepEqual(config.resources.bucketHistoryProof,
    { bucket: "tibotattle-staging-quarantine", ...PROOF, softDeleteRetentionDurationSeconds: "0" });
  assert.deepEqual(Object.keys(config.secrets), ["IDENTITY_LINK_SECRET"]);

  // It waits with the service's own codes, and only for them.
  for (const [mutate, code] of [
    [(value) => { value.stagingOrigin = null; }, "STAGING_ORIGIN_UNASSIGNED"],
    [(value) => { value.stagingOrigin.accessAud = null; }, "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud"],
  ]) {
    assert.equal(manifest.jobRenderBlocker(desired(mutate), "maintenance"), code, code);
    assert.equal(manifest.serviceRenderBlocker(desired(mutate)), code, code);
    assert.throws(() => manifest.renderJob(desired(mutate), "maintenance", IMAGE), { code }, code);
    // The other jobs read no plane value and still render.
    assert.equal(manifest.renderJob(desired(mutate), "production-migrate", IMAGE).kind, "Job");
  }
  assert.throws(() => manifest.renderJob(desired((value) => { value.bucket.proof = null; }), "maintenance", IMAGE),
    { code: "JOB_RENDER_BUCKET_PROOF_UNPINNED" });
  assert.equal(manifest.jobRenderBlocker(staging, "maintenance"), null);
  assert.deepEqual([...manifest.deployedJobNames(staging)], ["production-migrate", "analytics-refresh", "maintenance"]);
  // The committed staging file renders it as it stands.
  const committed = manifest.loadCommittedDesiredState("staging");
  const committedEnv = Object.fromEntries(jobContainer(manifest.renderJob(committed, "maintenance", IMAGE)).env
    .filter((entry) => entry.valueFrom === undefined).map((entry) => [entry.name, entry.value]));
  assert.equal(committedEnv.ACCESS_AUD, STAGING_ACCESS_AUD);
  assert.equal(manifest.rolloutTargetFromDesiredState(committed).maintenanceJob, "tibotattle-staging-maintenance");
});

test("D-CRB composes HOST_MODE staging, so OPS-2 no longer defers the staging service for its composition", () => {
  const staging = desired();
  assert.equal(manifest.serviceTemplateBlocker(staging), null);
  assert.equal(manifest.serviceRenderBlocker(staging), null);
  assert.deepEqual({ ...manifest.SERVICE_COMPOSITION_PENDING }, {});
  assert.equal(CLEAN_DEFERRALS.includes("STAGING_HOST_COMPOSITION_PENDING"), false);
  // The server reads HOST_MODE and composes the staging plane (D-CRB); this
  // assertion replaced STG-PREP's "reads no HOST_MODE" guard when the two met.
  const server = readFileSync(join(WORKER_ROOT, "cloud-run/server.mjs"), "utf8");
  assert.match(server, /\bHOST_MODE\b/u);
  assert.match(server, /\bPRODUCTION_HOST_MODES\b/u);
  const host = readFileSync(join(WORKER_ROOT, "cloud-run/postgres-production-host.mjs"), "utf8");
  assert.match(host, /export const PRODUCTION_HOST_MODES = Object\.freeze\(\{\s*production: "production",\s*staging: "staging",\s*\}\);/u);
  // Production has no composition gate either.
  assert.equal(Object.hasOwn(manifest.SERVICE_COMPOSITION_PENDING, "production"), false);
});

test("the staging service waits, in order, for its settings, the Access AUD, the bucket proof and the secret versions", () => {
  assert.equal(manifest.serviceTemplateBlocker(desired((value) => { value.stagingOrigin = null; })), "STAGING_ORIGIN_UNASSIGNED");
  assert.equal(manifest.serviceTemplateBlocker(desired((value) => { value.stagingOrigin.accessAud = null; })),
    "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud");
  assert.equal(manifest.serviceTemplateBlocker(desired((value) => { value.bucket.proof = null; })),
    "SERVICE_RENDER_BUCKET_PROOF_UNPINNED");
  assert.equal(manifest.serviceTemplateBlocker(desired((value) => { value.service.telemetryStorageNamespace = null; })),
    "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED");
  for (const [mutate, code] of [
    [(value) => { value.bucket.proof = null; }, "SERVICE_RENDER_BUCKET_PROOF_UNPINNED"],
    [(value) => { value.stagingOrigin.accessAud = null; }, "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud"],
    [(value) => { value.secrets.ENVELOPE_PRIVATE_JWK.version = null; }, "SECRET_VERSION_UNPINNED:ENVELOPE_PRIVATE_JWK"],
  ]) {
    assert.throws(() => manifest.renderService(desired(mutate), IMAGE), { code }, code);
  }
  // The committed file carries the owner's Access AUD, so it waits for nothing.
  const committed = manifest.loadCommittedDesiredState("staging");
  assert.equal(manifest.serviceRenderBlocker(committed), null);
  assert.equal(manifest.stagingServiceTemplateValues(committed).ACCESS_AUD, STAGING_ACCESS_AUD);
});

test("stagingOrigin is closed, staging-only and never a production value", () => {
  const committed = JSON.parse(COMMITTED_STAGING);
  assert.deepEqual(committed.stagingOrigin, {
    publicOrigin: "https://staging.tibotattle.com",
    accessTeamDomain: "tibotattle.cloudflareaccess.com",
    accessAud: STAGING_ACCESS_AUD,
    accessAdminEmail: configuration.PRODUCTION_VARS.ACCESS_ADMIN_EMAIL,
    identityLinkSecretVersion: "staging-gcp-v1",
    admissionMode: "closed",
  });
  assert.equal(JSON.parse(COMMITTED_PRODUCTION).stagingOrigin, null);
  assert.deepEqual([...manifest.DESIRED_STATE_SHAPE.stagingOrigin], ["publicOrigin", "accessTeamDomain", "accessAud",
    "accessAdminEmail", "identityLinkSecretVersion", "admissionMode"]);
  // Production carries null, always.
  const production = JSON.parse(JSON.stringify(FIXTURE).replaceAll("synthetic-ops-project", "example-ops-prod1"));
  production.stagingOrigin = structuredClone(filledStaging().stagingOrigin);
  assert.throws(() => manifest.validateDesiredState(production), { code: "STAGING_ORIGIN_FORBIDDEN:production" });
  delete production.stagingOrigin;
  assert.throws(() => manifest.validateDesiredState(production), { code: "DESIRED_STATE_KEY_MISSING:desiredState.stagingOrigin" });
  const origin = (field, entry) => (value) => { value.stagingOrigin[field] = entry; };
  const cases = [
    [origin("publicOrigin", configuration.PRODUCTION_PUBLIC_ORIGIN), "STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://www.tibotattle.com"), "STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://staging-production.example.com"), "STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://example.com"), "DESIRED_STATE_STAGING_MARKER_MISSING:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "http://staging.tibotattle.com"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://staging.tibotattle.com/"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://staging.tibotattle.com:8443"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://admin.staging.tibotattle.com"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin"],
    [origin("publicOrigin", "https://tibotattle-staging-origin-806510610397.us-east1.run.app"),
      "DESIRED_STATE_VALUE_INVALID:stagingOrigin.publicOrigin"],
    [origin("accessAud", configuration.PRODUCTION_VARS.ACCESS_AUD), "STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.accessAud"],
    [origin("accessAud", "5A".repeat(32)), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.accessAud"],
    [origin("accessAud", "5a".repeat(31)), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.accessAud"],
    [origin("accessTeamDomain", "tibotattle.example.com"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.accessTeamDomain"],
    [origin("accessAdminEmail", "owner"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.accessAdminEmail"],
    [origin("accessAdminEmail", "o'wner@example.com"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.accessAdminEmail"],
    [origin("identityLinkSecretVersion", configuration.PRODUCTION_VARS.IDENTITY_LINK_SECRET_VERSION),
      "STAGING_ORIGIN_PRODUCTION_VALUE_FORBIDDEN:stagingOrigin.identityLinkSecretVersion"],
    [origin("identityLinkSecretVersion", "gcp-v1"), "DESIRED_STATE_STAGING_MARKER_MISSING:stagingOrigin.identityLinkSecretVersion"],
    [origin("admissionMode", "open"), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.admissionMode"],
    [origin("admissionMode", null), "DESIRED_STATE_VALUE_INVALID:stagingOrigin.admissionMode"],
    [(value) => { value.stagingOrigin.adminOrigin = "https://admin.staging.tibotattle.com"; },
      "DESIRED_STATE_KEY_UNKNOWN:stagingOrigin.adminOrigin"],
    [(value) => { delete value.stagingOrigin.accessAud; }, "DESIRED_STATE_KEY_MISSING:stagingOrigin.accessAud"],
    [(value) => { value.stagingOrigin = "https://staging.tibotattle.com"; }, "DESIRED_STATE_SHAPE_INVALID:stagingOrigin"],
  ];
  for (const [mutate, code] of cases) refused(mutate, code);
  assert.equal(desired((value) => { value.stagingOrigin.admissionMode = "synthetic-rehearsal"; }).stagingOrigin.admissionMode,
    "synthetic-rehearsal");
});

test("a doctored staging template is refused by the renderer", () => {
  const values = manifest.serviceTemplateValues(desired(), IMAGE);
  const render = (templateText) => manifest.renderServiceTemplateValues(values, { templateText, environment: "staging" });
  assert.equal(render(STAGING_TEMPLATE).kind, "Service");
  const doctor = (from, to) => {
    assert.equal(STAGING_TEMPLATE.split(from).length, 2, from);
    return STAGING_TEMPLATE.replace(from, to);
  };
  const before = (name, inserted) => doctor(`            - name: ${name}\n`, `${inserted}            - name: ${name}\n`);
  for (const templateText of [
    doctor("run.googleapis.com/ingress: all", "run.googleapis.com/ingress: internal"),
    doctor("run.googleapis.com/invoker-iam-disabled: 'false'", "run.googleapis.com/invoker-iam-disabled: 'true'"),
    doctor("              value: staging\n", "              value: production\n"),
    doctor("autoscaling.knative.dev/minScale: '0'", "autoscaling.knative.dev/minScale: '1'"),
    doctor("value: '000000000000-tibotattlestaginginert.apps.googleusercontent.com'",
      `value: '${configuration.PRODUCTION_VARS.GOOGLE_OIDC_CLIENT_ID}'`),
    // Round 12: a pre-round-12 Apple setting or sign-in secret reference is refused.
    before("HOST_MODE", "            - name: APPLE_KEY_ID\n              value: 'STAGINGK01'\n"),
    before("IDENTITY_LINK_SECRET", "            - name: GOOGLE_OIDC_CLIENT_SECRET\n              valueFrom:\n"
      + "                secretKeyRef:\n                  name: GOOGLE_OIDC_CLIENT_SECRET\n                  key: '1'\n"),
    doctor("\"bucket\":\"${GCS_BUCKET_NAME}\"", "\"bucket\":\"tibotattle-staging-other\""),
    doctor("\"softDeleteRetentionDurationSeconds\":\"0\"", "\"softDeleteRetentionDurationSeconds\":\"604800\""),
    doctor("            - name: GCS_QUARANTINE_BUCKET_HISTORY_PROOF\n", "            - name: GCS_QUARANTINE_PROOF_OTHER\n"),
    before("HOST_MODE", "            - name: LEDGER_SCHEMA\n              value: 'x'\n"),
    before("HOST_MODE", "            - name: GCS_ERASURE_BUCKET_HISTORY_PROOF\n              value: 'x'\n"),
    before("HOST_MODE", "            - name: EDGE_INVOKER_KEY_JSON\n              value: 'x'\n"),
    before("HOST_MODE", "            - name: POSTGRES_TEST_HTTP_MODE\n              value: 'x'\n"),
    before("HOST_MODE", "            - name: HOST_MODE\n              value: staging\n"),
    doctor("                  name: IDENTITY_LINK_SECRET\n", "                  name: OTHER_SECRET\n"),
  ]) {
    assert.throws(() => render(templateText), { code: "SERVICE_RENDER_INVARIANT_BROKEN" });
  }
  assert.throws(() => render("apiVersion: [unsupported]\n"), { code: "SERVICE_TEMPLATE_UNSUPPORTED" });
  // Values that would carry a production or malformed setting into the reviewed template.
  const production = configuration.PRODUCTION_VARS;
  for (const doctored of [
    { PUBLIC_ORIGIN: production.PUBLIC_ORIGIN, ADMIN_HOST_ORIGIN: configuration.PRODUCTION_ADMIN_ORIGIN },
    { PUBLIC_ORIGIN: "https://example.com", ADMIN_HOST_ORIGIN: "https://admin.example.com" },
    { ADMIN_HOST_ORIGIN: "https://admin.other-staging.example.com" },
    { ACCESS_AUD: production.ACCESS_AUD },
    { ACCESS_AUD: "not-an-aud" },
    { IDENTITY_LINK_SECRET_VERSION: production.IDENTITY_LINK_SECRET_VERSION },
    { STAGING_ADMISSION_MODE: "open" },
    { GCS_BUCKET_GENERATION: "0" },
    { GCS_BUCKET_METAGENERATION: "x" },
    { MAX_INSTANCES: "0" },
  ]) {
    assert.throws(() => manifest.renderServiceTemplateValues({ ...values, ...doctored }, { environment: "staging" }),
      { code: "SERVICE_RENDER_INVARIANT_BROKEN" }, JSON.stringify(Object.keys(doctored)));
  }
});

test("each plane renders only from its own template", () => {
  const staging = desired();
  const stagingValues = manifest.serviceTemplateValues(staging, IMAGE);
  // Staging values on EP-7's template: its staging settings have no placeholder there.
  assert.throws(() => manifest.renderServiceTemplateValues(stagingValues, { templateText: PRODUCTION_TEMPLATE }),
    (error) => /^SERVICE_RENDER_UNUSED:/u.test(error.code));
  // EP-7's values on the staging template: the staging placeholders are unresolved.
  const production = manifest.validateDesiredState(JSON.parse(JSON.stringify(FIXTURE).replaceAll("synthetic-ops-project", "example-ops-prod1")));
  const productionValues = manifest.serviceTemplateValues(production, IMAGE);
  assert.throws(() => manifest.renderServiceTemplateValues(productionValues, { templateText: STAGING_TEMPLATE, environment: "staging" }),
    (error) => /^SERVICE_RENDER_UNRESOLVED:/u.test(error.code));
  // The staging template under the production plane, or EP-7's under staging, breaks the plane invariant.
  assert.throws(() => manifest.renderServiceTemplateValues(stagingValues, { templateText: STAGING_TEMPLATE, environment: "production" }),
    { code: "SERVICE_RENDER_INVARIANT_BROKEN" });
  const productionAsStaging = PRODUCTION_TEMPLATE.replace("              value: production\n", "              value: staging\n");
  assert.notEqual(productionAsStaging, PRODUCTION_TEMPLATE);
  assert.throws(() => manifest.renderServiceTemplateValues(productionValues, { templateText: productionAsStaging }),
    { code: "SERVICE_RENDER_INVARIANT_BROKEN" });
  // EP-7's production render is unchanged by the staging section.
  assert.equal(envOf(manifest.renderService(production, IMAGE)).get("HOST_MODE").value, "production");
  assert.deepEqual({ ...manifest.SERVICE_TEMPLATE_FILES }, {
    production: "cloud-run/production-service.template.yaml",
    staging: "cloud-run/staging-service.template.yaml",
  });
  assert.throws(() => manifest.stagingServiceTemplateValues(production), { code: "STAGING_ORIGIN_FORBIDDEN:production" });
});

test("the staging template text is printable ASCII, names no production value and keeps EP-7's subset", () => {
  assert.doesNotMatch(STAGING_TEMPLATE, /[^\n -~]/u);
  for (const [, value] of Object.entries(configuration.PRODUCTION_RESOURCE_FINGERPRINT)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      assert.equal(STAGING_TEMPLATE.includes(item), false, item);
    }
  }
  assert.doesNotMatch(STAGING_TEMPLATE,
    /tibotattle\.com|[A-Za-z0-9._%+-]+@[a-z0-9-]+\.[a-z]|run\.app'|LEDGER_|ERASURE|tibotattle-staging-|806510610397/u);
  const parsed = manifest.parseTemplateYaml(STAGING_TEMPLATE);
  assert.equal(parsed.kind, "Service");
  const placeholders = new Set([...STAGING_TEMPLATE.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu)].map((match) => match[1]));
  assert.deepEqual([...placeholders].sort(), Object.keys(manifest.serviceTemplateValues(desired(), IMAGE)).sort());
});

test("the committed JSON Schema closes stagingOrigin to the validator's keys and admits null", () => {
  const schema = JSON.parse(readFileSync(join(WORKER_ROOT, manifest.DESIRED_STATE_JSON_SCHEMA_FILE), "utf8"));
  assert.equal(schema.required.at(-1), "stagingOrigin");
  const node = schema.properties.stagingOrigin;
  assert.deepEqual(node.oneOf[0], { type: "null" });
  const object = node.oneOf[1];
  assert.equal(object.additionalProperties, false);
  assert.deepEqual(Object.keys(object.properties), [...manifest.DESIRED_STATE_SHAPE.stagingOrigin]);
  assert.deepEqual(object.required, [...manifest.DESIRED_STATE_SHAPE.stagingOrigin]);
  assert.deepEqual(object.properties.admissionMode.enum, Object.keys(configuration.STAGING_ADMISSION_MODES));
  assert.deepEqual(object.properties.accessAud.type, ["string", "null"]);
});

/** The staging rehearsal's world: born bucket, secrets, a co-tenant and the shared default Cloud Build bucket. */
function stagingRehearsal() {
  const staging = desired();
  const world = emptyWorld();
  withSecretValues(world, { project: staging.project, region: staging.region,
    names: Object.values(staging.secrets).map((secret) => secret.secretName) });
  world.buckets.push(bornBucket({ name: staging.bucket.name, location: staging.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: staging.projectNumber } }));
  world.services.push({ metadata: { name: "tibotattle-test-app" }, spec: { template: { spec: { containers: [{}] } } } });
  withCloudBuildBucket(world, { project: staging.project, projectNumber: staging.projectNumber });
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: staging.project, region: staging.region,
    projectNumber: staging.projectNumber });
  const plan = (options = {}) => operations.planInfrastructure(staging,
    operations.readbackInfrastructure(staging, { runner: gcloud.runner }), options);
  const apply = (result, options = {}) => operations.applyInfrastructure(staging, { runner: gcloud.runner,
    authorize: result.planDigest, createSpecWriter: () => writer.create(), ...options });
  return { staging, world, gcloud, plan, apply };
}

const STAGING_SOURCE_READER = "build-source-bucket-iam:bind:roles/storage.objectViewer|"
  + "serviceAccount:tibotattle-staging-builder@tibotattle.iam.gserviceaccount.com|";

test("the live staging path (in memory): pass 1 applied before BUILD-SOURCE, then a bind-only pass, then pass 2", () => {
  const { world, gcloud, plan, apply } = stagingRehearsal();
  // Live staging applied pass 1 before this change: the plane exists, and the builder has no
  // read on tibotattle_cloudbuild (the bind is stripped to model that earlier checkout's result).
  apply(plan());
  const policy = world.bucketPolicies.tibotattle_cloudbuild;
  policy.bindings = policy.bindings.filter((binding) => binding.role !== "roles/storage.objectViewer");
  // The next plan holds exactly one executable operation, the bind, and nothing refused or found.
  const bindOnly = plan();
  assert.deepEqual([bindOnly.summary.refused, bindOnly.findings, bindOnly.blockers], [0, [], []]);
  assert.deepEqual(bindOnly.operations.filter((entry) => entry.deferred === undefined)
    .map((entry) => [entry.id, entry.argv]), [[STAGING_SOURCE_READER,
    ["storage", "buckets", "add-iam-policy-binding", "gs://tibotattle_cloudbuild", "--project=tibotattle",
      "--member=serviceAccount:tibotattle-staging-builder@tibotattle.iam.gserviceaccount.com",
      "--role=roles/storage.objectViewer"]]]);
  gcloud.calls.length = 0;
  const receipt = apply(bindOnly);
  assert.deepEqual(gcloud.calls.filter((argv) => operations.classifyGcloudCommand(argv) === "mutate"),
    [bindOnly.operations.find((entry) => entry.id === STAGING_SOURCE_READER).argv]);
  assert.equal(receipt.remaining.executable, 0);
  assert.deepEqual(policy.bindings.filter((binding) => binding.role === "roles/storage.objectViewer"),
    [{ role: "roles/storage.objectViewer",
      members: ["serviceAccount:tibotattle-staging-builder@tibotattle.iam.gserviceaccount.com"] }]);
  // Pass 2 (the bootstrap image) then holds no build-source operation and converges.
  const second = plan({ bootstrap: IMAGE });
  assert.equal(second.operations.some((entry) => entry.id.startsWith("build-source-bucket")), false);
  assert.equal(second.summary.executable, 7);
  apply(second, { bootstrap: IMAGE });
  assert.deepEqual(operations.infrastructureCleanliness(plan()), { clean: true, reasons: [] });
});

test("the staging apply rehearsal (in memory): pass 1 builds the plane, pass 2 the service and the jobs", () => {
  // The world holds a co-tenant of the shared test project (never read into the plan or
  // touched) and, for BUILD-SOURCE, the shared project's default Cloud Build bucket (the
  // test estate's builds made it), with no grant for the staging builder.
  const { world, gcloud, plan, apply } = stagingRehearsal();
  const deferred = (result) => result.operations.filter((entry) => entry.deferred !== undefined)
    .map((entry) => `${entry.id}:${entry.deferred}`);
  const first = plan();
  assert.deepEqual([first.summary.refused, first.findings, first.blockers], [0, [], []]);
  // 24 plane operations (round 12 retired the two sign-in secrets, and with
  // them their two accessor bindings), the verifier token-creator grant (operator
  // named 2026-10-02), and the maintenance trigger's create and pause: the
  // staging maintenance job waits only for the bootstrap image now
  // (STAGING-MAINT-RENDER), so its trigger is made and paused as production's
  // is, its grant withheld. BUILD-SOURCE adds the staging builder's bucket-level
  // read on tibotattle_cloudbuild, the bucket its bootstrap-image build stages into.
  assert.equal(first.summary.executable, 28);
  assert.deepEqual(first.operations.filter((entry) => entry.id.startsWith("build-source-bucket"))
    .map((entry) => [entry.id, entry.argv, entry.deferred]), [[
    STAGING_SOURCE_READER,
    ["storage", "buckets", "add-iam-policy-binding", "gs://tibotattle_cloudbuild", "--project=tibotattle",
      "--member=serviceAccount:tibotattle-staging-builder@tibotattle.iam.gserviceaccount.com",
      "--role=roles/storage.objectViewer"], undefined]]);
  assert.ok(deferred(first).includes("run-job:create:maintenance:BOOTSTRAP_IMAGE_REQUIRED"));
  assert.deepEqual(first.operations.filter((entry) => entry.deferred === undefined && entry.id.startsWith("scheduler:"))
    .map((entry) => entry.id), ["scheduler:create:maintenance", "scheduler:pause:maintenance"]);
  // D-CRB composes HOST_MODE staging, so the service waits only for the bootstrap image.
  assert.ok(deferred(first).includes("run-service:create:BOOTSTRAP_IMAGE_REQUIRED"));
  assert.ok(deferred(first).includes("run-job:create:production-migrate:BOOTSTRAP_IMAGE_REQUIRED"));
  apply(first);
  // After pass 1 the staging builder can read its build sources, and nothing else changed on that bucket.
  assert.deepEqual(world.bucketPolicies.tibotattle_cloudbuild.bindings.filter((binding) =>
    binding.role === "roles/storage.objectViewer"), [{ role: "roles/storage.objectViewer",
    members: ["serviceAccount:tibotattle-staging-builder@tibotattle.iam.gserviceaccount.com"] }]);
  assert.equal(world.buckets.filter((bucket) => bucket.name === "tibotattle_cloudbuild").length, 1);
  const second = plan({ bootstrap: IMAGE });
  // Staging commits no refresh cadence, so no trigger is created and the scheduler's executor grant
  // is withheld with it (SCHEDULER_CADENCE_UNSET): the account cannot run a job nothing triggers.
  // The staging maintenance job renders from the stagingOrigin block (STAGING-MAINT-RENDER), and
  // the scheduler's grant on it follows the trigger's pause in pass 1.
  assert.deepEqual(second.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id), [
    "run-service:create",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-staging-invoker@tibotattle.iam.gserviceaccount.com|",
    "run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-staging-verifier@tibotattle.iam.gserviceaccount.com|",
    "run-job:create:production-migrate", "run-job:create:analytics-refresh", "run-job:create:maintenance",
    "run-job-iam:maintenance:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-staging-scheduler@tibotattle.iam.gserviceaccount.com|",
  ]);
  assert.ok(deferred(second).includes(
    "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-staging-scheduler@tibotattle.iam.gserviceaccount.com|:SCHEDULER_CADENCE_UNSET"));
  apply(second, { bootstrap: IMAGE });
  // Cloud Scheduler stored its User-Agent header on the created trigger (live staging pass 2,
  // 2026-10-03); readback accepts exactly that header, so it is not an override to update.
  assert.deepEqual(world.schedulerJobs.map((job) => [job.name.split("/").at(-1), job.state, job.httpTarget.headers]),
    [["tibotattle-staging-maintenance-trigger", "PAUSED", INJECTED_SCHEDULER_HEADERS]]);
  // The plane is clean: only the refresh trigger and its grant wait, for the owner's cadence
  // (SCHEDULER_CADENCE_UNSET, a clean deferral), so a staging readback --require-clean passes.
  const settled = plan();
  assert.deepEqual(operations.infrastructureCleanliness(settled), { clean: true, reasons: [] });
  assert.equal(settled.summary.executable, 0);
  assert.deepEqual(deferred(settled), [
    "scheduler:create:analytics-refresh:SCHEDULER_CADENCE_UNSET",
    "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-staging-scheduler@tibotattle.iam.gserviceaccount.com|:SCHEDULER_CADENCE_UNSET",
  ]);
  // Nothing touched the co-tenant, and every mutation named the staging plane.
  assert.deepEqual(world.services.map((service) => service.metadata.name).sort(),
    ["tibotattle-staging-origin", "tibotattle-test-app"]);
  for (const argv of gcloud.calls.filter((call) => operations.classifyGcloudCommand(call) === "mutate")) {
    assert.doesNotMatch(argv.join(" "), /tibotattle-test/u);
  }
});
