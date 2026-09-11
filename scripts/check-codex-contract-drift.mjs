#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "../packages/telemetry-contract/src/constants.js";

const execFile = promisify(execFileCallback);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const CODEX_CONTRACT_LEDGER_VERSION = "codex-contract-ledger-v0.1";
export const CODEX_CONTRACT_REPORT_VERSION = "codex-contract-drift-report-v0.1";
export const DEFAULT_CODEX_CONTRACT_LEDGER = join(
  REPOSITORY_ROOT,
  "config",
  "codex-contract-ledger.json",
);

const EXPECTED_SOURCE = Object.freeze({
  branch: "main",
  path: "codex-rs/protocol/src/auth.rs",
  repository: "openai/codex",
});
const ALLOWED_PLAN_LIFECYCLES = new Set(["active", "deprecated"]);
const ALLOWED_SEAT_MAPPING_STATUSES = new Set([
  "rejected",
  "unverified_candidate",
  "verified",
]);
const PLAN_VALUE_RE = /^[a-z0-9_]+$/u;
const CHANNEL_ID_RE = /^[a-z][a-z0-9_]*$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_REVISION_RE = /^[0-9a-f]{40}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_VERSION_RE = /^codex-cli [0-9A-Za-z][0-9A-Za-z.+-]{0,119}$/u;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_GENERATED_FILE_BYTES = 1_048_576;
const EXECUTION_TIMEOUT_MS = 60_000;
const EXECUTION_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export class CodexContractError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = "CodexContractError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined, options = undefined) {
  throw new CodexContractError(code, message, details, options);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", `${label} must be an object`);
  }
  return value;
}

function requireBoundedString(value, label, {
  maxLength = 240,
  pattern = null,
} = {}) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > maxLength
      || /[\u0000-\u001f\u007f]/u.test(value)
      || (pattern !== null && !pattern.test(value))) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", `${label} is invalid`);
  }
  return value;
}

function requireStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", `${label} must be an array`);
  }
  return value.map((entry, index) => requireBoundedString(
    entry,
    `${label}[${index}]`,
    { maxLength: 500 },
  ));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function planTypesSha256(planTypes) {
  return sha256(JSON.stringify([...planTypes].sort()));
}

