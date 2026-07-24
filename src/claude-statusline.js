#!/usr/bin/env node
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sanitizeWindow(window) {
  if (!window || !Number.isFinite(window.used_percentage) || !Number.isFinite(window.resets_at)) return null;
  return {
    usedPercent: window.used_percentage,
    resetsAt: window.resets_at,
  };
}

export function sanitizeClaudeStatusline(input, capturedAt = new Date().toISOString()) {
  return {
    schemaVersion: "0.1",
    kind: "claude_rate_limit_snapshot",
    provider: "anthropic_claude_code",
    capturedAt,
    clientVersion: typeof input?.version === "string" ? input.version : null,
    modelId: typeof input?.model?.id === "string" ? input.model.id : null,
    fastMode: input?.fast_mode === true,
    limits: {
      fiveHour: sanitizeWindow(input?.rate_limits?.five_hour),
      sevenDay: sanitizeWindow(input?.rate_limits?.seven_day),
    },
    privacy: {
      sessionIdentifiersStored: false,
      transcriptPathStored: false,
      workspaceStored: false,
      conversationContentStored: false,
    },
  };
}

export function formatClaudeStatusline(snapshot) {
  const segments = [];
  if (snapshot.limits.fiveHour) segments.push(`5h ${snapshot.limits.fiveHour.usedPercent}%`);
  if (snapshot.limits.sevenDay) segments.push(`7d ${snapshot.limits.sevenDay.usedPercent}%`);
  return segments.length ? `Claude ${segments.join(" · ")}` : "Claude limits unavailable";
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const snapshot = sanitizeClaudeStatusline(input);
  const dataFile = resolve(process.env.USAGEMONITOR_CLAUDE_STATUS_FILE ?? ".usage-monitor/claude-statusline.jsonl");
  await mkdir(dirname(dataFile), { recursive: true });
  await appendFile(dataFile, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(dataFile, 0o600);
  console.log(formatClaudeStatusline(snapshot));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Claude limits unavailable (${error.message})`);
    process.exitCode = 1;
  });
}
