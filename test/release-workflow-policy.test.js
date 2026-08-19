import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  checkReleaseWorkflowPolicy,
  inspectWorkflowSource,
} from "../scripts/check-release-workflow-policy.mjs";

test("checked-in GitHub workflows pin actions and avoid unsafe release triggers", async () => {
  const result = await checkReleaseWorkflowPolicy();
  assert.ok(result.files.includes(".github/workflows/osv-scanner.yml"));
  assert.ok(result.files.includes(".github/workflows/windows-portability.yml"));
});

test("setup-node never initializes a package-manager cache before pnpm exists", async () => {
  for (const workflowPath of [
    ".github/workflows/release-trust-policy.yml",
    ".github/workflows/windows-portability.yml",
  ]) {
    const workflow = await readFile(new URL(`../${workflowPath}`, import.meta.url), "utf8");
    const setupNodeSteps = workflow.split(/\n\s+- name:/u)
      .filter((step) => step.includes("actions/setup-node@"));
    assert.ok(setupNodeSteps.length > 0, `${workflowPath} must configure setup-node`);
    for (const step of setupNodeSteps) {
      assert.match(step, /^\s*package-manager-cache:\s*false\s*$/mu,
        `${workflowPath} must disable setup-node's pre-pnpm automatic cache`);
    }
  }
});

test("workflow policy accepts local actions and full immutable action SHAs", () => {
  assert.deepEqual(inspectWorkflowSource(`
steps:
  - uses: ./\n  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
    with:
      persist-credentials: false
`), []);
});

test("workflow policy requires checkout steps to disable credential persistence explicitly", () => {
  const failures = inspectWorkflowSource(`
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
`, { path: ".github/workflows/checkout-bypass.yml" });
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("persist-credentials explicitly to false"));

  const envBypass = inspectWorkflowSource(`
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
    env:
      persist-credentials: false
`, { path: ".github/workflows/checkout-env-bypass.yml" });
  assert.equal(envBypass.length, 1);
  assert.ok(envBypass[0].includes("persist-credentials explicitly to false"));
});

test("workflow policy rejects mutable actions, dangerous triggers, credentials, and persistent runners", () => {
  const failures = inspectWorkflowSource(`
on:
  pull_request_target:
jobs:
  release:
    runs-on: [self-hosted, macOS]
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: true
`, { path: ".github/workflows/release.yml" });

  assert.equal(failures.length, 4);
  assert.ok(failures.some((failure) => failure.includes("full commit SHA")));
  assert.ok(failures.some((failure) => failure.includes("pull_request_target")));
  assert.ok(failures.some((failure) => failure.includes("must not persist")));
  assert.ok(failures.some((failure) => failure.includes("self-hosted")));
});

test("workflow policy rejects quoted keys, uppercase booleans, and multiline self-hosted arrays", () => {
  const failures = inspectWorkflowSource(`
"on":
  "pull_request_target": {}
jobs:
  release:
    "runs-on":
      - "self-hosted"
      - macOS
    steps:
      - "uses": "actions/checkout@v5"
        with:
          "persist-credentials": TRUE
`, { path: ".github/workflows/bypass.yml" });

  assert.equal(failures.length, 4);
  assert.ok(failures.some((failure) => failure.includes("pull_request_target")));
  assert.ok(failures.some((failure) => failure.includes("self-hosted")));
  assert.ok(failures.some((failure) => failure.includes("full commit SHA")));
  assert.ok(failures.some((failure) => failure.includes("must not persist")));
});

test("workflow policy parses quoted immutable actions and ignores hash characters in quotes", () => {
  assert.deepEqual(inspectWorkflowSource(`
steps:
  - 'uses': 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'
    with:
      'persist-credentials': 'FALSE' # this # is part of the comment
  - uses: "./.github/actions/local#action"
`), []);
});

test("workflow policy allows only static GitHub-hosted runner labels", () => {
  assert.deepEqual(inspectWorkflowSource(`
jobs:
  linux:
    runs-on: ubuntu-24.04
  windows:
    runs-on: "windows-2025"
  macos:
    runs-on: [macos-14]
`), []);

  const failures = inspectWorkflowSource(`
on: { pull_request_target: {} }
jobs:
  custom:
    runs-on: ubuntu-custom
  arbitrary:
    runs-on: organization-large-runner
  dynamic:
    runs-on: \${{ matrix.runner }}
`, { path: ".github/workflows/runner-bypass.yml" });
  assert.equal(failures.length, 4);
  assert.equal(failures.filter((failure) => failure.includes("pull_request_target")).length, 1);
  assert.equal(failures.filter((failure) => failure.includes("one static")).length, 2);
  assert.equal(failures.filter((failure) => failure.includes("static GitHub-hosted")).length, 1);
});

test("workflow policy rejects flow-style sensitive mappings instead of parsing them as trusted", () => {
  const failures = inspectWorkflowSource(`
jobs: { release: { "runs-on": ubuntu-24.04, steps: [{ "uses": actions/checkout@v5, "with": { "persist-credentials": true } }] } }
`, { path: ".github/workflows/flow-bypass.yml" });
  assert.equal(failures.length, 3);
  assert.ok(failures.some((failure) => failure.includes("runs-on")));
  assert.ok(failures.some((failure) => failure.includes("uses")));
  assert.ok(failures.some((failure) => failure.includes("persist-credentials")));

  const triggerFailures = inspectWorkflowSource(
    "on: [push, pull_request_target]",
    { path: ".github/workflows/flow-trigger-bypass.yml" },
  );
  assert.equal(triggerFailures.length, 1);
  assert.ok(triggerFailures[0].includes("pull_request_target"));
});