export function planPairsSha256(planPairs) {
  return sha256(JSON.stringify(
    [...planPairs]
      .map(({ rawValue, displayName }) => [rawValue, displayName])
      .sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function issue(code, message, details = undefined) {
  return details === undefined ? { code, message } : { code, message, details };
}

export function validateCodexContractLedger(value) {
  const ledger = requirePlainObject(value, "ledger");
  if (ledger.schemaVersion !== CODEX_CONTRACT_LEDGER_VERSION) {
    fail(
      "CODEX_CONTRACT_LEDGER_INVALID",
      `Unsupported ledger schemaVersion: ${String(ledger.schemaVersion)}`,
    );
  }

  const source = requirePlainObject(ledger.source, "ledger.source");
  for (const [key, expected] of Object.entries(EXPECTED_SOURCE)) {
    if (source[key] !== expected) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `ledger.source.${key} must remain ${expected}`,
      );
    }
  }
  requireBoundedString(source.reviewedRevision, "ledger.source.reviewedRevision", {
    pattern: GIT_REVISION_RE,
  });
  requireBoundedString(source.reviewedOn, "ledger.source.reviewedOn", {
    pattern: ISO_DATE_RE,
  });
  requireBoundedString(source.sourceSha256, "ledger.source.sourceSha256", {
    pattern: SHA256_RE,
  });

  if (!Array.isArray(ledger.binaryChannels) || ledger.binaryChannels.length === 0) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", "ledger.binaryChannels must not be empty");
  }
  const channelIds = new Set();
  for (const [index, rawChannel] of ledger.binaryChannels.entries()) {
    const channel = requirePlainObject(rawChannel, `ledger.binaryChannels[${index}]`);
    const channelId = requireBoundedString(
      channel.id,
      `ledger.binaryChannels[${index}].id`,
      { pattern: CHANNEL_ID_RE },
    );
    requireBoundedString(
      channel.locator,
      `ledger.binaryChannels[${index}].locator`,
      { maxLength: 240 },
    );
    if (channelIds.has(channelId)) {
      fail("CODEX_CONTRACT_LEDGER_INVALID", `Duplicate binary channel: ${channelId}`);
    }
    channelIds.add(channelId);
  }

  if (!Array.isArray(ledger.plans) || ledger.plans.length === 0) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", "ledger.plans must not be empty");
  }
  const planValues = new Set();
  for (const [index, rawPlan] of ledger.plans.entries()) {
    const plan = requirePlainObject(rawPlan, `ledger.plans[${index}]`);
    const rawValue = requireBoundedString(plan.rawValue, `ledger.plans[${index}].rawValue`, {
      pattern: PLAN_VALUE_RE,
    });
    if (rawValue === "unknown") {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        "unknown is a fail-closed product sentinel, not a named plan entry",
      );
    }
    if (planValues.has(rawValue)) {
      fail("CODEX_CONTRACT_LEDGER_INVALID", `Duplicate plan rawValue: ${rawValue}`);
    }
    planValues.add(rawValue);
    requireBoundedString(plan.displayName, `ledger.plans[${index}].displayName`, {
      maxLength: 100,
    });
    if (!ALLOWED_PLAN_LIFECYCLES.has(plan.lifecycle)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Unsupported lifecycle for ${rawValue}: ${String(plan.lifecycle)}`,
      );
    }
    requireBoundedString(
      plan.firstReviewedOn,
      `ledger.plans[${index}].firstReviewedOn`,
      { pattern: ISO_DATE_RE },
    );
    if (plan.lifecycle === "deprecated") {
      requireBoundedString(
        plan.deprecatedOn,
        `ledger.plans[${index}].deprecatedOn`,
        { pattern: ISO_DATE_RE },
      );
    }
  }

  if (!Array.isArray(ledger.marketingSeats) || ledger.marketingSeats.length === 0) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", "ledger.marketingSeats must not be empty");
  }
  const marketingSeatIds = new Set();
  for (const [index, rawSeat] of ledger.marketingSeats.entries()) {
    const seat = requirePlainObject(rawSeat, `ledger.marketingSeats[${index}]`);
    const seatId = requireBoundedString(seat.id, `ledger.marketingSeats[${index}].id`, {
      pattern: /^[a-z][a-z0-9-]*$/u,
    });
    if (marketingSeatIds.has(seatId)) {
      fail("CODEX_CONTRACT_LEDGER_INVALID", `Duplicate marketing seat id: ${seatId}`);
    }
    marketingSeatIds.add(seatId);
    requireBoundedString(
      seat.product,
      `ledger.marketingSeats[${index}].product`,
      { pattern: PLAN_VALUE_RE },
    );
    requireBoundedString(
      seat.displayName,
      `ledger.marketingSeats[${index}].displayName`,
      { maxLength: 100 },
    );
    if (!ALLOWED_PLAN_LIFECYCLES.has(seat.lifecycle)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Unsupported lifecycle for marketing seat ${seatId}: ${String(seat.lifecycle)}`,
      );
    }
    requireBoundedString(
      seat.firstReviewedOn,
      `ledger.marketingSeats[${index}].firstReviewedOn`,
      { pattern: ISO_DATE_RE },
    );
    requireStringArray(
      seat.nameEvidence,
      `ledger.marketingSeats[${index}].nameEvidence`,
      { allowEmpty: false },
    );
  }

  if (!Array.isArray(ledger.seatMappings)) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", "ledger.seatMappings must be an array");
  }
  const mappingIds = new Set();
  for (const [index, rawMapping] of ledger.seatMappings.entries()) {
    const mapping = requirePlainObject(rawMapping, `ledger.seatMappings[${index}]`);
    const mappingId = requireBoundedString(mapping.id, `ledger.seatMappings[${index}].id`, {
      pattern: /^[a-z][a-z0-9-]*$/u,
    });
    if (mappingIds.has(mappingId)) {
      fail("CODEX_CONTRACT_LEDGER_INVALID", `Duplicate seat mapping id: ${mappingId}`);
    }
    mappingIds.add(mappingId);
    const wirePlanType = requireBoundedString(
      mapping.wirePlanType,
      `ledger.seatMappings[${index}].wirePlanType`,
      { pattern: PLAN_VALUE_RE },
    );
    if (!planValues.has(wirePlanType)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Seat mapping ${mappingId} references unknown plan ${wirePlanType}`,
      );
    }
    const marketingSeatId = requireBoundedString(
      mapping.marketingSeatId,
      `ledger.seatMappings[${index}].marketingSeatId`,
      { pattern: /^[a-z][a-z0-9-]*$/u },
    );
    if (!marketingSeatIds.has(marketingSeatId)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Seat mapping ${mappingId} references unknown marketing seat ${marketingSeatId}`,
      );
    }
    if (!ALLOWED_SEAT_MAPPING_STATUSES.has(mapping.status)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Unsupported seat mapping status for ${mappingId}: ${String(mapping.status)}`,
      );
    }
    const mappingEvidence = requireStringArray(
      mapping.mappingEvidence,
      `ledger.seatMappings[${index}].mappingEvidence`,
    );
    if (mapping.status === "verified" && mappingEvidence.length === 0) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Verified seat mapping ${mappingId} requires mapping evidence`,
      );
    }
    requireBoundedString(mapping.note, `ledger.seatMappings[${index}].note`, {
      maxLength: 500,
    });
  }

  if (!Array.isArray(ledger.verifiedContracts)) {
    fail("CODEX_CONTRACT_LEDGER_INVALID", "ledger.verifiedContracts must be an array");
  }
  const contractKeys = new Set();
  for (const [index, rawContract] of ledger.verifiedContracts.entries()) {
    const contract = requirePlainObject(
      rawContract,
      `ledger.verifiedContracts[${index}]`,
    );
    const channel = requireBoundedString(
      contract.channel,
      `ledger.verifiedContracts[${index}].channel`,
      { pattern: CHANNEL_ID_RE },
    );
    if (!channelIds.has(channel)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Verified contract references unknown channel: ${channel}`,
      );
    }
    const version = requireBoundedString(
      contract.version,
      `ledger.verifiedContracts[${index}].version`,
      { pattern: SAFE_VERSION_RE },
    );
    requireBoundedString(
      contract.verifiedOn,
      `ledger.verifiedContracts[${index}].verifiedOn`,
      { pattern: ISO_DATE_RE },
    );
    requireBoundedString(
      contract.planTypesSha256,
      `ledger.verifiedContracts[${index}].planTypesSha256`,
      { pattern: SHA256_RE },
    );
    const key = `${channel}\0${version}`;
    if (contractKeys.has(key)) {
      fail(
        "CODEX_CONTRACT_LEDGER_INVALID",
        `Duplicate verified contract for ${channel} ${version}`,
      );
    }
    contractKeys.add(key);
  }

  return ledger;
}

export function compareProductPlanRegistry(
  ledger,
  {
    planDisplayNames = TELEMETRY_PLAN_DISPLAY_NAMES,
    planTypes = TELEMETRY_PLAN_TYPES,
  } = {},
) {
  const issues = [];
  const productValues = new Set();
  for (const rawValue of planTypes) {
    if (productValues.has(rawValue)) {
      issues.push(issue(
        "product_duplicate_plan",
        `Product registry repeats ${rawValue}`,
      ));
    }
    productValues.add(rawValue);
  }
  if (!productValues.has("unknown")) {
    issues.push(issue(
      "product_unknown_sentinel_missing",
      "Product registry must retain the unknown sentinel",
    ));
  }
  if (Object.hasOwn(planDisplayNames, "unknown")) {
    issues.push(issue(
      "product_unknown_display_name",
      "The unknown sentinel must not receive a display name",
    ));
  }

  const ledgerByRaw = new Map(ledger.plans.map((plan) => [plan.rawValue, plan]));
  for (const rawValue of planTypes) {
    if (rawValue === "unknown") continue;
    const ledgerPlan = ledgerByRaw.get(rawValue);
    if (!ledgerPlan) {
      issues.push(issue(
        "product_plan_missing_from_ledger",
        `Product plan ${rawValue} is missing from the ledger`,
      ));
      continue;
    }
    if (planDisplayNames[rawValue] !== ledgerPlan.displayName) {
      issues.push(issue(
        "product_display_name_mismatch",
        `Display name mismatch for ${rawValue}`,
        {
          actual: planDisplayNames[rawValue] ?? null,
          expected: ledgerPlan.displayName,
        },
      ));
    }
  }
  for (const plan of ledger.plans) {
    if (!productValues.has(plan.rawValue)) {
      issues.push(issue(
        "ledger_plan_missing_from_product",
        `Ledger plan ${plan.rawValue} is not accepted by the product registry`,
      ));
    }
  }
  for (const rawValue of Object.keys(planDisplayNames)) {
    if (!productValues.has(rawValue)) {
      issues.push(issue(
        "product_orphan_display_name",
        `Display-name registry contains unsupported plan ${rawValue}`,
      ));
    }
  }
  return { issues, ok: issues.length === 0 };
}

function findRustFunctionBody(source, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const signature = new RegExp(
    `\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?fn\\s+${escapedName}\\s*\\(`,
    "u",
  );
  const match = signature.exec(source);
  if (!match) {
    fail(
      "CODEX_SOURCE_UNSUPPORTED",
      `Could not find KnownPlan::${functionName}() in the upstream source`,
    );
  }
  const openingBrace = source.indexOf("{", match.index + match[0].length);
  if (openingBrace < 0) {
    fail(
      "CODEX_SOURCE_UNSUPPORTED",
      `Could not find the body of KnownPlan::${functionName}()`,
    );
  }

  let depth = 0;
  let state = "code";
  let blockCommentDepth = 0;
  let rawStringTerminator = null;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line_comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block_comment") {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) state = "code";
      }
      continue;
    }
    if (state === "string" || state === "character") {
      const terminator = state === "string" ? "\"" : "'";
      if (character === "\\") {
        index += 1;
      } else if (character === terminator) {
        state = "code";
      }
      continue;
    }
    if (state === "raw_string") {
      if (source.startsWith(rawStringTerminator, index)) {
        index += rawStringTerminator.length - 1;
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line_comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block_comment";
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === "\"") {
      state = "string";
      continue;
    }
    if (character === "'") {
      state = "character";
      continue;
    }
    if (character === "r") {
      const rawMatch = source.slice(index).match(/^r(#+)?"/u);
      if (rawMatch) {
        const hashes = rawMatch[1] ?? "";
        rawStringTerminator = `\"${hashes}`;
        state = "raw_string";
        index += rawMatch[0].length - 1;
        continue;
      }
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
      if (depth < 0) break;
    }
  }
  fail(
    "CODEX_SOURCE_UNSUPPORTED",
    `Could not parse the body of KnownPlan::${functionName}()`,
  );
}

