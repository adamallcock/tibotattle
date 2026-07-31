#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

import {
  ClaudeStatuslineError,
  formatClaudeStatusline,
  readBoundedClaudeStatusInput,
  sanitizeClaudeStatusline,
} from "./providers/claude/statusline.js";
import {
  defaultClaudeStatusStateDirectory,
  writeClaudeStatusSnapshot,
} from "./claude-statusline-storage.js";

export {
  CLAUDE_STATUSLINE_SCHEMA_VERSION,
  ClaudeStatuslineError,
  DEFAULT_MAX_CLAUDE_STATUS_INPUT_BYTES,
  formatClaudeStatusline,
  readBoundedClaudeStatusBytes,
  readBoundedClaudeStatusInput,
  sanitizeClaudeStatusline,
  validateClaudeStatusSnapshot,
} from "./providers/claude/statusline.js";

export async function runClaudeStatusline({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  platform = process.platform,
  homeDirectory,
  stateDirectory,
  loadSessionSecret = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const input = await readBoundedClaudeStatusInput(stdin);
  if (loadSessionSecret !== null && typeof loadSessionSecret !== "function") {
    throw new ClaudeStatuslineError("session_secret");
  }
  let sessionSecret = null;
  try {
    if (loadSessionSecret) {
      const loaded = await loadSessionSecret();
      if (!Buffer.isBuffer(loaded) || loaded.byteLength !== 32) {
        if (Buffer.isBuffer(loaded)) loaded.fill(0);
        throw new ClaudeStatuslineError("session_secret");
      }
      sessionSecret = loaded;
    }
    const snapshot = sanitizeClaudeStatusline(input, capturedAt, {
      sessionSecret,
    });
    const selectedStateDirectory = stateDirectory
      ?? env.USAGEMONITOR_CLAUDE_STATE_DIR
      ?? defaultClaudeStatusStateDirectory({
        platform,
        env,
        homeDirectory,
      });
    await writeClaudeStatusSnapshot(snapshot, {
      stateDirectory: selectedStateDirectory,
    });
    stdout.write(`${formatClaudeStatusline(snapshot)}\n`);
    return snapshot;
  } finally {
    sessionSecret?.fill(0);
  }
}

async function main() {
  await runClaudeStatusline();
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = error instanceof ClaudeStatuslineError
      ? error.code
      : "internal";
    console.error(`Claude limits unavailable [${code}]`);
    process.exitCode = 1;
  });
}
