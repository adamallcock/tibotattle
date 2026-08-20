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
  // No `process.stdin` default: this module is reachable from the companion's
  // import graph, and the companion's descriptor 0 is the signed app's
  // Keychain broker socketpair. Touching process.stdin there constructs a
  // stream over that channel and breaks credential minting silently. The
  // process that legitimately owns descriptor 0 — this file run as a CLI —
  // passes it explicitly in main(), and every other caller already did.
  // Pinned by test/companion-descriptor-zero-invariant.test.js.
  stdin,
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
  await runClaudeStatusline({ stdin: process.stdin });
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