function decodeRustString(value, functionName) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (error) {
    fail(
      "CODEX_SOURCE_UNSUPPORTED",
      `KnownPlan::${functionName}() contains an unsupported string escape`,
      undefined,
      { cause: error },
    );
  }
}

function parseKnownPlanMethod(source, functionName) {
  const body = findRustFunctionBody(source, functionName);
  const armPattern = /(?:Self|KnownPlan)::([A-Za-z][A-Za-z0-9_]*)(?:\s*\([^)]*\)|\s*\{[^}]*\})?\s*=>\s*"((?:\\.|[^"\\])*)"/gu;
  const values = new Map();
  for (const match of body.matchAll(armPattern)) {
    const variant = match[1];
    if (values.has(variant)) {
      fail(
        "CODEX_SOURCE_UNSUPPORTED",
        `KnownPlan::${functionName}() repeats variant ${variant}`,
      );
    }
    values.set(variant, decodeRustString(match[2], functionName));
  }
  if (values.size === 0) {
    fail(
      "CODEX_SOURCE_UNSUPPORTED",
      `KnownPlan::${functionName}() contains no parseable match arms`,
    );
  }
  return values;
}

export function parseKnownPlanSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    fail(
      "CODEX_SOURCE_INVALID",
      `Upstream source must be UTF-8 text no larger than ${MAX_SOURCE_BYTES} bytes`,
    );
  }
  const rawValues = parseKnownPlanMethod(source, "raw_value");
  const displayNames = parseKnownPlanMethod(source, "display_name");
  const pairs = [];
  for (const [variant, rawValue] of rawValues) {
    if (!PLAN_VALUE_RE.test(rawValue)) {
      fail(
        "CODEX_SOURCE_UNSUPPORTED",
        `KnownPlan::raw_value() returned unsupported value for ${variant}`,
      );
    }
    const displayName = displayNames.get(variant);
    if (typeof displayName !== "string") {
      fail(
        "CODEX_SOURCE_UNSUPPORTED",
        `KnownPlan::display_name() is missing variant ${variant}`,
      );
    }
    requireBoundedString(displayName, `display name for ${rawValue}`, { maxLength: 100 });
    if (rawValue !== "unknown") pairs.push({ displayName, rawValue, variant });
  }
  for (const variant of displayNames.keys()) {
    if (!rawValues.has(variant)) {
      fail(
        "CODEX_SOURCE_UNSUPPORTED",
        `KnownPlan::raw_value() is missing variant ${variant}`,
      );
    }
  }
  const duplicateRawValues = new Set();
  const seen = new Set();
  for (const pair of pairs) {
    if (seen.has(pair.rawValue)) duplicateRawValues.add(pair.rawValue);
    seen.add(pair.rawValue);
  }
  if (duplicateRawValues.size > 0) {
    fail(
      "CODEX_SOURCE_UNSUPPORTED",
      `KnownPlan::raw_value() repeats ${[...duplicateRawValues].sort().join(", ")}`,
    );
  }
  return pairs;
}

