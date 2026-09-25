#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostgresCommunityDailyActivationConfig,
  isPostgresCommunityDailyRetryActivationInvocation,
  preparePostgresCommunityDailyActivationInDisposableSchema,
  postgresCommunityDailyActivationErrorReceipt,
  preparePostgresCommunityDailyTestActivation,
  preparePostgresCommunityDailyRetryActivationInDisposableSchema,
  preparePostgresCommunityDailyRetryTestActivation,
  readPostgresCommunityDailyDaySourceEligibility,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET,
} from "./postgres-community-daily-activation.mjs";

export {
  parsePostgresCommunityDailyActivationConfig,
  isPostgresCommunityDailyRetryActivationInvocation,
  preparePostgresCommunityDailyTestActivation,
  preparePostgresCommunityDailyRetryTestActivation,
  preparePostgresCommunityDailyActivationInDisposableSchema,
  preparePostgresCommunityDailyRetryActivationInDisposableSchema,
  readPostgresCommunityDailyDaySourceEligibility,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
  POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET,
};

async function main() {
  try {
    const retry = isPostgresCommunityDailyRetryActivationInvocation(process.argv.slice(2));
    const result = retry
      ? await preparePostgresCommunityDailyRetryTestActivation()
      : await preparePostgresCommunityDailyTestActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(postgresCommunityDailyActivationErrorReceipt(error,
      process.argv.includes("--retry-retained-a2-publication") ? "retry-prepare" : "prepare"))}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
