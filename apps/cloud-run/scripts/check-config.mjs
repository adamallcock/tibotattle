import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [template, dockerfile, dockerignore, iamVerifier] = await Promise.all([
  readFile(resolve(root, "cloud-run-service.template.yaml"), "utf8"),
  readFile(resolve(root, "Dockerfile"), "utf8"),
  readFile(resolve(root, ".dockerignore"), "utf8"),
  readFile(resolve(root, "scripts", "verify-iam.mjs"), "utf8"),
]);

for (const placeholder of [
  "__RUNTIME_SERVICE_ACCOUNT__",
  "__CONTAINER_IMAGE__",
  "__PRIVATE_BUCKET__",
]) {
  assert.match(template, new RegExp(placeholder));
}
for (const required of [
  "COLLECTION_MODE",
  "value: disabled",
  "OBJECT_STORE_MODE",
  "value: gcs",
  "startupProbe:",
  "livenessProbe:",
  "serviceAccountName:",
]) {
  assert.match(template, new RegExp(required));
}
assert.doesNotMatch(template, /allowUnauthenticated|allUsers|latest/u);
assert.match(
  template,
  /startupProbe:\s+httpGet:\s+path: \/readyz/u,
);
assert.match(
  template,
  /livenessProbe:\s+httpGet:\s+path: \/healthz/u,
);
assert.match(dockerfile, /^USER node$/mu);
assert.match(dockerfile, /npm ci --omit=dev/u);
// Every base-image stage must be pinned to an immutable registry digest, not a
// mutable version tag, so a moved or compromised upstream tag cannot substitute
// base-image bytes into an authorized rebuild.
const fromLines = dockerfile.match(/^FROM .*/gmu) ?? [];
assert.ok(
  fromLines.length >= 2,
  "Dockerfile must declare both build stages",
);
for (const line of fromLines) {
  assert.match(
    line,
    /@sha256:[0-9a-f]{64}(?: AS \S+)?$/u,
    `base image must be digest-pinned: ${line}`,
  );
}
assert.match(dockerignore, /^\.env\.\*$/mu);
assert.match(dockerignore, /^\.git$/mu);
assert.match(dockerignore, /^\.npmrc$/mu);
assert.match(dockerignore, /^\*\.secret$/mu);
assert.match(iamVerifier, /public_access_detected/u);
assert.match(iamVerifier, /roles\/storage\.objectUser/u);
assert.match(iamVerifier, /project_scope_too_broad/u);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "cloud-run-contained-config-check-v0.1",
  status: "passed",
  collectionMode: "disabled",
  placeholders: 3,
})}\n`);