export function compareUpstreamPlanRegistry(ledger, observedPairs) {
  const issues = [];
  const warnings = [];
  const observedByRaw = new Map(
    observedPairs.map((plan) => [plan.rawValue, plan]),
  );
  const ledgerByRaw = new Map(ledger.plans.map((plan) => [plan.rawValue, plan]));

  for (const observed of observedPairs) {
    const expected = ledgerByRaw.get(observed.rawValue);
    if (!expected) {
      issues.push(issue(
        "upstream_plan_added",
        `Upstream Codex added plan ${observed.rawValue}`,
        { displayName: observed.displayName },
      ));
      continue;
    }
    if (expected.displayName !== observed.displayName) {
      issues.push(issue(
        "upstream_display_name_changed",
        `Upstream Codex changed the display name for ${observed.rawValue}`,
        {
          actual: observed.displayName,
          expected: expected.displayName,
        },
      ));
    }
    if (expected.lifecycle === "deprecated") {
      warnings.push(issue(
        "deprecated_plan_reappeared",
        `Deprecated plan ${observed.rawValue} is present upstream again`,
      ));
    }
  }
  for (const expected of ledger.plans) {
    if (expected.lifecycle === "active" && !observedByRaw.has(expected.rawValue)) {
      issues.push(issue(
        "upstream_active_plan_removed",
        `Active plan ${expected.rawValue} is no longer present upstream; review before marking it deprecated`,
      ));
    }
  }
  return { issues, ok: issues.length === 0, warnings };
}

