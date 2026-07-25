import { createHash } from "node:crypto";
import { assertValidExportRecord } from "./export-schema.js";
import { stableJson } from "./storage.js";
import { exportCompatibilityTuple } from "./export-contract.js";

const FORBIDDEN_KEYS = new Set([
  "prompt", "response", "content", "text", "message", "messages", "arguments", "command",
  "path", "filepath", "filename", "url", "uri", "email", "username", "hostname", "ip",
  "repository", "project", "branch", "credential", "credentials", "authorization", "cookie",
  "rawaccountidentifier", "sessionid", "rolloutid", "deviceid", "turnid", "callid", "label",
]);

const SENSITIVE_STRING_PATTERNS = Object.freeze([
  ["email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["web_url", /\bhttps?:\/\/[^\s"']+/i],
  ["file_url", /\bfile:\/\/[^\s"']+/i],
  ["absolute_user_path", /(?:^|[\s"'])\/(?:Users|home|private|var\/folders)\//],
  ["windows_user_path", /\b[A-Z]:\\(?:Users|Documents and Settings)\\/i],
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i],
  ["common_api_key", /\b(?:sk-(?:proj-)?|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/],
]);

function scanKeys(value, path = "", findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanKeys(item, `${path}/${index}`, findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) findings.push({ code: "forbidden_key", path: `${path}/${key}` });
    scanKeys(child, `${path}/${key}`, findings);
  }
  return findings;
}

function scanStrings(value, path = "", findings = []) {
  if (typeof value === "string") {
    for (const [code, pattern] of SENSITIVE_STRING_PATTERNS) {
      if (pattern.test(value)) findings.push({ code, path });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStrings(item, `${path}/${index}`, findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  for (const [key, child] of Object.entries(value)) {
    if (path === "" && key === "compatibility") continue;
    scanStrings(child, `${path}/${key}`, findings);
  }
  return findings;
}

function recordCountsMatch(bundle) {
  return bundle.recordCounts.usageEvents === bundle.records.usageEvents.length
    && bundle.recordCounts.quotaSnapshots === bundle.records.quotaSnapshots.length
    && bundle.recordCounts.activityMarkers === bundle.records.activityMarkers.length;
}

function canaryViolations(serialized, forbiddenSourceValues) {
  return forbiddenSourceValues.filter((value) => typeof value === "string" && value.length >= 4 && serialized.includes(value)).length;
}

function providerCompatibilityViolations(bundle) {
  const declared = new Set(Array.isArray(bundle.sourceProviders) ? bundle.sourceProviders : []);
  const observed = new Set([
    ...(bundle.records?.usageEvents ?? []).map((record) => record.provider),
    ...(bundle.records?.quotaSnapshots ?? []).map((record) => record.provider),
  ]);
  const adapters = {
    openai_codex: bundle.compatibility?.providerAdapters?.openaiCodex,
    anthropic_claude_code: bundle.compatibility?.providerAdapters?.anthropicClaudeCode,
  };
  let violations = 0;
  for (const provider of observed) if (!declared.has(provider)) violations += 1;
  for (const provider of declared) {
    if (!["implemented", "partial"].includes(adapters[provider]?.status)) violations += 1;
  }
  for (const record of bundle.records?.usageEvents ?? []) {
    if (adapters[record.provider]?.capabilities?.usageEvents !== "implemented") violations += 1;
  }
  for (const record of bundle.records?.quotaSnapshots ?? []) {
    let capability;
    if (record.provider === "openai_codex") {
      capability = record.snapshotSource === "rollout"
        ? adapters.openai_codex?.capabilities?.quotaSnapshots?.rollout
        : ["app_server_read", "notification"].includes(record.snapshotSource)
          ? adapters.openai_codex?.capabilities?.quotaSnapshots?.collector
          : undefined;
    } else if (record.provider === "anthropic_claude_code" && record.snapshotSource === "status_line") {
      capability = adapters.anthropic_claude_code?.capabilities?.quotaSnapshots;
    }
    if (capability !== "implemented") violations += 1;
  }
  return violations;
}

export function verifyPrivacySafeBundle(bundle, {
  createdAt = new Date().toISOString(),
  forbiddenSourceValues = [],
} = {}) {
  let schemaViolations = 0;
  try {
    assertValidExportRecord("bundle", bundle);
  } catch {
    schemaViolations = 1;
  }
  const keyFindings = scanKeys(bundle);
  const stringFindings = scanStrings(bundle);
  const serialized = stableJson(bundle);
  const compatibilityMatches = stableJson(bundle.compatibility) === stableJson(exportCompatibilityTuple());
  const providerViolations = providerCompatibilityViolations(bundle);
  const checks = [
    { code: "schema_allowlist", status: schemaViolations ? "failed" : "passed", violations: schemaViolations },
    { code: "compatibility_tuple", status: compatibilityMatches ? "passed" : "failed", violations: compatibilityMatches ? 0 : 1 },
    { code: "forbidden_key_scan", status: keyFindings.length ? "failed" : "passed", violations: keyFindings.length },
    { code: "sensitive_string_scan", status: stringFindings.length ? "failed" : "passed", violations: stringFindings.length },
    { code: "record_count_consistency", status: recordCountsMatch(bundle) ? "passed" : "failed", violations: recordCountsMatch(bundle) ? 0 : 1 },
    { code: "provider_adapter_compatibility", status: providerViolations ? "failed" : "passed", violations: providerViolations },
    {
      code: "source_value_canaries",
      status: canaryViolations(serialized, forbiddenSourceValues) ? "failed" : "passed",
      violations: canaryViolations(serialized, forbiddenSourceValues),
    },
  ];
  const verdict = checks.every((check) => check.status === "passed") ? "passed" : "failed";
  const receipt = {
    schemaVersion: "privacy-receipt-v0.1",
    compatibility: structuredClone(bundle.compatibility),
    createdAt: new Date(createdAt).toISOString(),
    bundleId: bundle.bundleId,
    participantId: bundle.participantId,
    bundleSha256: createHash("sha256").update(serialized).digest("hex"),
    bundleBytes: Buffer.byteLength(serialized, "utf8"),
    verdict,
    transportReady: false,
    coveredAt: bundle.coveredAt,
    recordCounts: bundle.recordCounts,
    checks,
    excludedCategories: [
      "prompt_and_response_content",
      "credentials_and_authentication_material",
      "raw_account_session_and_device_identifiers",
      "repository_paths_filenames_branches_and_project_names",
      "tool_names_arguments_commands_and_urls",
      "hostnames_usernames_ip_addresses_and_locale",
      "free_form_labels_and_unknown_fields",
    ],
  };
  if (verdict !== "passed") {
    const failed = checks.filter((check) => check.status === "failed").map((check) => check.code).join(", ");
    throw new Error(`Privacy verification failed closed (${failed})`);
  }
  assertValidExportRecord("privacyReceipt", receipt);
  return receipt;
}

export function inspectSensitiveExportStrings(value) {
  return scanStrings(value).map(({ code, path }) => ({ code, path }));
}
