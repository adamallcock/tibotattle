#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostgresCommunityDailyActivationConfig,
  preparePostgresCommunityDailyActivationInDisposableSchema,
  postgresCommunityDailyActivationErrorReceipt,
  preparePostgresCommunityDailyTestActivation,
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
  preparePostgresCommunityDailyTestActivation,
  preparePostgresCommunityDailyActivationInDisposableSchema,
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
    const result = await preparePostgresCommunityDailyTestActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(postgresCommunityDailyActivationErrorReceipt(error, "prepare"))}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