export function parsePlanTypeScript(source) {
  if (typeof source !== "string"
      || Buffer.byteLength(source) > MAX_GENERATED_FILE_BYTES) {
    fail(
      "CODEX_SCHEMA_INVALID",
      `PlanType.ts must be UTF-8 text no larger than ${MAX_GENERATED_FILE_BYTES} bytes`,
    );
  }
  const declaration = source.match(/export\s+type\s+PlanType\s*=\s*([\s\S]*?);/u);
  if (!declaration) {
    fail("CODEX_SCHEMA_INVALID", "Generated schema does not declare PlanType");
  }
  const planTypes = [];
  const literalPattern = /"((?:\\.|[^"\\])*)"/gu;
  const withoutLiterals = declaration[1].replace(literalPattern, (literal, encoded) => {
    let decoded;
    try {
      decoded = JSON.parse(literal);
    } catch (error) {
      fail(
        "CODEX_SCHEMA_INVALID",
        "Generated PlanType contains an invalid string literal",
        undefined,
        { cause: error },
      );
    }
    if (!PLAN_VALUE_RE.test(decoded)) {
      fail(
        "CODEX_SCHEMA_INVALID",
        `Generated PlanType contains invalid value ${String(decoded)}`,
      );
    }
    planTypes.push(decoded);
    return "";
  });
  if (withoutLiterals.replace(/[|\s]/gu, "") !== "" || planTypes.length === 0) {
    fail(
      "CODEX_SCHEMA_INVALID",
      "Generated PlanType must be a union of string literals",
    );
  }
  if (new Set(planTypes).size !== planTypes.length) {
    fail("CODEX_SCHEMA_INVALID", "Generated PlanType contains duplicate values");
  }
  return planTypes;
}

export function compareBinaryPlanTypes(planTypes, productPlanTypes = TELEMETRY_PLAN_TYPES) {
  const issues = [];
  const productSet = new Set(productPlanTypes);
  const unsupported = planTypes.filter((planType) => !productSet.has(planType)).sort();
  if (unsupported.length > 0) {
    issues.push(issue(
      "binary_plan_types_unsupported",
      `Released Codex binary exposes unsupported plan type(s): ${unsupported.join(", ")}`,
      { unsupported },
    ));
  }
  if (!planTypes.includes("unknown")) {
    issues.push(issue(
      "binary_unknown_sentinel_missing",
      "Released Codex binary no longer exposes the unknown PlanType sentinel",
    ));
  }
  return { issues, ok: issues.length === 0 };
}

async function collectNamedFiles(rootDirectory, targetName, depth = 0) {
  if (depth > 6) return [];
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const path = join(rootDirectory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      matches.push(...await collectNamedFiles(path, targetName, depth + 1));
    } else if (entry.isFile() && entry.name === targetName) {
      matches.push(path);
    }
  }
  return matches.sort();
}

async function executeCodex(execute, binaryPath, argumentsList) {
  return execute(binaryPath, argumentsList, {
    encoding: "utf8",
    maxBuffer: EXECUTION_MAX_BUFFER_BYTES,
    timeout: EXECUTION_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function inspectCodexBinaryContract({
  binaryPath,
  channel,
  execute = execFile,
} = {}) {
  requireBoundedString(channel, "binary channel", { pattern: CHANNEL_ID_RE });
  if (typeof binaryPath !== "string" || binaryPath.length === 0) {
    fail("CODEX_BINARY_INVALID", `No binary was provided for channel ${channel}`);
  }
  let versionResult;
  try {
    versionResult = await executeCodex(execute, binaryPath, ["--version"]);
  } catch (error) {
    fail(
      "CODEX_BINARY_VERSION_UNAVAILABLE",
      `Could not read the Codex version for channel ${channel}`,
      { channel },
      { cause: error },
    );
  }
  const version = String(versionResult.stdout ?? "").trim();
  if (!SAFE_VERSION_RE.test(version)) {
    fail(
      "CODEX_BINARY_VERSION_INVALID",
      `Codex channel ${channel} returned an invalid version string`,
      { channel },
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-contract-schema-"));
  const failures = [];
  try {
    const attempts = [
      Object.freeze({ arguments: ["app-server", "generate-ts"], mode: "stable" }),
      Object.freeze({
        arguments: ["app-server", "generate-ts", "--experimental"],
        mode: "experimental_compatibility",
      }),
    ];
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const outputDirectory = join(temporaryRoot, `attempt-${attemptIndex}`);
      await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
      try {
        await executeCodex(
          execute,
          binaryPath,
          [...attempt.arguments, "--out", outputDirectory],
        );
        const planTypeFiles = await collectNamedFiles(outputDirectory, "PlanType.ts");
        if (planTypeFiles.length === 0) {
          failures.push(`${attempt.mode}:missing_plan_type`);
          continue;
        }
        const parsed = [];
        for (const planTypeFile of planTypeFiles) {
          parsed.push(parsePlanTypeScript(await readFile(planTypeFile, "utf8")));
        }
        const canonical = JSON.stringify([...parsed[0]].sort());
        if (parsed.some((entry) => JSON.stringify([...entry].sort()) !== canonical)) {
          fail(
            "CODEX_SCHEMA_INCONSISTENT",
            `Codex channel ${channel} generated inconsistent PlanType declarations`,
            { channel },
          );
        }
        return {
          channel,
          generatorMode: attempt.mode,
          planTypes: parsed[0],
          planTypesSha256: planTypesSha256(parsed[0]),
          version,
        };
      } catch (error) {
        if (error instanceof CodexContractError) throw error;
        failures.push(`${attempt.mode}:command_failed`);
      }
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  fail(
    "CODEX_BINARY_SCHEMA_GENERATION_FAILED",
    `Codex channel ${channel} could not generate its TypeScript contract`,
    { channel, failures },
  );
}

async function executablePath(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function findOnPath(command, environment, platform = process.platform) {
  const pathValue = environment.PATH;
  if (typeof pathValue !== "string" || pathValue.length === 0) return null;
  const extensions = platform === "win32"
    ? String(environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean)
    : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await executablePath(candidate)) return candidate;
    }
  }
  return null;
}

async function resolveCandidate(candidate, environment, platform) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
    return executablePath(resolve(candidate));
  }
  return findOnPath(candidate, environment, platform);
}

export async function discoverInstalledCodexBinaries({
  environment = process.env,
  platform = process.platform,
} = {}) {
  const definitions = [
    ["environment_override", environment.CODEX_BIN ?? null],
    ["chatgpt_bundled", "/Applications/ChatGPT.app/Contents/Resources/codex"],
    ["codex_bundled", "/Applications/Codex.app/Contents/Resources/codex"],
    ["path", "codex"],
  ];
  const binaries = [];
  const missingChannels = [];
  for (const [channel, candidate] of definitions) {
    const resolvedPath = await resolveCandidate(candidate, environment, platform);
    if (resolvedPath === null) {
      missingChannels.push(channel);
      continue;
    }
    let identity = resolvedPath;
    try {
      identity = await realpath(resolvedPath);
    } catch {
      // The executable access check above is authoritative enough for launch;
      // identity is only an internal optimization and never enters a report.
    }
    binaries.push({ binaryPath: resolvedPath, channel, identity });
  }
  return { binaries, missingChannels };
}

async function readLedger(ledgerFile) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(ledgerFile, "utf8"));
  } catch (error) {
    fail(
      "CODEX_CONTRACT_LEDGER_UNREADABLE",
      "Could not read the Codex contract ledger",
      undefined,
      { cause: error },
    );
  }
  return validateCodexContractLedger(parsed);
}

