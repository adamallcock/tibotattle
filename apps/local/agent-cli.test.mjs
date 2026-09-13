import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLED_AGENT_ERROR_SCHEMA_VERSION,
  INSTALLED_AGENT_PROTOCOL_VERSION,
  INSTALLED_AGENT_STATUS_SCHEMA_VERSION,
  executeInstalledAgentCommand,
  installedAgentErrorResult,
  isInstalledAgentInvocation,
  parseInstalledAgentArgs,
  runInstalledAgentCli,
} from "./agent-cli.js";

function explainerFixture(calls = []) {
  return {
    async query(request) {
      calls.push(["query", request]);
      return { schemaVersion: "local-usage-explainer-v1", status: "available", request };
    },
    async evidence(request) {
      calls.push(["evidence", request]);
      return { schemaVersion: "local-usage-explainer-v1", status: "available", request };
    },
  };
}

test("installed agent invocation is reserved and protocol-versioned", () => {
  assert.equal(isInstalledAgentInvocation(["--agent-protocol", "1", "status"]), true);
  assert.equal(isInstalledAgentInvocation([]), false);
  assert.throws(
    () => parseInstalledAgentArgs(["--agent-protocol", "2", "status"]),
    (error) => error.code === "installed_agent_protocol_unsupported",
  );
  assert.throws(
    () => parseInstalledAgentArgs(["--agent-protocol", "1", "status", "--selector", "opaque"]),
    (error) => error.code === "installed_agent_option_out_of_scope",
  );
  assert.throws(
    () => parseInstalledAgentArgs(["--agent-protocol", "1", "explain-usage", "--plan", "arbitrary"]),
    (error) => error.code === "installed_agent_plan_unsupported",
  );
  assert.throws(
    () => parseInstalledAgentArgs([
      "--agent-protocol", "1", "explain-usage-evidence", "--selector", "x".repeat(241),
    ]),
    (error) => error.code === "installed_agent_selector_invalid",
  );
});

test("installed status exposes protocol compatibility and explicit data health", async () => {
  const calls = [];
  const result = await executeInstalledAgentCommand([
    "--agent-protocol", String(INSTALLED_AGENT_PROTOCOL_VERSION), "status",
  ], {
    releaseVersion: "9.8.7",
    createUsageExplainer: () => explainerFixture(calls),
  });
  assert.equal(result.schemaVersion, INSTALLED_AGENT_STATUS_SCHEMA_VERSION);
  assert.equal(result.releaseVersion, "9.8.7");
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.dataHealth.status, "available");
  assert.equal(calls[0][1].plan, "data_health");
});

test("installed query and evidence forward only the closed structured contract", async () => {
  const calls = [];
  const createUsageExplainer = () => explainerFixture(calls);
  await executeInstalledAgentCommand([
    "--agent-protocol", "1", "explain-usage",
    "--plan", "top_work",
    "--period", "30d",
    "--limit", "4",
    "--cursor", "opaque-cursor",
  ], { createUsageExplainer });
  await executeInstalledAgentCommand([
    "--agent-protocol", "1", "explain-usage-evidence",
    "--selector", "opaque-selector",
  ], { createUsageExplainer });
  assert.deepEqual(calls.map(([kind]) => kind), ["query", "evidence"]);
  assert.deepEqual(calls[0][1], {
    schemaVersion: "local-usage-explainer-v1",
    plan: "top_work",
    period: "30d",
    limit: 4,
    cursor: "opaque-cursor",
  });
  assert.equal(calls[1][1].selector, "opaque-selector");
});

test("installed plan catalog does not open local data", async () => {
  let opened = false;
  const result = await executeInstalledAgentCommand([
    "--agent-protocol", "1", "explain-usage-plans",
  ], {
    createUsageExplainer() {
      opened = true;
      return explainerFixture();
    },
  });
  assert.equal(result.plans.length, 8);
  assert.equal(opened, false);
});

test("installed agent writes one JSON record and sanitizes unexpected errors", async () => {
  const chunks = [];
  await runInstalledAgentCli([
    "--agent-protocol", "1", "explain-usage-plans",
  ], { output: { write: (chunk) => chunks.push(chunk) } });
  assert.equal(chunks.length, 1);
  assert.equal(JSON.parse(chunks[0]).plans.length, 8);

  const failure = installedAgentErrorResult(new Error("/private/sensitive/path"));
  assert.equal(failure.schemaVersion, INSTALLED_AGENT_ERROR_SCHEMA_VERSION);
  assert.equal(failure.errorCode, "installed_agent_internal_error");
  assert.doesNotMatch(JSON.stringify(failure), /sensitive/u);
});
