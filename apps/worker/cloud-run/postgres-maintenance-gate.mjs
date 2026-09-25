export const POSTGRES_SCHEDULED_MAINTENANCE_ENABLED_VARIABLE =
  "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED";

/** Keep the Cloud Run scheduled writer dormant until an operator opts in. */
export function assertPostgresScheduledMaintenanceEnabled(environment = process.env) {
  const value = environment?.[POSTGRES_SCHEDULED_MAINTENANCE_ENABLED_VARIABLE] ?? "disabled";
  if (value !== "enabled") {
    throw Object.assign(new Error("POSTGRES_SCHEDULED_MAINTENANCE_DISABLED"), {
      code: "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED",
    });
  }
}
