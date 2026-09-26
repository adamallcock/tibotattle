/**
 * Offline check of the IAM-private production origin templates:
 * production-service.template.yaml (the Knative Service spec) and
 * production-edge-iam.template.json (run.invoker for the Cloudflare edge).
 *
 * Nothing here reads or writes a live resource. The templates are validated
 * as checked in, then as doctored copies, so each guarded property is shown
 * to fail. The YAML reader below is a strict subset parser with no
 * dependency: it refuses anything the service template does not need
 * (anchors, aliases, tags, flow collections, block scalars, double quotes,
 * YAML 1.1 ambiguous plain scalars, duplicate keys and multi-document
 * streams), so a template that parses here reads the same under a YAML 1.1
 * or 1.2 loader.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

const SERVICE_TEMPLATE_URL = new URL("./production-service.template.yaml", import.meta.url);
const IAM_TEMPLATE_URL = new URL("./production-edge-iam.template.json", import.meta.url);
const PRODUCTION_CONFIGURATION_URL =
  new URL("./postgres-production-configuration.mjs", import.meta.url);

// Mirrors CR-3's REQUIRED_SECRET_NAMES and OPTIONAL_SECRET_NAMES. The
// cross-check test below compares them with CR-3's exports once that module
// is in the checkout.
const REQUIRED_SECRET_NAMES = Object.freeze([
  "IDENTITY_LINK_SECRET",
  "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK",
  "ENVELOPE_PRIVATE_JWK",
  "GOOGLE_OIDC_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
]);
const OPTIONAL_SECRET_NAMES = Object.freeze(["DISTRIBUTION_GITHUB_API_TOKEN"]);
const SECRET_NAMES = new Set([...REQUIRED_SECRET_NAMES, ...OPTIONAL_SECRET_NAMES]);

// Cloudflare-only names: they stay at the edge and never reach the origin.
const EDGE_ONLY_NAMES = [
  "EDGE_CLIENT_KEY_SECRET",
  "EDGE_INVOKER_KEY_JSON",
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
  "EDGE_PROOF_[A-Z0-9_]+",
  "SPARKLE_[A-Z0-9_]+",
].join("|");
const EDGE_ONLY_NAME = new RegExp(`^(?:${EDGE_ONLY_NAMES})$`, "u");
const EDGE_ONLY_TOKEN = new RegExp(`\\b(?:${EDGE_ONLY_NAMES})\\b`, "gu");
// Test seams that production configuration refuses.
const TEST_SEAM_NAME = new RegExp(`^(?:${[
  "ACCESS_TEST_JWKS_JSON",
  "IDENTITY_TEST_JWKS_JSON",
  "ADMIN_OWNER_FIXTURE_JSON",
  "ADMIN_OWNER_PREVIOUS_FIXTURE_JSON",
  "POSTGRES_TEST_HTTP_MODE",
  "HOST_RATE_LIMIT_[A-Z0-9_]*",
].join("|")})$`, "u");
const PUBLIC_PRINCIPAL = /allUsers|allAuthenticatedUsers/iu;

const EXPECTED_PLAIN_ENV = Object.freeze({
  HOST: "0.0.0.0",
  HOST_MODE: "production",
  HOST_ORIGIN: "https://${SERVICE_HOST}",
  PUBLIC_ORIGIN: "https://tibotattle.com",
  DEPLOYMENT_SOURCE_COMMIT: "${SOURCE_COMMIT}",
  EDGE_ORIGIN_MODE: "cloudflare-worker-iam",
  EDGE_ORIGIN_AUDIENCE: "${AUDIENCE}",
  EDGE_INVOKER_SERVICE_ACCOUNT: "${EDGE_INVOKER_SA}",
  EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS: "${VERIFIER_SA}",
  TELEMETRY_STORAGE_NAMESPACE: "${TELEMETRY_STORAGE_NAMESPACE}",
  PRIMARY_INSTANCE_CONNECTION_NAME: "${PRIMARY_INSTANCE_CONNECTION_NAME}",
  PRIMARY_DATABASE: "${PRIMARY_DATABASE}",
  PRIMARY_SCHEMA: "${PRIMARY_SCHEMA}",
  LEDGER_INSTANCE_CONNECTION_NAME: "${LEDGER_INSTANCE_CONNECTION_NAME}",
  LEDGER_DATABASE: "${LEDGER_DATABASE}",
  LEDGER_SCHEMA: "${LEDGER_SCHEMA}",
  POSTGRES_IAM_USER: "${POSTGRES_IAM_USER}",
  GCS_BUCKET_NAME: "${GCS_BUCKET_NAME}",
  GCS_ERASURE_BUCKET_HISTORY_PROOF: "${GCS_ERASURE_BUCKET_HISTORY_PROOF}",
});

// Secret version placeholders (SECRET_VERSION_<NAME>) join this set for each
// secret entry the template carries.
const SERVICE_PLACEHOLDERS = Object.freeze([
  "PROJECT", "REGION", "SERVICE", "RUNTIME_SA", "IMAGE_REPOSITORY",
  "IMAGE_DIGEST", "SOURCE_COMMIT", "SERVICE_HOST", "AUDIENCE",
  "EDGE_INVOKER_SA", "VERIFIER_SA", "MAX_INSTANCES",
  "TELEMETRY_STORAGE_NAMESPACE", "PRIMARY_INSTANCE_CONNECTION_NAME",
  "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME",
  "LEDGER_DATABASE", "LEDGER_SCHEMA", "POSTGRES_IAM_USER", "GCS_BUCKET_NAME",
  "GCS_ERASURE_BUCKET_HISTORY_PROOF",
]);
const IAM_PLACEHOLDERS = Object.freeze([
  "PROJECT", "REGION", "SERVICE", "EDGE_INVOKER_SA", "VERIFIER_SA",
]);

const IAM_SCHEMA = "tibotattle-production-edge-iam-template-v1";
const RUN_INVOKER = "roles/run.invoker";
const EDGE_INVOKER_MEMBER = "serviceAccount:${EDGE_INVOKER_SA}";
const VERIFIER_MEMBER = "serviceAccount:${VERIFIER_SA}";
const MEMBER_LABELS = new Map([
  [EDGE_INVOKER_MEMBER, "edge-invoker"],
  [VERIFIER_MEMBER, "verifier"],
]);
const MEMBER_PREFIX =
  /^(?:user|group|domain|serviceAccount|principal|principalSet|deleted|projectOwner|projectEditor|projectViewer)[:/]/u;
const ROLE_REFERENCE = /^(?:roles\/|projects\/[^/]+\/roles\/|organizations\/[^/]+\/roles\/)/u;

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/gu;
const CONCRETE_IDENTIFIERS = Object.freeze([
  ["image-digest", /sha256:[0-9a-f]{8,}/u],
  ["service-account-email", /\.iam\.gserviceaccount\.com\b/u],
  ["iam-database-user", /@[a-z][a-z0-9-]*\.iam(?![.\w-])/u],
  ["run-app-host", /\.run\.app\b/u],
  ["image-registry", /docker\.pkg\.dev|\bgcr\.io\b/u],
  ["source-commit", /\b[0-9a-f]{40}\b/u],
  ["project-number", /\b[0-9]{10,}\b/u],
  ["region", /\b(?:africa|asia|australia|europe|me|northamerica|southamerica|us)-[a-z]+[0-9]+\b/u],
]);

function testTargetValues(value, key = "") {
  if (typeof value === "string") {
    // Bare words such as the project id 'tibotattle' are too generic to
    // scan for; every separated identifier is specific to the test target.
    return key !== "listenHost" && /[-:@._]/u.test(value) ? [value] : [];
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) => testTargetValues(child, childKey));
  }
  return [];
}
const TEST_TARGET_VALUES = Object.freeze(testTargetValues(CLOUD_RUN_IAM_TEST_TARGET));

// ---------------------------------------------------------------------------
// Strict YAML subset reader.

const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9._/-]*$/u;
const PLAIN_STRING = /^[A-Za-z][A-Za-z0-9._/-]*$/u;
const PLAIN_INTEGER = /^(?:0|[1-9][0-9]{0,8})$/u;
// Plain words that a YAML 1.1 loader resolves to a boolean or null.
const YAML11_AMBIGUOUS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|null|Null|NULL|True|TRUE|False|FALSE)$/u;
const INLINE_MAPPING_ENTRY = /^[^\s:'"]+:(?: |$)/u;

function yamlError(code, lineNumber) {
  throw Object.assign(new Error(`${code} at line ${lineNumber}`), { code, lineNumber });
}

function isSequenceItem(content) {
  return content === "-" || content.startsWith("- ");
}

function parseStrictYaml(text) {
  const unsupported = /[\u0000-\u0009\u000b-\u001f\u007f\ufeff]/u.exec(text);
  if (unsupported !== null) {
    yamlError("YAML_UNSUPPORTED_CHARACTER", text.slice(0, unsupported.index).split("\n").length);
  }
  const lines = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/ +$/u, "");
    if (line === "") return;
    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);
    if (content.startsWith("#")) return;
    if (/^(?:---|\.\.\.)(?: |$)/u.test(content) || content.startsWith("%")) {
      yamlError("YAML_UNSUPPORTED_DOCUMENT_MARKER", index + 1);
    }
    lines.push({ indent, content, lineNumber: index + 1 });
  });
  if (lines.length === 0) yamlError("YAML_EMPTY", 1);
  if (lines[0].indent !== 0) yamlError("YAML_UNEXPECTED_INDENT", lines[0].lineNumber);
  const state = { lines, index: 0, scalars: [] };
  const value = parseNode(state, 0);
  if (state.index !== lines.length) {
    yamlError("YAML_UNEXPECTED_INDENT", lines[state.index].lineNumber);
  }
  return { value, scalars: state.scalars };
}

function parseNode(state, indent) {
  return isSequenceItem(state.lines[state.index].content)
    ? parseSequence(state, indent)
    : parseMapping(state, indent);
}

function parseNestedBlock(state, indent, lineNumber) {
  const next = state.lines[state.index];
  if (next === undefined || next.indent <= indent) yamlError("YAML_EMPTY_VALUE", lineNumber);
  return parseNode(state, next.indent);
}

function refuseDeeperLine(state, indent) {
  const next = state.lines[state.index];
  if (next !== undefined && next.indent > indent) {
    yamlError("YAML_UNEXPECTED_INDENT", next.lineNumber);
  }
}

function parseMapping(state, indent) {
  const result = {};
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent < indent) break;
    if (line.indent > indent) yamlError("YAML_UNEXPECTED_INDENT", line.lineNumber);
    if (isSequenceItem(line.content)) yamlError("YAML_UNEXPECTED_SEQUENCE", line.lineNumber);
    const match = /^([^\s:]+):(?: +(.*))?$/u.exec(line.content);
    if (match === null || !PLAIN_KEY.test(match[1])) {
      yamlError("YAML_UNSUPPORTED_KEY", line.lineNumber);
    }
    const key = match[1];
    if (Object.hasOwn(result, key)) yamlError("YAML_DUPLICATE_KEY", line.lineNumber);
    const rest = match[2] ?? "";
    state.index += 1;
    if (rest === "" || rest.startsWith("#")) {
      result[key] = parseNestedBlock(state, indent, line.lineNumber);
    } else {
      result[key] = parseScalar(rest, state, line.lineNumber);
      refuseDeeperLine(state, indent);
    }
  }
  return result;
}

function parseSequence(state, indent) {
  const items = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent < indent) break;
    if (line.indent > indent) yamlError("YAML_UNEXPECTED_INDENT", line.lineNumber);
    if (!isSequenceItem(line.content)) yamlError("YAML_UNEXPECTED_MAPPING", line.lineNumber);
    const rest = line.content.slice(2);
    if (rest.startsWith(" ")) yamlError("YAML_UNEXPECTED_INDENT", line.lineNumber);
    if (rest === "" || rest.startsWith("#")) {
      state.index += 1;
      items.push(parseNestedBlock(state, indent, line.lineNumber));
    } else if (isSequenceItem(rest)) {
      yamlError("YAML_UNSUPPORTED_NESTED_SEQUENCE", line.lineNumber);
    } else if (INLINE_MAPPING_ENTRY.test(rest)) {
      // '- key: value' opens a mapping whose keys align two columns right.
      state.lines[state.index] = { indent: indent + 2, content: rest, lineNumber: line.lineNumber };
      items.push(parseMapping(state, indent + 2));
    } else {
      state.index += 1;
      items.push(parseScalar(rest, state, line.lineNumber));
      refuseDeeperLine(state, indent);
    }
  }
  return items;
}

function parseScalar(raw, state, lineNumber) {
  if (raw.startsWith("'")) {
    let value = "";
    let index = 1;
    for (;;) {
      if (index >= raw.length) yamlError("YAML_UNTERMINATED_STRING", lineNumber);
      const character = raw[index];
      if (character === "'") {
        if (raw[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      value += character;
      index += 1;
    }
    const trailing = raw.slice(index);
    if (trailing !== "" && !/^ +#/u.test(trailing)) {
      yamlError("YAML_TRAILING_CONTENT", lineNumber);
    }
    state.scalars.push({ style: "single-quoted", value });
    return value;
  }
  const commentIndex = raw.indexOf(" #");
  const plain = (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd();
  state.scalars.push({ style: "plain", value: plain });
  if (PLAIN_INTEGER.test(plain)) return Number(plain);
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (YAML11_AMBIGUOUS.test(plain)) yamlError("YAML_AMBIGUOUS_SCALAR", lineNumber);
  if (!PLAIN_STRING.test(plain)) yamlError("YAML_UNSUPPORTED_SCALAR", lineNumber);
  return plain;
}

// ---------------------------------------------------------------------------
// Shared scans.

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...strings(child)]);
  }
  return [];
}

function placeholderNames(text) {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function closedKeys(value, allowed, path, findings) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) findings.add(`KEY_UNEXPECTED:${path}.${key}`);
  }
}

function placeholderFindings(text, expected, findings) {
  if (/\$(?!\{[A-Z][A-Z0-9_]*\})/u.test(text)) findings.add("PLACEHOLDER_MALFORMED");
  const used = new Set(placeholderNames(text));
  for (const name of used) {
    if (!expected.has(name)) findings.add(`PLACEHOLDER_UNKNOWN:${name}`);
  }
  for (const name of expected) {
    if (!used.has(name)) findings.add(`PLACEHOLDER_MISSING:${name}`);
  }
}

function documentFindings(document, findings) {
  for (const value of strings(document)) {
    if (PUBLIC_PRINCIPAL.test(value)) findings.add("PUBLIC_PRINCIPAL_PRESENT");
    for (const match of value.matchAll(EDGE_ONLY_TOKEN)) {
      findings.add(`EDGE_ONLY_SECRET_PRESENT:${match[0]}`);
    }
    const concrete = value.replace(PLACEHOLDER, "");
    for (const [label, pattern] of CONCRETE_IDENTIFIERS) {
      if (pattern.test(concrete)) findings.add(`CONCRETE_IDENTIFIER_PRESENT:${label}`);
    }
    if (TEST_TARGET_VALUES.some((target) => concrete.includes(target))) {
      findings.add("CONCRETE_IDENTIFIER_PRESENT:test-target");
    }
  }
}

// ---------------------------------------------------------------------------
// Service template.

function serviceTemplateFindings(text) {
  const findings = new Set();
  let parsed;
  try {
    parsed = parseStrictYaml(text);
  } catch (error) {
    if (typeof error?.code !== "string" || !error.code.startsWith("YAML_")) throw error;
    return [`${error.code}:${error.lineNumber}`];
  }
  const service = parsed.value;
  documentFindings(service, findings);

  // Rendering substitutes raw text, so every placeholder must sit inside a
  // single-quoted scalar, never in a comment, key or plain scalar.
  const quotedPlaceholders = parsed.scalars
    .filter((scalar) => scalar.style === "single-quoted")
    .reduce((count, scalar) => count + placeholderNames(scalar.value).length, 0);
  if (quotedPlaceholders !== placeholderNames(text).length
      || (text.match(/\$\{/gu) ?? []).length !== placeholderNames(text).length) {
    findings.add("PLACEHOLDER_OUTSIDE_SINGLE_QUOTED_SCALAR");
  }

  closedKeys(service, ["apiVersion", "kind", "metadata", "spec"], "service", findings);
  if (service?.apiVersion !== "serving.knative.dev/v1" || service?.kind !== "Service") {
    findings.add("KNATIVE_SERVICE_KIND_INVALID");
  }
  const metadata = isRecord(service?.metadata) ? service.metadata : {};
  closedKeys(metadata, ["name", "namespace", "labels", "annotations"], "metadata", findings);
  closedKeys(metadata.labels, ["cloud.googleapis.com/location"], "metadata.labels", findings);
  if (metadata.name !== "${SERVICE}" || metadata.namespace !== "${PROJECT}"
      || metadata.labels?.["cloud.googleapis.com/location"] !== "${REGION}") {
    findings.add("SERVICE_IDENTITY_INVALID");
  }
  const annotations = isRecord(metadata.annotations) ? metadata.annotations : {};
  closedKeys(annotations, [
    "run.googleapis.com/ingress",
    "run.googleapis.com/invoker-iam-disabled",
    "run.googleapis.com/custom-audiences",
  ], "metadata.annotations", findings);
  if (annotations["run.googleapis.com/ingress"] !== "all") findings.add("INGRESS_NOT_ALL");
  if (annotations["run.googleapis.com/invoker-iam-disabled"] !== "false") {
    findings.add("INVOKER_IAM_CHECK_DISABLED");
  }
  let audiences = null;
  try {
    audiences = JSON.parse(annotations["run.googleapis.com/custom-audiences"]);
  } catch {
    audiences = null;
  }
  if (!Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== "${AUDIENCE}") {
    findings.add("CUSTOM_AUDIENCE_INVALID");
  }

  const spec = isRecord(service?.spec) ? service.spec : {};
  closedKeys(spec, ["template", "traffic"], "spec", findings);
  const traffic = spec.traffic;
  if (!Array.isArray(traffic) || traffic.length !== 1 || !isRecord(traffic[0])
      || Object.keys(traffic[0]).length !== 2
      || traffic[0].percent !== 100 || traffic[0].latestRevision !== true) {
    findings.add("TRAFFIC_NOT_LATEST_ONLY");
  }
  const template = isRecord(spec.template) ? spec.template : {};
  closedKeys(template, ["metadata", "spec"], "spec.template", findings);
  const templateMetadata = isRecord(template.metadata) ? template.metadata : {};
  closedKeys(templateMetadata, ["annotations"], "spec.template.metadata", findings);
  const scaling = isRecord(templateMetadata.annotations) ? templateMetadata.annotations : {};
  closedKeys(scaling, [
    "autoscaling.knative.dev/minScale",
    "autoscaling.knative.dev/maxScale",
  ], "spec.template.metadata.annotations", findings);
  if (scaling["autoscaling.knative.dev/minScale"] !== "1") findings.add("MIN_INSTANCES_INVALID");
  if (scaling["autoscaling.knative.dev/maxScale"] !== "${MAX_INSTANCES}") {
    findings.add("MAX_INSTANCES_INVALID");
  }

  const revision = isRecord(template.spec) ? template.spec : {};
  closedKeys(revision, [
    "serviceAccountName", "containerConcurrency", "timeoutSeconds", "containers",
  ], "spec.template.spec", findings);
  if (revision.serviceAccountName !== "${RUNTIME_SA}") {
    findings.add("RUNTIME_SERVICE_ACCOUNT_INVALID");
  }
  if (revision.containerConcurrency !== 40) findings.add("CONTAINER_CONCURRENCY_INVALID");
  if (revision.timeoutSeconds !== 300) findings.add("TIMEOUT_INVALID");
  const containers = Array.isArray(revision.containers) ? revision.containers : [];
  if (containers.length !== 1 || !isRecord(containers[0])) {
    findings.add("CONTAINER_COUNT_INVALID");
  }
  const container = isRecord(containers[0]) ? containers[0] : {};
  closedKeys(container, ["image", "ports", "env"], "spec.template.spec.containers[0]", findings);
  if (container.image !== "${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}") {
    findings.add("IMAGE_NOT_DIGEST_PINNED");
  }
  const ports = container.ports;
  if (!Array.isArray(ports) || ports.length !== 1 || !isRecord(ports[0])
      || Object.keys(ports[0]).length !== 2
      || ports[0].name !== "http1" || ports[0].containerPort !== 8080) {
    findings.add("CONTAINER_PORT_INVALID");
  }

  const expectedPlaceholders = new Set(SERVICE_PLACEHOLDERS);
  const environment = Array.isArray(container.env) ? container.env : [];
  const seen = new Set();
  environment.forEach((entry, index) => {
    const path = `spec.template.spec.containers[0].env[${index}]`;
    const name = isRecord(entry) ? entry.name : undefined;
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      findings.add(`ENV_NAME_INVALID:${index}`);
      return;
    }
    if (seen.has(name)) findings.add(`ENV_DUPLICATE:${name}`);
    seen.add(name);
    const reference = isRecord(entry.valueFrom) ? entry.valueFrom : null;
    if (reference === null) {
      closedKeys(entry, ["name", "value"], path, findings);
    } else {
      closedKeys(entry, ["name", "valueFrom"], path, findings);
      closedKeys(reference, ["secretKeyRef"], `${path}.valueFrom`, findings);
      closedKeys(reference.secretKeyRef, ["name", "key"], `${path}.valueFrom.secretKeyRef`, findings);
    }
    if (EDGE_ONLY_NAME.test(name)) return; // documentFindings names it.
    if (TEST_SEAM_NAME.test(name)) {
      findings.add(`TEST_SEAM_PRESENT:${name}`);
      return;
    }
    if (SECRET_NAMES.has(name)) {
      expectedPlaceholders.add(`SECRET_VERSION_${name}`);
      const secret = reference?.secretKeyRef;
      if (!isRecord(secret) || Object.hasOwn(entry, "value")) {
        findings.add(`SECRET_NOT_FROM_SECRET_MANAGER:${name}`);
        return;
      }
      if (secret.name !== name) findings.add(`SECRET_REF_NAME_MISMATCH:${name}`);
      if (secret.key !== `\${SECRET_VERSION_${name}}`) {
        findings.add(`SECRET_VERSION_NOT_PINNED:${name}`);
      }
      return;
    }
    if (Object.hasOwn(EXPECTED_PLAIN_ENV, name)) {
      if (reference !== null || entry.value !== EXPECTED_PLAIN_ENV[name]) {
        findings.add(`ENV_VALUE_INVALID:${name}`);
      }
      return;
    }
    findings.add(`ENV_NAME_UNEXPECTED:${name}`);
  });
  for (const name of REQUIRED_SECRET_NAMES) {
    if (!seen.has(name)) findings.add(`REQUIRED_SECRET_MISSING:${name}`);
  }
  for (const name of Object.keys(EXPECTED_PLAIN_ENV)) {
    if (!seen.has(name)) findings.add(`ENV_MISSING:${name}`);
  }
  const edgeAudience = environment.find((entry) => entry?.name === "EDGE_ORIGIN_AUDIENCE");
  if (Array.isArray(audiences) && audiences.length === 1
      && edgeAudience?.value !== audiences[0]) {
    findings.add("CUSTOM_AUDIENCE_MISMATCH");
  }

  placeholderFindings(text, expectedPlaceholders, findings);
  return [...findings].sort();
}

// ---------------------------------------------------------------------------
// Edge-invoker IAM template.

function iamTemplateFindings(text) {
  const findings = new Set();
  let iam;
  try {
    iam = JSON.parse(text);
  } catch {
    return ["IAM_TEMPLATE_JSON_INVALID"];
  }
  documentFindings(iam, findings);
  placeholderFindings(text, new Set(IAM_PLACEHOLDERS), findings);
  if (!isRecord(iam)) return [...findings, "IAM_TEMPLATE_SHAPE_INVALID"].sort();

  closedKeys(iam, ["comment", "schema", "resource", "servicePolicy", "projectRoles"], "iam", findings);
  if (iam.schema !== IAM_SCHEMA) findings.add("IAM_SCHEMA_INVALID");
  const resource = isRecord(iam.resource) ? iam.resource : {};
  closedKeys(resource, ["type", "project", "region", "service"], "iam.resource", findings);
  if (resource.type !== "run.googleapis.com/Service" || resource.project !== "${PROJECT}"
      || resource.region !== "${REGION}" || resource.service !== "${SERVICE}") {
    findings.add("IAM_RESOURCE_INVALID");
  }

  for (const value of strings(iam)) {
    if (ROLE_REFERENCE.test(value) && value !== RUN_INVOKER) {
      findings.add("IAM_ROLE_NOT_RUN_INVOKER");
    }
  }

  const policy = isRecord(iam.servicePolicy) ? iam.servicePolicy : {};
  closedKeys(policy, ["bindings"], "iam.servicePolicy", findings);
  const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  if (bindings.length !== 1) findings.add("IAM_BINDING_COUNT_INVALID");
  let invokerBound = false;
  bindings.forEach((binding, index) => {
    const path = `iam.servicePolicy.bindings[${index}]`;
    if (!isRecord(binding)) {
      findings.add("IAM_BINDING_COUNT_INVALID");
      return;
    }
    closedKeys(binding, ["role", "members", "optionalMembers"], path, findings);
    if (binding.role !== RUN_INVOKER) findings.add("IAM_ROLE_NOT_RUN_INVOKER");
    const groups = [
      [binding.members, [EDGE_INVOKER_MEMBER]],
      [binding.optionalMembers ?? [], [VERIFIER_MEMBER]],
    ];
    for (const [members, allowed] of groups) {
      if (!Array.isArray(members)) {
        findings.add("IAM_MEMBER_UNEXPECTED");
        continue;
      }
      for (const member of members) {
        if (typeof member !== "string" || !member.startsWith("serviceAccount:")) {
          findings.add("IAM_MEMBER_NOT_SERVICE_ACCOUNT");
        } else if (!allowed.includes(member)) {
          findings.add("IAM_MEMBER_UNEXPECTED");
        }
      }
      if (new Set(members).size !== members.length) findings.add("IAM_MEMBER_UNEXPECTED");
    }
    if (Array.isArray(binding.members) && binding.members.includes(EDGE_INVOKER_MEMBER)) {
      invokerBound = true;
    }
  });
  if (!invokerBound) findings.add("IAM_EDGE_INVOKER_MISSING");

  // Only service accounts appear anywhere; a principal of any other kind
  // (user, group, domain, workforce or public) fails wherever it is written.
  for (const value of strings(iam)) {
    if (MEMBER_PREFIX.test(value) && !value.startsWith("serviceAccount:")) {
      findings.add("IAM_MEMBER_NOT_SERVICE_ACCOUNT");
    }
  }

  const projectRoles = isRecord(iam.projectRoles) ? iam.projectRoles : {};
  closedKeys(projectRoles, [EDGE_INVOKER_MEMBER, VERIFIER_MEMBER], "iam.projectRoles", findings);
  for (const [member, label] of MEMBER_LABELS) {
    const roles = projectRoles[member];
    if (roles === undefined) {
      if (member === EDGE_INVOKER_MEMBER) findings.add(`IAM_PROJECT_ROLES_UNRECORDED:${label}`);
    } else if (!Array.isArray(roles) || roles.length !== 0) {
      findings.add(`IAM_PROJECT_ROLE_GRANTED:${label}`);
    }
  }
  return [...findings].sort();
}

// ---------------------------------------------------------------------------
// Rendering contract. The infrastructure tooling owns rendering; this is the
// reference behaviour its renderer must match, exercised with synthetic
// values only.

function renderError(code) {
  throw Object.assign(new Error(code), { code });
}

function substitute(text, values, unsafe) {
  const used = new Set();
  const rendered = text.replace(PLACEHOLDER, (_, name) => {
    if (!Object.hasOwn(values, name)) renderError(`RENDER_PLACEHOLDER_UNRESOLVED:${name}`);
    const value = values[name];
    if (typeof value !== "string" || /[\u0000-\u001f\u007f$]/u.test(value) || unsafe.test(value)) {
      renderError(`RENDER_VALUE_UNSAFE:${name}`);
    }
    used.add(name);
    return value;
  });
  for (const name of Object.keys(values)) {
    if (!used.has(name)) renderError(`RENDER_VALUE_UNUSED:${name}`);
  }
  return rendered;
}

function renderServiceTemplate(text, values) {
  return parseStrictYaml(substitute(text, values, /'/u)).value;
}

function renderEdgeIamPolicy(text, values) {
  const rendered = JSON.parse(substitute(text, values, /["\\]/u));
  const binding = rendered.servicePolicy.bindings[0];
  // An optional member whose placeholder renders empty is omitted.
  const optional = binding.optionalMembers.filter((member) => member !== "serviceAccount:");
  return {
    bindings: [{ role: binding.role, members: [...binding.members, ...optional] }],
    projectRoles: Object.fromEntries(Object.entries(rendered.projectRoles)
      .filter(([member]) => member !== "serviceAccount:")),
  };
}

const SYNTHETIC_PROJECT = "example-origin-project";
const SYNTHETIC_RUNTIME = `example-runtime@${SYNTHETIC_PROJECT}.iam.gserviceaccount.com`;
const SYNTHETIC_INVOKER = `example-edge-invoker@${SYNTHETIC_PROJECT}.iam.gserviceaccount.com`;
const SYNTHETIC_VERIFIER = `example-verifier@${SYNTHETIC_PROJECT}.iam.gserviceaccount.com`;
const SYNTHETIC_SERVICE_VALUES = Object.freeze({
  PROJECT: SYNTHETIC_PROJECT,
  REGION: "example-region1",
  SERVICE: "example-origin",
  RUNTIME_SA: SYNTHETIC_RUNTIME,
  IMAGE_REPOSITORY: `example-region1-docker.pkg.dev/${SYNTHETIC_PROJECT}/example-repository/example-host`,
  IMAGE_DIGEST: "a".repeat(64),
  SOURCE_COMMIT: "b".repeat(40),
  SERVICE_HOST: "example-origin-000000000000.example-region1.run.app",
  AUDIENCE: "example-edge-origin-audience",
  EDGE_INVOKER_SA: SYNTHETIC_INVOKER,
  VERIFIER_SA: SYNTHETIC_VERIFIER,
  MAX_INSTANCES: "4",
  TELEMETRY_STORAGE_NAMESPACE: "example-namespace",
  PRIMARY_INSTANCE_CONNECTION_NAME: `${SYNTHETIC_PROJECT}:example-region1:example-primary`,
  PRIMARY_DATABASE: "example_primary",
  PRIMARY_SCHEMA: "example_primary_schema",
  LEDGER_INSTANCE_CONNECTION_NAME: `${SYNTHETIC_PROJECT}:example-region1:example-ledger`,
  LEDGER_DATABASE: "example_ledger",
  LEDGER_SCHEMA: "example_ledger_schema",
  POSTGRES_IAM_USER: `example-runtime@${SYNTHETIC_PROJECT}.iam`,
  GCS_BUCKET_NAME: "example-origin-bucket",
  GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify({ bucket: "example-origin-bucket" }),
  ...Object.fromEntries(REQUIRED_SECRET_NAMES.map((name, index) =>
    [`SECRET_VERSION_${name}`, String(index + 1)])),
});
const SYNTHETIC_IAM_VALUES = Object.freeze({
  PROJECT: SYNTHETIC_PROJECT,
  REGION: "example-region1",
  SERVICE: "example-origin",
  EDGE_INVOKER_SA: SYNTHETIC_INVOKER,
  VERIFIER_SA: SYNTHETIC_VERIFIER,
});

// ---------------------------------------------------------------------------
// Tests.

const SERVICE_TEXT = readFileSync(SERVICE_TEMPLATE_URL, "utf8");
const IAM_TEXT = readFileSync(IAM_TEMPLATE_URL, "utf8");

function doctor(text, search, replacement) {
  const count = text.split(search).length - 1;
  assert.equal(count, 1, `doctored copy needs exactly one ${JSON.stringify(search)}`);
  return text.replace(search, () => replacement);
}

function doctorIam(mutate) {
  const document = JSON.parse(IAM_TEXT);
  mutate(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

const SECRET_ENTRY = (name, key) => [
  `            - name: ${name}`,
  "              valueFrom:",
  "                secretKeyRef:",
  `                  name: ${name}`,
  `                  key: '${key}'`,
].join("\n");
const ENV_ANCHOR = "            - name: HOST_MODE\n";

function withEnvEntry(entry) {
  return doctor(SERVICE_TEXT, ENV_ANCHOR, `${entry}\n${ENV_ANCHOR}`);
}

test("the checked-in service and IAM templates pass", () => {
  assert.deepEqual(serviceTemplateFindings(SERVICE_TEXT), []);
  assert.deepEqual(iamTemplateFindings(IAM_TEXT), []);
});

test("the service template carries every required secret by secretKeyRef and no optional secret", () => {
  const service = parseStrictYaml(SERVICE_TEXT).value;
  const env = service.spec.template.spec.containers[0].env;
  const secrets = env.filter((entry) => entry.valueFrom !== undefined).map((entry) => entry.name);
  assert.deepEqual([...secrets].sort(), [...REQUIRED_SECRET_NAMES].sort());
  assert.deepEqual(
    env.filter((entry) => entry.valueFrom === undefined).map((entry) => entry.name).sort(),
    Object.keys(EXPECTED_PLAIN_ENV).sort(),
  );
});

test("secret name sets match CR-3's exported REQUIRED and OPTIONAL sets", {
  skip: existsSync(PRODUCTION_CONFIGURATION_URL)
    ? false
    : "CR-3 postgres-production-configuration.mjs is not in this checkout",
}, async () => {
  const configuration = await import(PRODUCTION_CONFIGURATION_URL.href);
  assert.deepEqual([...configuration.REQUIRED_SECRET_NAMES].sort(), [...REQUIRED_SECRET_NAMES].sort());
  assert.deepEqual([...configuration.OPTIONAL_SECRET_NAMES].sort(), [...OPTIONAL_SECRET_NAMES].sort());
});

test("ingress other than 'all' fails", () => {
  const line = "    run.googleapis.com/ingress: all\n";
  for (const replacement of [
    "    run.googleapis.com/ingress: internal\n",
    "    run.googleapis.com/ingress: internal-and-cloud-load-balancing\n",
    "",
  ]) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line, replacement)),
      ["INGRESS_NOT_ALL"]);
  }
});

test("invoker-iam-disabled other than the string 'false' fails", () => {
  const line = "    run.googleapis.com/invoker-iam-disabled: 'false'\n";
  for (const replacement of [
    "    run.googleapis.com/invoker-iam-disabled: 'true'\n",
    "    run.googleapis.com/invoker-iam-disabled: true\n",
    // A YAML boolean is not the string annotation Cloud Run reads.
    "    run.googleapis.com/invoker-iam-disabled: false\n",
    "",
  ]) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line, replacement)),
      ["INVOKER_IAM_CHECK_DISABLED"]);
  }
});

test("allUsers or allAuthenticatedUsers anywhere fails", () => {
  for (const principal of ["allUsers", "allAuthenticatedUsers"]) {
    assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
      iam.servicePolicy.bindings[0].members.push(principal);
    })), ["IAM_MEMBER_NOT_SERVICE_ACCOUNT", "PUBLIC_PRINCIPAL_PRESENT"]);
    assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
      iam.servicePolicy.bindings[0].optionalMembers.push(principal);
    })), ["IAM_MEMBER_NOT_SERVICE_ACCOUNT", "PUBLIC_PRINCIPAL_PRESENT"]);
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
      "    run.googleapis.com/ingress: all\n",
      `    run.googleapis.com/ingress: all\n    run.googleapis.com/invoker: ${principal}\n`)),
    ["KEY_UNEXPECTED:metadata.annotations.run.googleapis.com/invoker", "PUBLIC_PRINCIPAL_PRESENT"]);
  }
});

test("a missing or different custom audience fails", () => {
  const line = "    run.googleapis.com/custom-audiences: '[\"${AUDIENCE}\"]'\n";
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line, "")),
    ["CUSTOM_AUDIENCE_INVALID"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line,
    "    run.googleapis.com/custom-audiences: '[\"${SERVICE_HOST}\"]'\n")),
  ["CUSTOM_AUDIENCE_INVALID", "CUSTOM_AUDIENCE_MISMATCH"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line,
    "    run.googleapis.com/custom-audiences: '[\"${AUDIENCE}\", \"${SERVICE_HOST}\"]'\n")),
  ["CUSTOM_AUDIENCE_INVALID"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "              value: '${AUDIENCE}'\n", "              value: '${SERVICE_HOST}'\n")),
  ["CUSTOM_AUDIENCE_MISMATCH", "ENV_VALUE_INVALID:EDGE_ORIGIN_AUDIENCE"]);
});

test("a request timeout other than 300 seconds fails", () => {
  const line = "      timeoutSeconds: 300\n";
  for (const replacement of [
    "      timeoutSeconds: 299\n",
    "      timeoutSeconds: 60\n",
    "      timeoutSeconds: '300'\n",
    "",
  ]) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line, replacement)),
      ["TIMEOUT_INVALID"]);
  }
});

test("a tag-pinned or concrete image fails", () => {
  const line = "        - image: '${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}'\n";
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line,
    "        - image: '${IMAGE_REPOSITORY}:latest'\n")),
  ["IMAGE_NOT_DIGEST_PINNED", "PLACEHOLDER_MISSING:IMAGE_DIGEST"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line,
    "        - image: '${IMAGE_REPOSITORY}:${IMAGE_DIGEST}'\n")),
  ["IMAGE_NOT_DIGEST_PINNED"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, line,
    `        - image: 'example-region1-docker.pkg.dev/example-project/r/i@sha256:${"c".repeat(64)}'\n`)),
  [
    "CONCRETE_IDENTIFIER_PRESENT:image-digest",
    "CONCRETE_IDENTIFIER_PRESENT:image-registry",
    "IMAGE_NOT_DIGEST_PINNED",
    "PLACEHOLDER_MISSING:IMAGE_DIGEST",
    "PLACEHOLDER_MISSING:IMAGE_REPOSITORY",
  ]);
});

test("any edge-only secret or Sparkle value fails", () => {
  for (const name of [
    "EDGE_CLIENT_KEY_SECRET",
    "EDGE_INVOKER_KEY_JSON",
    "DISTRIBUTION_ANALYTICS_API_TOKEN",
    "SPARKLE_APPCAST_GUARD_TOKEN",
    "EDGE_PROOF_SECRET",
  ]) {
    assert.deepEqual(serviceTemplateFindings(withEnvEntry(SECRET_ENTRY(name, "1"))),
      [`EDGE_ONLY_SECRET_PRESENT:${name}`]);
  }
  assert.deepEqual(serviceTemplateFindings(withEnvEntry(
    "            - name: SPARKLE_APPCAST_GUARD_MODE\n              value: enabled")),
  ["EDGE_ONLY_SECRET_PRESENT:SPARKLE_APPCAST_GUARD_MODE"]);
  // A Cloudflare-only secret fails under any environment name.
  const aliased = withEnvEntry([
    "            - name: ORIGIN_KEY",
    "              valueFrom:",
    "                secretKeyRef:",
    "                  name: EDGE_CLIENT_KEY_SECRET",
    "                  key: '1'",
  ].join("\n"));
  assert.deepEqual(serviceTemplateFindings(aliased),
    ["EDGE_ONLY_SECRET_PRESENT:EDGE_CLIENT_KEY_SECRET", "ENV_NAME_UNEXPECTED:ORIGIN_KEY"]);
});

test("a missing IDENTITY_LINK_SECRET or a secret outside Secret Manager fails", () => {
  const entry = `            # IDENTITY_LINK_SECRET also keys the edge admission replay.\n${
    SECRET_ENTRY("IDENTITY_LINK_SECRET", "${SECRET_VERSION_IDENTITY_LINK_SECRET}")}\n`;
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, entry, "")),
    ["REQUIRED_SECRET_MISSING:IDENTITY_LINK_SECRET"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, entry,
    "            - name: IDENTITY_LINK_SECRET\n              value: '${SECRET_VERSION_IDENTITY_LINK_SECRET}'\n")),
  ["SECRET_NOT_FROM_SECRET_MANAGER:IDENTITY_LINK_SECRET"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "                  key: '${SECRET_VERSION_IDENTITY_LINK_SECRET}'\n",
    "                  key: latest\n")),
  ["PLACEHOLDER_MISSING:SECRET_VERSION_IDENTITY_LINK_SECRET",
    "SECRET_VERSION_NOT_PINNED:IDENTITY_LINK_SECRET"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "                  name: IDENTITY_LINK_SECRET\n",
    "                  name: IDENTITY_LINK_SECRET_OTHER\n")),
  ["SECRET_REF_NAME_MISMATCH:IDENTITY_LINK_SECRET"]);
  for (const name of REQUIRED_SECRET_NAMES.filter((secret) => secret !== "IDENTITY_LINK_SECRET")) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
      `${SECRET_ENTRY(name, `\${SECRET_VERSION_${name}}`)}\n`, "")),
    [`REQUIRED_SECRET_MISSING:${name}`]);
  }
});

test("the optional secret may be added only in the pinned secretKeyRef form", () => {
  const name = "DISTRIBUTION_GITHUB_API_TOKEN";
  assert.deepEqual(serviceTemplateFindings(withEnvEntry(
    SECRET_ENTRY(name, `\${SECRET_VERSION_${name}}`))), []);
  assert.deepEqual(serviceTemplateFindings(withEnvEntry(SECRET_ENTRY(name, "latest"))),
    [`PLACEHOLDER_MISSING:SECRET_VERSION_${name}`, `SECRET_VERSION_NOT_PINNED:${name}`]);
});

test("the fixed service settings are pinned", () => {
  const cases = [
    ["      containerConcurrency: 40\n", "      containerConcurrency: 80\n",
      ["CONTAINER_CONCURRENCY_INVALID"]],
    ["        autoscaling.knative.dev/minScale: '1'\n",
      "        autoscaling.knative.dev/minScale: '0'\n", ["MIN_INSTANCES_INVALID"]],
    ["        autoscaling.knative.dev/maxScale: '${MAX_INSTANCES}'\n",
      "        autoscaling.knative.dev/maxScale: '100'\n",
      ["MAX_INSTANCES_INVALID", "PLACEHOLDER_MISSING:MAX_INSTANCES"]],
    ["              value: production\n", "              value: staging\n",
      ["ENV_VALUE_INVALID:HOST_MODE"]],
    ["              value: cloudflare-worker-iam\n", "              value: hmac\n",
      ["ENV_VALUE_INVALID:EDGE_ORIGIN_MODE"]],
    ["              value: 'https://tibotattle.com'\n",
      "              value: 'https://staging.tibotattle.com'\n",
      ["ENV_VALUE_INVALID:PUBLIC_ORIGIN"]],
    ["              value: '${SOURCE_COMMIT}'\n", "              value: 'unknown'\n",
      ["ENV_VALUE_INVALID:DEPLOYMENT_SOURCE_COMMIT", "PLACEHOLDER_MISSING:SOURCE_COMMIT"]],
    ["      serviceAccountName: '${RUNTIME_SA}'\n",
      "      serviceAccountName: '${EDGE_INVOKER_SA}'\n",
      ["PLACEHOLDER_MISSING:RUNTIME_SA", "RUNTIME_SERVICE_ACCOUNT_INVALID"]],
    ["    - percent: 100\n      latestRevision: true\n",
      "    - percent: 90\n      latestRevision: true\n    - percent: 10\n      revisionName: example-00001\n",
      ["TRAFFIC_NOT_LATEST_ONLY"]],
    ["            - name: http1\n              containerPort: 8080\n",
      "            - name: http1\n              containerPort: 9090\n",
      ["CONTAINER_PORT_INVALID"]],
    ["  name: '${SERVICE}'\n", "  name: 'example-origin'\n",
      ["PLACEHOLDER_MISSING:SERVICE", "SERVICE_IDENTITY_INVALID"]],
  ];
  for (const [search, replacement, expected] of cases) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, search, replacement)), expected,
      search);
  }
});

test("environment and container shape are closed", () => {
  for (const name of ["POSTGRES_TEST_HTTP_MODE", "ACCESS_TEST_JWKS_JSON", "IDENTITY_TEST_JWKS_JSON",
    "ADMIN_OWNER_FIXTURE_JSON", "HOST_RATE_LIMIT_ENROLLMENT"]) {
    assert.deepEqual(serviceTemplateFindings(withEnvEntry(
      `            - name: ${name}\n              value: example`)), [`TEST_SEAM_PRESENT:${name}`]);
  }
  assert.deepEqual(serviceTemplateFindings(withEnvEntry(
    "            - name: DATABASE_URL\n              value: example")),
  ["ENV_NAME_UNEXPECTED:DATABASE_URL"]);
  assert.deepEqual(serviceTemplateFindings(withEnvEntry(
    "            - name: HOST_MODE\n              value: production")),
  ["ENV_DUPLICATE:HOST_MODE"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "            - name: HOST\n              value: '0.0.0.0'\n", "")),
  ["ENV_MISSING:HOST"]);
  // An HTTP probe carries no invoker token, so the boundary would refuse it.
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, "          ports:\n",
    "          startupProbe:\n            httpGet:\n              path: '/api/health'\n          ports:\n")),
  ["KEY_UNEXPECTED:spec.template.spec.containers[0].startupProbe"]);
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "    run.googleapis.com/ingress: all\n",
    "    run.googleapis.com/ingress: all\n    run.googleapis.com/launch-stage: BETA\n")),
  ["KEY_UNEXPECTED:metadata.annotations.run.googleapis.com/launch-stage"]);
});

test("the service template holds placeholders only", () => {
  const cases = [
    ["      serviceAccountName: '${RUNTIME_SA}'\n",
      "      serviceAccountName: 'example-runtime@example-project.iam.gserviceaccount.com'\n",
      ["CONCRETE_IDENTIFIER_PRESENT:service-account-email", "PLACEHOLDER_MISSING:RUNTIME_SA",
        "RUNTIME_SERVICE_ACCOUNT_INVALID"]],
    ["    cloud.googleapis.com/location: '${REGION}'\n",
      `    cloud.googleapis.com/location: '${CLOUD_RUN_IAM_TEST_TARGET.region}'\n`,
      ["CONCRETE_IDENTIFIER_PRESENT:region", "CONCRETE_IDENTIFIER_PRESENT:test-target",
        "PLACEHOLDER_MISSING:REGION", "SERVICE_IDENTITY_INVALID"]],
    ["              value: 'https://${SERVICE_HOST}'\n",
      `              value: '${CLOUD_RUN_IAM_TEST_TARGET.origin}'\n`,
      ["CONCRETE_IDENTIFIER_PRESENT:run-app-host", "CONCRETE_IDENTIFIER_PRESENT:test-target",
        "ENV_VALUE_INVALID:HOST_ORIGIN", "PLACEHOLDER_MISSING:SERVICE_HOST"]],
    ["              value: '${SOURCE_COMMIT}'\n", `              value: '${"d".repeat(40)}'\n`,
      ["CONCRETE_IDENTIFIER_PRESENT:source-commit", "ENV_VALUE_INVALID:DEPLOYMENT_SOURCE_COMMIT",
        "PLACEHOLDER_MISSING:SOURCE_COMMIT"]],
    ["              value: '${GCS_BUCKET_NAME}'\n",
      `              value: '${CLOUD_RUN_IAM_TEST_TARGET.gcsBucket}'\n`,
      ["CONCRETE_IDENTIFIER_PRESENT:test-target", "ENV_VALUE_INVALID:GCS_BUCKET_NAME",
        "PLACEHOLDER_MISSING:GCS_BUCKET_NAME"]],
    ["              value: '${GCS_BUCKET_NAME}'\n", "              value: '${GCS_BUCKET}'\n",
      ["ENV_VALUE_INVALID:GCS_BUCKET_NAME", "PLACEHOLDER_MISSING:GCS_BUCKET_NAME",
        "PLACEHOLDER_UNKNOWN:GCS_BUCKET"]],
    ["              value: '${GCS_BUCKET_NAME}'\n", "              value: '$GCS_BUCKET_NAME'\n",
      ["ENV_VALUE_INVALID:GCS_BUCKET_NAME", "PLACEHOLDER_MALFORMED",
        "PLACEHOLDER_MISSING:GCS_BUCKET_NAME"]],
  ];
  for (const [search, replacement, expected] of cases) {
    assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, search, replacement)), expected,
      replacement);
  }
  // Rendering is text substitution, so a placeholder in a comment or a
  // plain scalar is refused.
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT, "apiVersion:",
    "# rendered for ${PROJECT}\napiVersion:")),
  ["PLACEHOLDER_OUTSIDE_SINGLE_QUOTED_SCALAR"]);
  const nameLine = SERVICE_TEXT.slice(0, SERVICE_TEXT.indexOf("  name: '${SERVICE}'"))
    .split("\n").length;
  assert.deepEqual(serviceTemplateFindings(doctor(SERVICE_TEXT,
    "  name: '${SERVICE}'\n", "  name: ${SERVICE}\n")), [`YAML_UNSUPPORTED_SCALAR:${nameLine}`]);
});

test("any role other than run.invoker fails", () => {
  for (const role of ["roles/run.admin", "roles/run.developer", "roles/editor", "roles/owner",
    "projects/example/roles/custom"]) {
    assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
      iam.servicePolicy.bindings[0].role = role;
    })), ["IAM_ROLE_NOT_RUN_INVOKER"], role);
  }
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.servicePolicy.bindings.push({
      role: "roles/run.viewer",
      members: ["serviceAccount:${EDGE_INVOKER_SA}"],
    });
  })), ["IAM_BINDING_COUNT_INVALID", "IAM_ROLE_NOT_RUN_INVOKER"]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.servicePolicy.bindings[0].condition = { expression: "true" };
  })), ["KEY_UNEXPECTED:iam.servicePolicy.bindings[0].condition"]);
});

test("the invoker and verifier hold no project roles", () => {
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.projectRoles["serviceAccount:${EDGE_INVOKER_SA}"] = ["roles/run.invoker"];
  })), ["IAM_PROJECT_ROLE_GRANTED:edge-invoker"]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.projectRoles["serviceAccount:${VERIFIER_SA}"] = ["roles/viewer"];
  })), ["IAM_PROJECT_ROLE_GRANTED:verifier", "IAM_ROLE_NOT_RUN_INVOKER"]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    delete iam.projectRoles["serviceAccount:${EDGE_INVOKER_SA}"];
  })), ["IAM_PROJECT_ROLES_UNRECORDED:edge-invoker"]);
});

test("any non-serviceAccount member fails", () => {
  for (const member of [
    "user:example@example.invalid",
    "group:example@example.invalid",
    "domain:example.invalid",
    "principalSet://iam.googleapis.com/locations/global/workforcePools/example/*",
    "projectViewer:example",
  ]) {
    assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
      iam.servicePolicy.bindings[0].members.push(member);
    })), ["IAM_MEMBER_NOT_SERVICE_ACCOUNT"], member);
    assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
      iam.projectRoles[member] = [];
    })), [`IAM_MEMBER_NOT_SERVICE_ACCOUNT`, `KEY_UNEXPECTED:iam.projectRoles.${member}`], member);
  }
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.servicePolicy.bindings[0].members = ["serviceAccount:${VERIFIER_SA}"];
  })), ["IAM_EDGE_INVOKER_MISSING", "IAM_MEMBER_UNEXPECTED"]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.servicePolicy.bindings[0].members.push("serviceAccount:${RUNTIME_SA}");
  })), ["IAM_MEMBER_UNEXPECTED", "PLACEHOLDER_UNKNOWN:RUNTIME_SA"]);
});

test("the IAM template holds placeholders only", () => {
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.servicePolicy.bindings[0].members =
      ["serviceAccount:edge@example-project.iam.gserviceaccount.com"];
  })), [
    "CONCRETE_IDENTIFIER_PRESENT:service-account-email",
    "IAM_EDGE_INVOKER_MISSING",
    "IAM_MEMBER_UNEXPECTED",
  ]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.resource.project = CLOUD_RUN_IAM_TEST_TARGET.project;
    iam.resource.service = CLOUD_RUN_IAM_TEST_TARGET.service;
  })), [
    "CONCRETE_IDENTIFIER_PRESENT:test-target",
    "IAM_RESOURCE_INVALID",
    "PLACEHOLDER_MISSING:PROJECT",
    "PLACEHOLDER_MISSING:SERVICE",
  ]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.resource.region = "$REGION";
  })), ["IAM_RESOURCE_INVALID", "PLACEHOLDER_MALFORMED", "PLACEHOLDER_MISSING:REGION"]);
  assert.deepEqual(iamTemplateFindings(doctorIam((iam) => {
    iam.schema = "example-v2";
    iam.extra = true;
  })), ["IAM_SCHEMA_INVALID", "KEY_UNEXPECTED:iam.extra"]);
  assert.deepEqual(iamTemplateFindings("{"), ["IAM_TEMPLATE_JSON_INVALID"]);
});

test("the YAML reader refuses syntax outside the reviewed subset", () => {
  const cases = [
    ["a: 1\na: 2\n", "YAML_DUPLICATE_KEY"],
    ["a: &x 1\nb: *x\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: !!str 1\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: [1, 2]\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: {b: 1}\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: |\n  text\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: \"text\"\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: yes\n", "YAML_AMBIGUOUS_SCALAR"],
    ["a: 1.5\n", "YAML_UNSUPPORTED_SCALAR"],
    ["a: 'open\n", "YAML_UNTERMINATED_STRING"],
    ["a: 'x' y\n", "YAML_TRAILING_CONTENT"],
    ["---\na: 1\n", "YAML_UNSUPPORTED_DOCUMENT_MARKER"],
    ["a:\n\tb: 1\n", "YAML_UNSUPPORTED_CHARACTER"],
    ["<<: 1\n", "YAML_UNSUPPORTED_KEY"],
    ["? a\n", "YAML_UNSUPPORTED_KEY"],
    ["a:\n- 1\n", "YAML_EMPTY_VALUE"],
    ["a:\n  b: 1\n c: 2\n", "YAML_UNEXPECTED_INDENT"],
    ["a: 1\n  b: 2\n", "YAML_UNEXPECTED_INDENT"],
    ["a:\n  - - 1\n", "YAML_UNSUPPORTED_NESTED_SEQUENCE"],
  ];
  for (const [text, code] of cases) {
    assert.throws(() => parseStrictYaml(text), { code }, JSON.stringify(text));
  }
  assert.deepEqual(parseStrictYaml([
    "# comment",
    "a:",
    "  - name: x # trailing",
    "    value: 'it''s'",
    "  - 7",
    "b: true",
  ].join("\n")).value, { a: [{ name: "x", value: "it's" }, 7], b: true });
});

test("rendering fills every placeholder into a digest-pinned, audience-bound spec", () => {
  const service = renderServiceTemplate(SERVICE_TEXT, SYNTHETIC_SERVICE_VALUES);
  const container = service.spec.template.spec.containers[0];
  assert.match(container.image, /^[^@:\s]+@sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    JSON.parse(service.metadata.annotations["run.googleapis.com/custom-audiences"]),
    [SYNTHETIC_SERVICE_VALUES.AUDIENCE],
  );
  const env = new Map(container.env.map((entry) => [entry.name, entry]));
  assert.equal(env.get("EDGE_ORIGIN_AUDIENCE").value, SYNTHETIC_SERVICE_VALUES.AUDIENCE);
  assert.equal(env.get("EDGE_INVOKER_SERVICE_ACCOUNT").value, SYNTHETIC_INVOKER);
  assert.equal(env.get("DEPLOYMENT_SOURCE_COMMIT").value, SYNTHETIC_SERVICE_VALUES.SOURCE_COMMIT);
  assert.equal(env.get("HOST_ORIGIN").value, `https://${SYNTHETIC_SERVICE_VALUES.SERVICE_HOST}`);
  assert.equal(env.get("GCS_ERASURE_BUCKET_HISTORY_PROOF").value,
    SYNTHETIC_SERVICE_VALUES.GCS_ERASURE_BUCKET_HISTORY_PROOF);
  assert.deepEqual(env.get("IDENTITY_LINK_SECRET").valueFrom.secretKeyRef,
    { name: "IDENTITY_LINK_SECRET", key: "1" });
  assert.equal(service.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"], "4");
  assert.doesNotMatch(JSON.stringify(service), /\$\{/u);

  const noVerifier = renderServiceTemplate(SERVICE_TEXT, { ...SYNTHETIC_SERVICE_VALUES, VERIFIER_SA: "" });
  assert.equal(noVerifier.spec.template.spec.containers[0].env
    .find((entry) => entry.name === "EDGE_ORIGIN_VERIFIER_SERVICE_ACCOUNTS").value, "");
});

test("rendering binds only the invoker and, when present, the verifier", () => {
  assert.deepEqual(renderEdgeIamPolicy(IAM_TEXT, SYNTHETIC_IAM_VALUES), {
    bindings: [{
      role: "roles/run.invoker",
      members: [`serviceAccount:${SYNTHETIC_INVOKER}`, `serviceAccount:${SYNTHETIC_VERIFIER}`],
    }],
    projectRoles: {
      [`serviceAccount:${SYNTHETIC_INVOKER}`]: [],
      [`serviceAccount:${SYNTHETIC_VERIFIER}`]: [],
    },
  });
  assert.deepEqual(renderEdgeIamPolicy(IAM_TEXT, { ...SYNTHETIC_IAM_VALUES, VERIFIER_SA: "" }), {
    bindings: [{ role: "roles/run.invoker", members: [`serviceAccount:${SYNTHETIC_INVOKER}`] }],
    projectRoles: { [`serviceAccount:${SYNTHETIC_INVOKER}`]: [] },
  });
});

test("rendering refuses unresolved, unused and structure-changing values", () => {
  const { AUDIENCE: _audience, ...missing } = SYNTHETIC_SERVICE_VALUES;
  assert.throws(() => renderServiceTemplate(SERVICE_TEXT, missing),
    { code: "RENDER_PLACEHOLDER_UNRESOLVED:AUDIENCE" });
  assert.throws(() => renderServiceTemplate(SERVICE_TEXT, { ...SYNTHETIC_SERVICE_VALUES, EXTRA: "x" }),
    { code: "RENDER_VALUE_UNUSED:EXTRA" });
  for (const value of ["x'\n  injected: 'y", "line\nbreak", "${PROJECT}"]) {
    assert.throws(() => renderServiceTemplate(SERVICE_TEXT, { ...SYNTHETIC_SERVICE_VALUES, AUDIENCE: value }),
      { code: "RENDER_VALUE_UNSAFE:AUDIENCE" });
  }
  assert.throws(() => renderEdgeIamPolicy(IAM_TEXT, {
    ...SYNTHETIC_IAM_VALUES,
    EDGE_INVOKER_SA: "x\", \"allUsers",
  }), { code: "RENDER_VALUE_UNSAFE:EDGE_INVOKER_SA" });
});
