#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostgresCommunityDailyActivationConfig,
  postgresCommunityDailyActivationErrorReceipt,
  restorePostgresCommunityDailyActivationInDisposableSchema,
  restorePostgresCommunityDailyTestActivation,
} from "./postgres-community-daily-activation.mjs";

export {
  parsePostgresCommunityDailyActivationConfig,
  restorePostgresCommunityDailyActivationInDisposableSchema,
  restorePostgresCommunityDailyTestActivation,
};

async function main() {
  try {
    const result = await restorePostgresCommunityDailyTestActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(postgresCommunityDailyActivationErrorReceipt(error, "restore"))}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
