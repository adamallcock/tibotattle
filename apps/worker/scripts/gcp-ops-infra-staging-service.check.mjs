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
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as operations from "./gcp-ops-infra-operations.mjs";
import { CLEAN_DEFERRALS } from "./gcp-ops-infra-operations.mjs";
import { bornBucket, createFakeGcloud, emptyWorld, memoryWriter, withSecretValues } from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
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

test("OPS-2 defers the staging service until D-CRB lands the staging composition, and never calls that clean", () => {
  const staging = desired();
  assert.equal(manifest.serviceTemplateBlocker(staging), null);
  assert.equal(manifest.serviceRenderBlocker(staging), "STAGING_HOST_COMPOSITION_PENDING");
  assert.deepEqual({ ...manifest.SERVICE_COMPOSITION_PENDING }, { staging: "STAGING_HOST_COMPOSITION_PENDING" });
  assert.equal(CLEAN_DEFERRALS.includes("STAGING_HOST_COMPOSITION_PENDING"), false);
  // The server reads no HOST_MODE yet; when D-CRB adds it, its merge removes this gate with this assertion.
  const server = readFileSync(join(WORKER_ROOT, "cloud-run/server.mjs"), "utf8");
  assert.doesNotMatch(server, /\bHOST_MODE\b/u);
  // Production has no composition gate here (it waits for OWN-5's placeholders).
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
  // The committed file itself waits for the owner's Access AUD first.
  const committed = manifest.loadCommittedDesiredState("staging");
  assert.equal(manifest.serviceRenderBlocker(committed), "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud");
  assert.throws(() => manifest.stagingServiceTemplateValues(committed), { code: "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud" });
});

test("stagingOrigin is closed, staging-only and never a production value", () => {
  const committed = JSON.parse(COMMITTED_STAGING);
  assert.deepEqual(committed.stagingOrigin, {
    publicOrigin: "https://staging.tibotattle.com",
    accessTeamDomain: "tibotattle.cloudflareaccess.com",
    accessAud: null,
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
    doctor("value: 'STAGINGK01'", `value: '${configuration.PRODUCTION_VARS.APPLE_KEY_ID}'`),
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

test("the staging apply rehearsal (in memory): pass 1 builds the plane, pass 2 the jobs, and the service waits for D-CRB", () => {
  const staging = desired();
  const world = emptyWorld();
  withSecretValues(world, { project: staging.project, region: staging.region,
    names: Object.values(staging.secrets).map((secret) => secret.secretName) });
  world.buckets.push(bornBucket({ name: staging.bucket.name, location: staging.bucket.location,
    generation: PROOF.bucketGeneration, extra: { projectNumber: staging.projectNumber } }));
  // A co-tenant of the shared test project, never read into the plan or touched.
  world.services.push({ metadata: { name: "tibotattle-test-app" }, spec: { template: { spec: { containers: [{}] } } } });
  const writer = memoryWriter();
  const gcloud = createFakeGcloud(world, { files: writer.files, project: staging.project, region: staging.region });
  const plan = (options = {}) => operations.planInfrastructure(staging,
    operations.readbackInfrastructure(staging, { runner: gcloud.runner }), options);
  const deferred = (result) => result.operations.filter((entry) => entry.deferred !== undefined)
    .map((entry) => `${entry.id}:${entry.deferred}`);
  const first = plan();
  assert.deepEqual([first.summary.refused, first.findings, first.blockers], [0, [], []]);
  // 26 plane operations plus the verifier token-creator grant (operator named 2026-10-02).
  assert.equal(first.summary.executable, 27);
  assert.ok(deferred(first).includes("run-service:create:STAGING_HOST_COMPOSITION_PENDING"));
  assert.ok(deferred(first).includes("run-job:create:production-migrate:BOOTSTRAP_IMAGE_REQUIRED"));
  operations.applyInfrastructure(staging, { runner: gcloud.runner, authorize: first.planDigest,
    createSpecWriter: () => writer.create() });
  const second = plan({ bootstrap: IMAGE });
  // Staging commits no refresh cadence, so no trigger is created and the scheduler's executor grant
  // is withheld with it (SCHEDULER_CADENCE_UNSET): the account cannot run a job nothing triggers.
  assert.deepEqual(second.operations.filter((entry) => entry.deferred === undefined).map((entry) => entry.id), [
    "run-job:create:production-migrate", "run-job:create:analytics-refresh",
  ]);
  assert.ok(deferred(second).includes(
    "run-job-iam:analytics-refresh:bind:roles/run.jobsExecutor|serviceAccount:tibotattle-staging-scheduler@tibotattle.iam.gserviceaccount.com|:SCHEDULER_CADENCE_UNSET"));
  operations.applyInfrastructure(staging, { runner: gcloud.runner, authorize: second.planDigest, bootstrap: IMAGE,
    createSpecWriter: () => writer.create() });
  assert.deepEqual([...operations.infrastructureCleanliness(plan()).reasons], [
    "DEFERRED:run-service:create:STAGING_HOST_COMPOSITION_PENDING",
    "DEFERRED:run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-staging-invoker@tibotattle.iam.gserviceaccount.com|:STAGING_HOST_COMPOSITION_PENDING",
    "DEFERRED:run-service-iam:bind:roles/run.invoker|serviceAccount:tibotattle-staging-verifier@tibotattle.iam.gserviceaccount.com|:STAGING_HOST_COMPOSITION_PENDING",
  ]);
  // Nothing touched the co-tenant, and every mutation named the staging plane.
  assert.deepEqual(world.services.map((service) => service.metadata.name), ["tibotattle-test-app"]);
  for (const argv of gcloud.calls.filter((call) => operations.classifyGcloudCommand(call) === "mutate")) {
    assert.doesNotMatch(argv.join(" "), /tibotattle-test/u);
  }
});
