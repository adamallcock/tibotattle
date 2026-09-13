import { RELEASE_VERSION } from "../../config/release-manifest.js";
import {
  USAGE_EXPLAINER_SCHEMA_VERSION,
  usageExplanationCatalog,
} from "../../src/application/index.js";
import { createLocalUsageExplainer } from "../../src/local-usage-explainer.js";

export const INSTALLED_AGENT_PROTOCOL_VERSION = 1;
export const INSTALLED_AGENT_STATUS_SCHEMA_VERSION =
  "tibotattle-installed-agent-status-v1";
export const INSTALLED_AGENT_ERROR_SCHEMA_VERSION =
  "tibotattle-installed-agent-error-v1";

const COMMANDS = Object.freeze([
  "status",
  "explain-usage-plans",
  "explain-usage",
  "explain-usage-evidence",
]);
const PLAN_NAMES = new Set(usageExplanationCatalog().plans.map(({ id }) => id));
const PERIODS = new Set(["24h", "7d", "30d", "all"]);
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_OPTION_BYTES = 16 * 1024;

export class InstalledAgentCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InstalledAgentCliError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InstalledAgentCliError(code, message);
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail("installed_agent_option_missing", `${option} requires a value`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_OPTION_BYTES) {
    fail("installed_agent_option_too_large", `${option} exceeds the size limit`);
  }
  return value;
}

function readPositiveInteger(argv, index, option) {
  const value = Number(readOptionValue(argv, index, option));
  if (!Number.isSafeInteger(value) || value < 1 || value > 25) {
    fail("installed_agent_option_invalid", `${option} must be an integer from 1 to 25`);
  }
  return value;
}

export function isInstalledAgentInvocation(argv) {
  return Array.isArray(argv) && argv[0] === "--agent-protocol";
}

export function parseInstalledAgentArgs(argv) {
  if (!Array.isArray(argv)
      || argv.some((value) => typeof value !== "string")
      || Buffer.byteLength(argv.join("\0"), "utf8") > MAX_ARGUMENT_BYTES) {
    fail("installed_agent_arguments_invalid", "Agent arguments are invalid");
  }
  if (argv[0] !== "--agent-protocol") {
    fail("installed_agent_protocol_required", "The installed agent protocol is required");
  }
  if (argv[1] !== String(INSTALLED_AGENT_PROTOCOL_VERSION)) {
    fail("installed_agent_protocol_unsupported", "The installed agent protocol is unsupported");
  }
  const command = argv[2];
  if (!COMMANDS.includes(command)) {
    fail("installed_agent_command_unsupported", "The installed agent command is unsupported");
  }

  const result = {
    command,
    plan: null,
    period: null,
    limit: null,
    cursor: null,
    selector: null,
  };
  for (let index = 3; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--plan") result.plan = readOptionValue(argv, index++, option);
    else if (option === "--period") result.period = readOptionValue(argv, index++, option);
    else if (option === "--limit") result.limit = readPositiveInteger(argv, index++, option);
    else if (option === "--cursor") result.cursor = readOptionValue(argv, index++, option);
    else if (option === "--selector") result.selector = readOptionValue(argv, index++, option);
    else fail("installed_agent_option_unsupported", "The installed agent option is unsupported");
  }

  if (result.period !== null && !PERIODS.has(result.period)) {
    fail("installed_agent_period_unsupported", "The usage period is unsupported");
  }
  if (result.plan !== null && !PLAN_NAMES.has(result.plan)) {
    fail("installed_agent_plan_unsupported", "The usage plan is unsupported");
  }
  if (result.cursor !== null && result.cursor.length > 240) {
    fail("installed_agent_cursor_invalid", "The usage cursor is invalid");
  }
  if (result.selector !== null && result.selector.length > 240) {
    fail("installed_agent_selector_invalid", "The evidence selector is invalid");
  }
  const query = command === "explain-usage";
  const evidence = command === "explain-usage-evidence";
  if (query && result.plan === null) {
    fail("installed_agent_plan_required", "explain-usage requires --plan");
  }
  if (evidence && result.selector === null) {
    fail("installed_agent_selector_required", "explain-usage-evidence requires --selector");
  }
  if (!query && [result.plan, result.period, result.limit, result.cursor].some(
    (value) => value !== null,
  )) {
    fail("installed_agent_option_out_of_scope", "Query options require explain-usage");
  }
  if (!evidence && result.selector !== null) {
    fail("installed_agent_option_out_of_scope", "--selector requires explain-usage-evidence");
  }
  return Object.freeze(result);
}

export function installedAgentErrorResult(error) {
  const known = error instanceof InstalledAgentCliError;
  return {
    schemaVersion: INSTALLED_AGENT_ERROR_SCHEMA_VERSION,
    status: "unavailable",
    errorCode: known ? error.code : "installed_agent_internal_error",
    message: known ? error.message : "The installed agent command failed",
  };
}

export async function executeInstalledAgentCommand(
  argv,
  {
    createUsageExplainer = createLocalUsageExplainer,
    releaseVersion = RELEASE_VERSION,
  } = {},
) {
  const args = parseInstalledAgentArgs(argv);
  if (args.command === "explain-usage-plans") return usageExplanationCatalog();

  const explainer = createUsageExplainer();
  if (args.command === "status") {
    const dataHealth = await explainer.query({
      schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
      plan: "data_health",
      period: "7d",
      limit: 1,
    });
    return {
      schemaVersion: INSTALLED_AGENT_STATUS_SCHEMA_VERSION,
      status: "available",
      product: "TiboTattle",
      releaseVersion,
      protocolVersion: INSTALLED_AGENT_PROTOCOL_VERSION,
      capabilities: [...COMMANDS],
      dataHealth,
    };
  }
  if (args.command === "explain-usage") {
    const request = {
      schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
      plan: args.plan,
      period: args.period ?? "7d",
      limit: args.limit ?? 10,
    };
    if (args.cursor !== null) request.cursor = args.cursor;
    return explainer.query(request);
  }
  return explainer.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: args.selector,
  });
}

export async function runInstalledAgentCli(
  argv,
  {
    output = process.stdout,
    ...options
  } = {},
) {
  const result = await executeInstalledAgentCommand(argv, options);
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}
