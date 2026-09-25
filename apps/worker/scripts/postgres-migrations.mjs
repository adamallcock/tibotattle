// Keep the original tooling path as a stable facade while the canonical
// implementation lives beside the Cloud Run host that consumes it.
export * from "../cloud-run/postgres-migrations.mjs";
