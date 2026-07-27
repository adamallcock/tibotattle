#!/usr/bin/env node
import {
  REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION,
  RealLocalBackendAcceptanceError,
  parseRealLocalBackendAcceptanceArguments,
  runRealLocalBackendAcceptance,
} from "../src/real-local-backend-acceptance.js";

const usage = [
  "Usage: run-real-local-backend-acceptance",
  `  --confirm ${REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION}`,
  "  --start-at ISO_UTC --end-at ISO_UTC",
  "  --codex-home ABSOLUTE_DIRECTORY",
  "  --identity-file ABSOLUTE_OWNER_ONLY_SECRET_FILE",
  "  --work-directory NEW_ABSOLUTE_DIRECTORY",
  "  --receipt-file NEW_ABSOLUTE_FILE",
  "  --cleanup recoverable-trash",
  "  [--activity-file ABSOLUTE_FILE] [--port 8793]",
].join("\n");

async function main() {
  if (process.argv.includes("--help")) {
    if (process.argv.length !== 3) throw new RealLocalBackendAcceptanceError(
      "arguments_invalid",
    );
    process.stdout.write(`${usage}\n`);
    return;
  }
  const options = parseRealLocalBackendAcceptanceArguments(
    process.argv.slice(2),
  );
  const receipt = await runRealLocalBackendAcceptance(options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof RealLocalBackendAcceptanceError
    ? error.code
    : "real_local_backend_acceptance_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