function sanitizedFailure(error, channel = undefined) {
  const code = typeof error?.code === "string"
    ? error.code
    : "CODEX_CONTRACT_CHECK_FAILED";
  const result = {
    code,
    message: channel
      ? `Codex contract inspection failed for channel ${channel}`
      : "Codex contract inspection failed",
  };
  if (channel) result.details = { channel };
  return result;
}

export async function checkCodexContractDrift({
  binaries = [],
  inspectBinary = inspectCodexBinaryContract,
  installed = false,
  ledgerFile = DEFAULT_CODEX_CONTRACT_LEDGER,
  requireBinary = false,
  sourceFile = null,
  sourceRevision = null,
} = {}) {
  const ledger = await readLedger(ledgerFile);
  const issues = [];
  const warnings = [];
  let releasedBinariesOk = true;
  let upstreamSourceOk = null;
  const observations = {
    binaries: [],
    missingBinaryChannels: [],
    source: null,
  };

  const productCheck = compareProductPlanRegistry(ledger);
  issues.push(...productCheck.issues);

  if (sourceFile !== null) {
    if (sourceRevision !== null && !GIT_REVISION_RE.test(sourceRevision)) {
      fail("CODEX_SOURCE_REVISION_INVALID", "sourceRevision must be a full Git commit SHA");
    }
    let source;
    try {
      source = await readFile(sourceFile, "utf8");
    } catch (error) {
      fail(
        "CODEX_SOURCE_UNREADABLE",
        "Could not read the supplied upstream Codex source",
        undefined,
        { cause: error },
      );
    }
    const observedPairs = parseKnownPlanSource(source);
    const sourceCheck = compareUpstreamPlanRegistry(ledger, observedPairs);
    issues.push(...sourceCheck.issues);
    warnings.push(...sourceCheck.warnings);
    upstreamSourceOk = sourceCheck.ok;
    const sourceDigest = sha256(source);
    if (sourceRevision === ledger.source.reviewedRevision
        && sourceDigest !== ledger.source.sourceSha256) {
      issues.push(issue(
        "upstream_revision_content_mismatch",
        "Pinned upstream source content does not match the reviewed revision digest",
      ));
      upstreamSourceOk = false;
    }
    observations.source = {
      pairCount: observedPairs.length,
      planPairsSha256: planPairsSha256(observedPairs),
      revision: sourceRevision,
      sourceSha256: sourceDigest,
    };
  }

  const requestedBinaries = [...binaries];
  if (installed) {
    const discovery = await discoverInstalledCodexBinaries();
    requestedBinaries.push(...discovery.binaries);
    observations.missingBinaryChannels = discovery.missingChannels;
  }
  if (requireBinary && requestedBinaries.length === 0) {
    releasedBinariesOk = false;
    issues.push(issue(
      "codex_binary_required",
      "At least one Codex binary channel must be available for this check",
    ));
  }

  const inspectionCache = new Map();
  for (const binary of requestedBinaries) {
    if (!CHANNEL_ID_RE.test(binary.channel)) {
      fail("CODEX_BINARY_INVALID", "Binary channel is invalid");
    }
    const cacheKey = binary.identity ?? binary.binaryPath;
    try {
      let observation = inspectionCache.get(cacheKey);
      if (observation === undefined) {
        observation = await inspectBinary({
          binaryPath: binary.binaryPath,
          channel: binary.channel,
        });
        inspectionCache.set(cacheKey, observation);
      } else {
        observation = { ...observation, channel: binary.channel };
      }
      const binaryCheck = compareBinaryPlanTypes(observation.planTypes);
      if (!binaryCheck.ok) releasedBinariesOk = false;
      issues.push(...binaryCheck.issues.map((entry) => ({
        ...entry,
        details: { ...(entry.details ?? {}), channel: binary.channel },
      })));
      observations.binaries.push({
        channel: binary.channel,
        generatorMode: observation.generatorMode,
        planCount: observation.planTypes.length,
        planTypes: observation.planTypes,
        planTypesSha256: observation.planTypesSha256,
        version: observation.version,
      });
      const recordedContract = ledger.verifiedContracts.find((entry) => (
        entry.channel === binary.channel && entry.version === observation.version
      ));
      if (recordedContract
          && recordedContract.planTypesSha256 !== observation.planTypesSha256) {
        releasedBinariesOk = false;
        issues.push(issue(
          "binary_recorded_contract_mismatch",
          `Codex channel ${binary.channel} changed PlanType without changing its version`,
          { channel: binary.channel },
        ));
      }
    } catch (error) {
      releasedBinariesOk = false;
      issues.push(sanitizedFailure(error, binary.channel));
    }
  }

  const result = {
    schemaVersion: CODEX_CONTRACT_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    ok: issues.length === 0,
    ledger: {
      planCount: ledger.plans.length,
      reviewedRevision: ledger.source.reviewedRevision,
      reviewedOn: ledger.source.reviewedOn,
      schemaVersion: ledger.schemaVersion,
    },
    observations,
    checks: {
      productRegistry: productCheck.ok,
      releasedBinaries: releasedBinariesOk,
      upstreamSource: upstreamSourceOk,
    },
    issues,
    warnings,
  };
  return { ledger, result };
}

