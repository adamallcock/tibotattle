import { runClaudeCallback } from "../../src/claude-callback-runtime.js";

await runClaudeCallback({
  backend: {}, // Oversized input fails before any credential operation.
  readRuntimeConfiguration: async () => ({
    previousCommand: "bytes=$(wc -c | tr -d ' '); printf 'existing bytes=%s' \"$bytes\"",
  }),
});
