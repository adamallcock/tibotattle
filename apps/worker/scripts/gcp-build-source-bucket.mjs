/**
 * The Cloud Build source bucket a plane's builds stage their source in
 * (BUILD-SOURCE, owner decision round 19, 2026-10-03: "grant on default bucket").
 *
 * `gcloud builds submit <archive>` uploads the archive with the operator's
 * credentials, and the build then runs as the plane's builder account, which
 * must read that object. The bucket is the project's default Cloud Build
 * bucket, `<project>_cloudbuild` (staging: tibotattle_cloudbuild; production:
 * tibotattle-prod_cloudbuild), under the `source/` prefix gcloud stages into.
 *
 * - OPS-2 (gcp-ops-infra-operations.mjs) manages one bucket-level binding on
 *   it: roles/storage.objectViewer for the plane's builder account, and no
 *   other role for that account and no other member on that role. The
 *   builder's project roles stay roles/logging.logWriter alone. When the
 *   bucket is absent, OPS-2 creates it (uniform bucket-level access, public
 *   access prevention enforced, the plane's region) and defers the binding
 *   (BUILD_SOURCE_BUCKET_ABSENT) to the next pass, which reads the bucket
 *   back as the project's own before binding on it.
 * - OPS-10's build verb (gcp-production-rollout.mjs, which must not import the
 *   manifest statically) passes --gcs-source-staging-dir=gs://<bucket>/source
 *   explicitly, so the bucket the build stages into is the bucket granted.
 *   With an explicit staging dir gcloud neither checks the bucket's owner nor
 *   refuses an absent one (it creates it with its own defaults), so the build
 *   verb reads the bucket first and refuses one that is absent, another
 *   project's, public, or not readable by the builder.
 *
 * One definition for both, so the bucket OPS-2 grants on and the bucket
 * OPS-10 stages into cannot differ. A leaf module: no imports, no I/O.
 */

/** The suffix gcloud gives a project's default Cloud Build bucket. */
export const BUILD_SOURCE_BUCKET_SUFFIX = "_cloudbuild";

/** The object prefix the build stages its source archive under. */
export const BUILD_SOURCE_OBJECT_PREFIX = "source/";

/** The builder's one role on the bucket: read (get and list) its objects, nothing else. */
export const BUILD_SOURCE_READER_ROLE = "roles/storage.objectViewer";

/** The deferral (and readback finding) while the bucket does not exist yet. */
export const BUILD_SOURCE_BUCKET_ABSENT = "BUILD_SOURCE_BUCKET_ABSENT";

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const PUBLIC_MEMBERS = Object.freeze(["allUsers", "allAuthenticatedUsers"]);

/** `<project>_cloudbuild` for a project id, or null for anything that is not one. */
export function buildSourceBucketName(project) {
  return typeof project === "string" && PROJECT.test(project) ? `${project}${BUILD_SOURCE_BUCKET_SUFFIX}` : null;
}

/** The --gcs-source-staging-dir value for a project: gs://<project>_cloudbuild/source. */
export function buildSourceStagingDir(project) {
  const bucket = buildSourceBucketName(project);
  return bucket === null ? null : `gs://${bucket}/${BUILD_SOURCE_OBJECT_PREFIX.slice(0, -1)}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What stops a build from reading its source through a bucket IAM policy
 * (`gcloud storage buckets get-iam-policy --format=json`), sorted; empty when
 * usable: READER_BINDING_MISSING unless `builderMember` holds
 * BUILD_SOURCE_READER_ROLE unconditionally, PUBLIC_MEMBER when any binding
 * names allUsers or allAuthenticatedUsers, POLICY_INVALID for anything that
 * is not a policy. Broader roles and extra members are OPS-2 readback's
 * drift, not a build's.
 */
export function buildSourcePolicyProblems(policy, builderMember) {
  if (!isRecord(policy) || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) return ["POLICY_INVALID"];
  const bindings = (policy.bindings ?? []).filter(isRecord);
  const problems = [];
  if (!bindings.some((binding) => binding.role === BUILD_SOURCE_READER_ROLE
      && (binding.condition === undefined || binding.condition === null)
      && Array.isArray(binding.members) && binding.members.includes(builderMember))) {
    problems.push("READER_BINDING_MISSING");
  }
  if (bindings.some((binding) => Array.isArray(binding.members)
      && binding.members.some((member) => PUBLIC_MEMBERS.includes(member)))) {
    problems.push("PUBLIC_MEMBER");
  }
  return problems.sort();
}
