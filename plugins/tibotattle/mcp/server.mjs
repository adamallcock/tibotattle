#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createInstalledAgentClient, TiboTattlePluginError } from "../lib/installed-agent.mjs";
import { createInstallationController } from "../lib/installation.mjs";

const SERVER_VERSION = "0.1.0";
const MAX_REQUEST_BYTES = 128 * 1024;
const PLUGIN_ERROR_SCHEMA_VERSION = "tibotattle-plugin-error-v1";
const PLANS = [
  "data_health",
  "current_usage",
  "top_work",
  "period_drivers",
  "model_effort_mix",
  "pricing_coverage",
  "parent_subworker_usage",
  "allowance_movement",
];

const NO_INPUT = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
});

export const TIBOTATTLE_TOOLS = Object.freeze([
  {
    name: "tibotattle_status",
    description: "Check whether a compatible TiboTattle app is installed and whether its local usage evidence is available.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "tibotattle_list_plans",
    description: "List TiboTattle's deterministic usage-analysis plans, limits, pagination contract, and prohibited claims.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "tibotattle_explain_usage",
    description: "Run one bounded, content-free TiboTattle usage analysis. Reuse an opaque nextCursor unchanged to request another page.",
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: { type: "string", enum: PLANS },
        period: { type: "string", enum: ["24h", "7d", "30d", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        cursor: { type: "string", minLength: 1, maxLength: 240 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "tibotattle_get_evidence",
    description: "Resolve one opaque TiboTattle evidence selector from a prior result without revealing prompts, commands, paths, or identities.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 240 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "tibotattle_install_plan",
    description: "Prepare an exact, expiring plan for installing or upgrading a compatible TiboTattle release. This reads public release metadata but does not install anything.",
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "tibotattle_install",
    description: "Install or upgrade TiboTattle with Homebrew using an unchanged confirmation token from tibotattle_install_plan. Call only after the user explicitly confirms that exact plan.",
    inputSchema: {
      type: "object",
      required: ["confirmationToken"],
      properties: {
        confirmationToken: { type: "string", minLength: 32, maxLength: 128 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]);

function errorResult(error) {
  const known = error instanceof TiboTattlePluginError;
  const result = {
    schemaVersion: PLUGIN_ERROR_SCHEMA_VERSION,
    status: "unavailable",
    errorCode: known ? error.code : "tibotattle_plugin_internal_error",
    message: known ? error.message : "The TiboTattle plugin operation failed",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

function successResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function exactInput(input, allowed, required = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TiboTattlePluginError("tibotattle_tool_input_invalid", "Tool input must be an object");
  }
  if (Object.keys(input).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(input, key))) {
    throw new TiboTattlePluginError("tibotattle_tool_input_invalid", "Tool input does not match the closed contract");
  }
  return input;
}

function validateQueryInput(raw) {
  const input = exactInput(raw, ["plan", "period", "limit", "cursor"], ["plan"]);
  if (!PLANS.includes(input.plan)
      || (input.period !== undefined && !["24h", "7d", "30d", "all"].includes(input.period))
      || (input.limit !== undefined
        && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25))
      || (input.cursor !== undefined
        && (typeof input.cursor !== "string" || input.cursor.length < 1 || input.cursor.length > 240))) {
    throw new TiboTattlePluginError("tibotattle_tool_input_invalid", "Usage query input is invalid");
  }
  return input;
}

export function createToolRouter({ client, installer } = {}) {
  if (client === undefined || installer === undefined) {
    throw new TypeError("client and installer are required");
  }
  return async function callTool(name, rawInput = {}) {
    try {
      if (name === "tibotattle_status") {
        exactInput(rawInput, []);
        return successResult(await client.status());
      }
      if (name === "tibotattle_list_plans") {
        exactInput(rawInput, []);
        return successResult(await client.invoke("explain-usage-plans"));
      }
      if (name === "tibotattle_explain_usage") {
        return successResult(await client.invoke("explain-usage", validateQueryInput(rawInput)));
      }
      if (name === "tibotattle_get_evidence") {
        const input = exactInput(rawInput, ["selector"], ["selector"]);
        if (typeof input.selector !== "string"
            || input.selector.length < 1
            || input.selector.length > 240) {
          throw new TiboTattlePluginError("tibotattle_tool_input_invalid", "Evidence selector is invalid");
        }
        return successResult(await client.invoke("explain-usage-evidence", input));
      }
      if (name === "tibotattle_install_plan") {
        exactInput(rawInput, []);
        return successResult(await installer.plan());
      }
      if (name === "tibotattle_install") {
        const input = exactInput(rawInput, ["confirmationToken"], ["confirmationToken"]);
        if (typeof input.confirmationToken !== "string") {
          throw new TiboTattlePluginError("tibotattle_tool_input_invalid", "Install confirmation is invalid");
        }
        return successResult(await installer.install(input));
      }
      throw new TiboTattlePluginError(
        "tibotattle_tool_unsupported",
        "The requested TiboTattle tool is unsupported",
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createMcpRequestHandler({ callTool } = {}) {
  if (typeof callTool !== "function") throw new TypeError("callTool is required");
  return async function handle(request) {
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tibotattle", version: SERVER_VERSION },
        },
      };
    }
    if (request.method === "ping") {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: request.id, result: { tools: TIBOTATTLE_TOOLS } };
    }
    if (request.method === "tools/call") {
      const result = await callTool(request.params?.name, request.params?.arguments ?? {});
      return { jsonrpc: "2.0", id: request.id, result };
    }
    if (request.method.startsWith("notifications/")) return null;
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  };
}

export async function runStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const client = createInstalledAgentClient();
  const installer = createInstallationController({ client });
  const handle = createMcpRequestHandler({ callTool: createToolRouter({ client, installer }) });
  input.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES && !buffer.includes("\n")) {
      throw new Error("MCP request exceeds the size limit");
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let response;
      try {
        if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) throw new Error();
        response = await handle(JSON.parse(line));
      } catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runStdioServer().catch(() => {
    process.exitCode = 1;
  });
}
