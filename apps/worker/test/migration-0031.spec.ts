import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 0031 widens the pinned consent CHECKs on device_pairings by
 * rebuilding the table inside one transaction. A DROP TABLE on that parent
 * cascade-deletes the entire credential subtree, so the migration snapshots
 * and restores it; these tests apply 0001-0030, seed a realistic subtree —
 * including a device-authorized contribution whose NO ACTION reference is
 * the hardest thing the rebuild must not break — then apply 0031 and prove
 * nothing was lost and every guard still holds.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

function migrationsBefore0031(): D1Migration[] {
  const migrations = (env as TestBindings).TEST_MIGRATIONS;
  const index = migrations.findIndex((migration) =>
    migration.name.startsWith("0031"),
  );
  expect(index).toBeGreaterThan(0);
  return migrations.slice(0, index);
}

beforeEach(async () => {
  await reset();
  const test = env as TestBindings;
  await applyD1Migrations(test.DELETION_LEDGER, test.TEST_DELETION_LEDGER_MIGRATIONS);
});

describe("migration 0031 device_pairings consent rebuild", () => {
  it("preserves the credential subtree seeded before the migration", async () => {
    await applyD1Migrations(db(), migrationsBefore0031());
    const now = "2026-08-07T00:00:00.000Z";
    const future = "2027-01-01T00:00:00.000Z";
    const hash = (fill: number) => new Uint8Array(32).fill(fill);
    await db().batch([
      db().prepare(
        `INSERT INTO participants (
          id, access_token_id, access_token_hash, recovery_token_id,
          recovery_token_hash, state, consent_version, consented_at, created_at
        ) VALUES ('p1', 'at1', ?, 'rt1', ?, 'active',
          'privacy-safe-telemetry-v0.1', ?, ?)`,
      ).bind(hash(1), hash(2), now, now),
      db().prepare(
        `INSERT INTO web_sessions (
          id, participant_id, secret_hash, csrf_hash, scope, state,
          issued_at, expires_at, last_used_at
        ) VALUES ('s1', 'p1', ?, ?, 'personal', 'active', ?, ?, ?)`,
      ).bind(hash(3), hash(4), now, future, now),
      db().prepare(
        `INSERT INTO device_pairings (
          id, participant_id, issued_by_session_id, secret_hash,
          consent_version, state, issued_at, expires_at
        ) VALUES ('pair1', 'p1', 's1', ?,
          'ongoing-privacy-safe-telemetry-v0.1', 'unused', ?, ?)`,
      ).bind(hash(5), now, future),
      db().prepare(
        `INSERT INTO device_credentials (
          id, participant_id, paired_via_pairing_id, secret_hash, state,
          issued_at, expires_at, last_used_at, social_verified_at
        ) VALUES ('dev1', 'p1', 'pair1', ?, 'active', ?, ?, ?, ?)`,
      ).bind(hash(6), now, future, now, now),
      db().prepare(
        `INSERT INTO device_upload_authorizations (
          id, participant_id, issued_by_device_id, secret_hash,
          envelope_digest, body_bytes, content_type, state, issued_at,
          expires_at, consume_lease_expires_at
        ) VALUES ('auth1', 'p1', 'dev1', ?, ?, 4096, 'application/json',
          'consuming', ?, ?, ?)`,
      ).bind(hash(7), "ab".repeat(32), now, future, future),
      db().prepare(
        `INSERT INTO telemetry_contributions (
          id, participant_id, plaintext_digest, envelope_digest, r2_key,
          status, schema_version, range_start, range_end, client_platform,
          provider_policy_epoch, priced_event_coverage_percent,
          unknown_model_event_count, unknown_billable_units, price_basis,
          declared_record_count, created_at, device_upload_authorization_id
        ) VALUES ('contribution:11111111-1111-4111-8111-111111111111', 'p1',
          ?, ?, 'telemetry/rebuild-probe', 'accepted',
          'telemetry-contribution-v0.1', ?, ?, 'macos', 'epoch-1', 100, 0, 0,
          'current_api_prices', 1, ?, 'auth1')`,
      ).bind("cd".repeat(32), "ef".repeat(32), now, now, now),
    ]);

    // Applying the remaining chain runs 0031's rebuild over the seeded data.
    const test = env as TestBindings;
    await applyD1Migrations(db(), test.TEST_MIGRATIONS);

    for (const [table, expected] of [
      ["device_pairings", 1],
      ["device_credentials", 1],
      ["device_upload_authorizations", 1],
      ["telemetry_contributions", 1],
    ] as const) {
      const row = await db().prepare(
        `SELECT COUNT(*) AS total FROM ${table}`,
      ).first<{ total: number }>();
      expect(`${table}:${row?.total}`).toBe(`${table}:${expected}`);
    }

    // The widened CHECKs admit the v1.0 identifiers and still fail closed.
    await db().prepare(
      `INSERT INTO device_pairings (
        id, participant_id, issued_by_session_id, secret_hash,
        consent_version, state, issued_at, expires_at,
        transport_consent_version
      ) VALUES ('pair2', 'p1', 's1', ?,
        'ongoing-privacy-safe-telemetry-v1.0', 'unused', ?, ?,
        'ongoing-privacy-safe-telemetry-v1.0')`,
    ).bind(hash(8), now, future).run();
    await expect(db().prepare(
      `INSERT INTO device_pairings (
        id, participant_id, issued_by_session_id, secret_hash,
        consent_version, state, issued_at, expires_at
      ) VALUES ('pair3', 'p1', 's1', ?, 'bogus', 'unused', ?, ?)`,
    ).bind(hash(9), now, future).run()).rejects.toThrow(/CHECK/u);

    // The recreated trigger and the foreign key both still gate claims.
    await expect(db().prepare(
      `INSERT INTO device_credentials (
        id, participant_id, paired_via_pairing_id, secret_hash, state,
        issued_at, expires_at, last_used_at, social_verified_at
      ) VALUES ('dev2', 'p1', 'missing-pairing', ?, 'active', ?, ?, ?, ?)`,
    ).bind(hash(10), now, future, now, now).run())
      .rejects.toThrow(/FOREIGN KEY|pairing unavailable/u);

    // No save table leaks out of the rebuild.
    const leftovers = await db().prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%_save'`,
    ).all<{ name: string }>();
    expect(leftovers.results).toEqual([]);

    // The participant cascade still reaches the rebuilt table and subtree.
    await db().batch([
      db().prepare(
        "DELETE FROM telemetry_contributions WHERE participant_id = 'p1'",
      ),
      db().prepare("DELETE FROM participants WHERE id = 'p1'"),
    ]);
    for (const table of [
      "device_pairings", "device_credentials", "device_upload_authorizations",
    ]) {
      const row = await db().prepare(
        `SELECT COUNT(*) AS total FROM ${table}`,
      ).first<{ total: number }>();
      expect(`${table}:${row?.total}`).toBe(`${table}:0`);
    }
  });
});
