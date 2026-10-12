#!/usr/bin/env node

import assert from "node:assert/strict";
import { assertPostgresScheduledMaintenanceEnabled } from "./postgres-maintenance-gate.mjs";

assert.throws(() => assertPostgresScheduledMaintenanceEnabled({}), {
  code: "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED",
});
assert.throws(() => assertPostgresScheduledMaintenanceEnabled({
  POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "true",
}), { code: "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED" });
assert.doesNotThrow(() => assertPostgresScheduledMaintenanceEnabled({
  POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
}));

console.log(JSON.stringify({ status: "ok", checks: ["scheduled-maintenance-default-disabled"] }));
