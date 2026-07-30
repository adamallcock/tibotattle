import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyIamPolicies,
} from "../scripts/verify-iam.mjs";

const serviceAccount =
  "usage-monitor-runtime@private-project.iam.gserviceaccount.com";

function policies() {
  return {
    serviceAccount,
    runPolicy: {
      bindings: [{
        role: "roles/run.invoker",
        members: ["serviceAccount:private-caller@private-project.iam.gserviceaccount.com"],
      }],
    },
    bucketPolicy: {
      bindings: [{
        role: "roles/storage.objectUser",
        members: [`serviceAccount:${serviceAccount}`],
      }],
    },
    projectPolicy: {
      bindings: [{
        role: "roles/viewer",
        members: ["user:operator@example.invalid"],
      }],
    },
  };
}

test("IAM verification requires private invocation and bucket-only runtime access", () => {
  const selected = policies();
  selected.runPolicy = {};
  assert.deepEqual(verifyIamPolicies(selected), {
    schemaVersion: "contained-gcp-iam-verification-v0.1",
    status: "passed",
    service: "app-usagemonitor-contained",
    directPublicInvoker: false,
    directBucketPublicAccess: false,
    directProjectPublicAccess: false,
    bucketRuntimeRole: "roles/storage.objectUser",
    directProjectRuntimeRoles: 0,
  });
});

test("IAM verification rejects public, conditional, and project-wide access", () => {
  const publicRun = policies();
  publicRun.runPolicy.bindings[0].members.push("allUsers");
  assert.throws(
    () => verifyIamPolicies(publicRun),
    (error) => error.code === "public_access_detected",
  );

  const publicProject = policies();
  publicProject.projectPolicy.bindings.push({
    role: "roles/run.invoker",
    members: ["allAuthenticatedUsers"],
  });
  assert.throws(
    () => verifyIamPolicies(publicProject),
    (error) => error.code === "public_access_detected",
  );

  const conditionalBucket = policies();
  conditionalBucket.bucketPolicy.bindings[0].condition = {
    title: "unreviewed",
    expression: "true",
  };
  assert.throws(
    () => verifyIamPolicies(conditionalBucket),
    (error) => error.code === "bucket_scope_invalid",
  );

  const broadProject = policies();
  broadProject.projectPolicy.bindings.push({
    role: "roles/storage.admin",
    members: [`serviceAccount:${serviceAccount}`],
  });
  assert.throws(
    () => verifyIamPolicies(broadProject),
    (error) => error.code === "project_scope_too_broad",
  );
});