async function atomicWrite(file, contents, mode = 0o600) {
  const output = resolve(file);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function updateLedgerEvidence(ledgerFile, ledger, result) {
  if (!result.ok) {
    fail(
      "CODEX_CONTRACT_UPDATE_REFUSED",
      "Refusing to update evidence while contract drift is unresolved",
    );
  }
  if (result.observations.source === null && result.observations.binaries.length === 0) {
    fail(
      "CODEX_CONTRACT_UPDATE_EMPTY",
      "Updating the ledger requires a source or binary observation",
    );
  }
  const updated = structuredClone(ledger);
  const today = new Date().toISOString().slice(0, 10);
  if (result.observations.source !== null) {
    if (result.observations.source.revision === null) {
      fail(
        "CODEX_CONTRACT_UPDATE_REVISION_REQUIRED",
        "Updating source evidence requires --source-revision",
      );
    }
    updated.source.reviewedRevision = result.observations.source.revision;
    updated.source.reviewedOn = today;
    updated.source.sourceSha256 = result.observations.source.sourceSha256;
  }
  for (const observation of result.observations.binaries) {
    const contract = {
      channel: observation.channel,
      planTypesSha256: observation.planTypesSha256,
      verifiedOn: today,
      version: observation.version,
    };
    updated.verifiedContracts = updated.verifiedContracts.filter((entry) => (
      entry.channel !== contract.channel || entry.version !== contract.version
    ));
    updated.verifiedContracts.push(contract);
  }
  updated.verifiedContracts.sort((left, right) => (
    left.verifiedOn.localeCompare(right.verifiedOn)
    || left.channel.localeCompare(right.channel)
    || left.version.localeCompare(right.version)
  ));
  validateCodexContractLedger(updated);
  await atomicWrite(ledgerFile, stableJson(updated), 0o644);
  return updated;
}

function parseBinaryArgument(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    fail(
      "CODEX_CONTRACT_ARGUMENT_INVALID",
      "--binary must use channel=/path/to/codex",
    );
  }
  const channel = value.slice(0, separator);
  const binaryPath = value.slice(separator + 1);
  if (!CHANNEL_ID_RE.test(channel)) {
    fail("CODEX_CONTRACT_ARGUMENT_INVALID", "--binary channel is invalid");
  }
  return { binaryPath, channel };
}

export function parseCodexContractArguments(argv) {
  const options = {
    binaries: [],
    help: false,
    installed: false,
    ledgerFile: DEFAULT_CODEX_CONTRACT_LEDGER,
    reportFile: null,
    requireBinary: false,
    sourceFile: null,
    sourceRevision: null,
    summaryFile: null,
    updateLedger: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = () => {
      index += 1;
      if (index >= argv.length) {
        fail(
          "CODEX_CONTRACT_ARGUMENT_INVALID",
          `${argument} requires a value`,
        );
      }
      return argv[index];
    };
    switch (argument) {
      case "--binary":
        options.binaries.push(parseBinaryArgument(takeValue()));
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--installed":
        options.installed = true;
        break;
      case "--ledger":
        options.ledgerFile = resolve(takeValue());
        break;
      case "--report":
        options.reportFile = resolve(takeValue());
        break;
      case "--require-binary":
        options.requireBinary = true;
        break;
      case "--source-file":
        options.sourceFile = resolve(takeValue());
        break;
      case "--source-revision":
        options.sourceRevision = takeValue();
        break;
      case "--summary":
        options.summaryFile = resolve(takeValue());
        break;
      case "--update-ledger":
        options.updateLedger = true;
        break;
      default:
        fail(
          "CODEX_CONTRACT_ARGUMENT_INVALID",
          `Unknown argument: ${argument}`,
        );
    }
  }
  if (options.sourceRevision !== null && options.sourceFile === null) {
    fail(
      "CODEX_CONTRACT_ARGUMENT_INVALID",
      "--source-revision requires --source-file",
    );
  }
  return options;
}

