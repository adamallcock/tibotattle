import type { D1Migration } from "cloudflare:test";

// Social cache-boundary tests use small analytical schemas. Install the actual
// production authority view and its empty accountless graph, rather than a
// permissive stand-in. Enrollment/consent behavior belongs to the full-D1 tests.
export async function installPublicSourceOwnersForCacheFixture(
  database: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  const definition = (migrationPrefix: string, kind: "TABLE" | "VIEW", name: string): string => {
    const migration = migrations.find((item) => item.name.startsWith(migrationPrefix));
    const pattern = new RegExp(`\\bCREATE ${kind} ${name}\\s*\\(`, "u");
    const matches = migration?.queries.filter((query) => pattern.test(query)) ?? [];
    if (matches.length !== 1) throw new Error(`Missing exact fixture schema definition: ${name}`);
    return matches[0]!;
  };
  const queries = [
    definition("0057_", "TABLE", "accountless_enrollment_ledger"),
    definition("0058_", "TABLE", "device_credentials"),
    definition("0058_", "TABLE", "accountless_upload_owners"),
    definition("0058_", "TABLE", "accountless_v11_device_authorizations"),
    definition("0045_", "TABLE", "telemetry_v11_domains"),
    "ALTER TABLE telemetry_v11_domain_heads ADD COLUMN generation_id TEXT",
    definition("0060_", "VIEW", "community_public_source_owners"),
  ];
  await database.batch(queries.map((query) => database.prepare(query)));
}
