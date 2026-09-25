#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostgresCommunityDailyActivationConfig,
  isPostgresCommunityDailyRetryActivationInvocation,
  postgresCommunityDailyActivationErrorReceipt,
  restorePostgresCommunityDailyActivationInDisposableSchema,
  restorePostgresCommunityDailyTestActivation,
  restorePostgresCommunityDailyRetryActivationInDisposableSchema,
  restorePostgresCommunityDailyRetryTestActivation,
} from "./postgres-community-daily-activation.mjs";

export {
  parsePostgresCommunityDailyActivationConfig,
  isPostgresCommunityDailyRetryActivationInvocation,
  restorePostgresCommunityDailyActivationInDisposableSchema,
  restorePostgresCommunityDailyTestActivation,
  restorePostgresCommunityDailyRetryActivationInDisposableSchema,
  restorePostgresCommunityDailyRetryTestActivation,
};

async function main() {
  try {
    const retry = isPostgresCommunityDailyRetryActivationInvocation(process.argv.slice(2));
    const result = retry
      ? await restorePostgresCommunityDailyRetryTestActivation()
      : await restorePostgresCommunityDailyTestActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(postgresCommunityDailyActivationErrorReceipt(error,
      process.argv.includes("--retry-retained-a2-publication") ? "retry-restore" : "restore"))}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