export function formatCodexContractReport(result) {
  const lines = [
    `Codex contract check: ${result.ok ? "PASS" : "FAIL"}`,
    `Product registry: ${result.checks.productRegistry ? "current" : "drifted"}`,
  ];
  if (result.observations.source !== null) {
    lines.push(
      `Upstream source: ${result.checks.upstreamSource ? "current" : "drifted"}`
      + ` (${result.observations.source.pairCount} named plans, revision `
      + `${result.observations.source.revision ?? "unrecorded"})`,
    );
  }
  for (const binary of result.observations.binaries) {
    lines.push(
      `Binary ${binary.channel}: ${binary.version} (${binary.planCount} PlanType values)`,
    );
  }
  if (result.observations.missingBinaryChannels.length > 0) {
    lines.push(
      `Unavailable installed channels: ${result.observations.missingBinaryChannels.join(", ")}`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(`WARNING [${warning.code}] ${warning.message}`);
  }
  for (const contractIssue of result.issues) {
    lines.push(`ERROR [${contractIssue.code}] ${contractIssue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatCodexContractMarkdown(result) {
  const rows = [
    ["Product registry", result.checks.productRegistry ? "Pass" : "Fail"],
    [
      "Upstream source",
      result.checks.upstreamSource === null
        ? "Not requested"
        : result.checks.upstreamSource ? "Pass" : "Fail",
    ],
    [
      "Released binaries",
      result.observations.binaries.length === 0 && result.checks.releasedBinaries
        ? "Not requested"
        : result.checks.releasedBinaries ? "Pass" : "Fail",
    ],
  ];
  return [
    "## Codex contract drift check",
    "",
    `**${result.ok ? "PASS" : "FAIL"}**`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...rows.map(([name, status]) => `| ${markdownCell(name)} | ${markdownCell(status)} |`),
    "",
    ...(result.issues.length === 0
      ? ["No contract drift detected."]
      : [
          "### Action required",
          "",
          ...result.issues.map((entry) => `- \`${entry.code}\`: ${entry.message}`),
        ]),
    "",
  ].join("\n");
}

function usage() {
  return `Usage: node scripts/check-codex-contract-drift.mjs [options]

Options:
  --source-file PATH       Compare a pinned openai/codex auth.rs file.
  --source-revision SHA    Record the exact source commit in the report.
  --binary CHANNEL=PATH    Inspect one exact Codex binary (repeatable).
  --installed              Inspect every available local resolver channel.
  --require-binary         Fail if no binary channel is available.
  --ledger PATH            Override the checked-in ledger path.
  --report PATH            Write a path-free machine-readable JSON report.
  --summary PATH           Append an actionable Markdown summary.
  --update-ledger          Update provenance only after a clean comparison.
  --help                   Show this help.
`;
}

async function writeFailureOutputs(options, error) {
  const result = {
    schemaVersion: CODEX_CONTRACT_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    ok: false,
    checks: {
      productRegistry: false,
      releasedBinaries: false,
      upstreamSource: null,
    },
    issues: [sanitizedFailure(error)],
    ledger: null,
    observations: {
      binaries: [],
      missingBinaryChannels: [],
      source: null,
    },
    warnings: [],
  };
  if (options?.reportFile) {
    await atomicWrite(options.reportFile, stableJson(result));
  }
  if (options?.summaryFile) {
    await appendFile(options.summaryFile, formatCodexContractMarkdown(result), "utf8");
  }
  process.stderr.write(formatCodexContractReport(result));
}

async function main() {
  let options;
  try {
    options = parseCodexContractArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const checked = await checkCodexContractDrift({
      binaries: options.binaries,
      installed: options.installed,
      ledgerFile: options.ledgerFile,
      requireBinary: options.requireBinary,
      sourceFile: options.sourceFile,
      sourceRevision: options.sourceRevision,
    });
    if (options.updateLedger) {
      await updateLedgerEvidence(options.ledgerFile, checked.ledger, checked.result);
    }
    if (options.reportFile) {
      await atomicWrite(options.reportFile, stableJson(checked.result));
    }
    if (options.summaryFile) {
      await appendFile(
        options.summaryFile,
        formatCodexContractMarkdown(checked.result),
        "utf8",
      );
    }
    process.stdout.write(formatCodexContractReport(checked.result));
    if (!checked.result.ok) process.exitCode = 1;
  } catch (error) {
    try {
      await writeFailureOutputs(options, error);
    } catch {
      process.stderr.write("Codex contract check failed before reports could be written.\n");
    }
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
