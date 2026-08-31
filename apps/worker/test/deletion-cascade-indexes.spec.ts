import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Account deletion is one `DELETE FROM participants WHERE id = ?`, and its
 * cost is foreign-key enforcement: for every deleted parent row, SQLite must
 * find the child rows each `ON DELETE CASCADE` names. Before migration 0030,
 * four child columns carried no index, so each probe was a full scan of the
 * child table — and the two keyed by session id
 * (`upload_authorizations.issued_by_session_id`,
 * `device_pairings.issued_by_session_id`) re-ran once per deleted session
 * over tables that grow with every upload from every participant.
 *
 * These tests pin the property at three levels: every foreign key in the
 * schema must be served by an index (so a future migration cannot
 * reintroduce the defect on a new table), the deletion statements must plan
 * as SEARCHes with no child SCAN, and the cascade must still work against
 * the real triggers.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

beforeEach(async () => {
  await reset();
  const test = env as TestBindings;
  await applyD1Migrations(test.USAGE_MONITOR_DB, test.TEST_MIGRATIONS);
  await applyD1Migrations(
    test.DELETION_LEDGER,
    test.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("deletion cascade child indexes (migration 0030)", () => {
  it("installs the four cascade child indexes", async () => {
    const indexes = await db().prepare(
      `SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'upload_authorizations_issued_by_session',
          'device_pairings_issued_by_session',
          'device_credential_rotations_participant',
          'recovery_retry_receipts_participant'
        )
        ORDER BY name`,
    ).all<{ name: string; tbl_name: string }>();
    expect(indexes.results).toEqual([
      { name: "device_credential_rotations_participant", tbl_name: "device_credential_rotations" },
      { name: "device_pairings_issued_by_session", tbl_name: "device_pairings" },
      { name: "recovery_retry_receipts_participant", tbl_name: "recovery_retry_receipts" },
      { name: "upload_authorizations_issued_by_session", tbl_name: "upload_authorizations" },
    ]);
  });

  it("plans a single-row delete of every table without scanning any child", async () => {
    // Foreign-key probes for a parent-row delete appear in EXPLAIN QUERY PLAN
    // (trigger bodies do not), so an unindexed child key surfaces here as a
    // `SCAN <child>` regardless of which future migration introduces it.
    const tables = await db().prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
          AND name <> 'd1_migrations'
        ORDER BY name`,
    ).all<{ name: string }>();
    expect(tables.results.length).toBeGreaterThan(20);

    const violations: string[] = [];
    let foreignKeyProbes = 0;
    for (const { name: table } of tables.results) {
      const plan = await db().prepare(
        `EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE rowid = ?`,
      ).bind(1).all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      foreignKeyProbes += Math.max(0, details.length - 1);
      for (const detail of details) {
        if (/^\s*SCAN\b/u.test(detail)) violations.push(`${table}: ${detail}`);
      }
    }
    expect(violations).toEqual([]);
    // The probes are what this test exists to inspect; if they stop being
    // planned, foreign-key enforcement is off and the assertion above is
    // vacuous.
    expect(foreignKeyProbes).toBeGreaterThan(10);
  });

  it("uses the three device-leading successor indexes for device foreign-key probes", async () => {
    const plan = await db().prepare(
      "EXPLAIN QUERY PLAN DELETE FROM device_credentials WHERE id = ?",
    ).bind("synthetic-device").all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    for (const [table, index] of [
      ["telemetry_v11_device_consents", "telemetry_v11_consents_device"],
      ["telemetry_v11_day_manifests", "telemetry_v11_manifests_device"],
      ["telemetry_v11_chunks", "telemetry_v11_chunks_device"],
    ]) {
      const columns = await db().prepare(`PRAGMA index_info('${index}')`)
        .all<{ name: string }>();
      expect(columns.results.map((row) => row.name), index).toEqual(["device_id"]);
      expect(details.filter((detail) => detail.startsWith(`SEARCH ${table} `)))
        .toEqual([`SEARCH ${table} USING COVERING INDEX ${index} (device_id=?)`]);
    }
    expect(details.filter((detail) => /^\s*SCAN\b/u.test(detail))).toEqual([]);
  });

  it("plans the participant and session cascades without scanning a child table", async () => {
    for (const statement of [
      "DELETE FROM participants WHERE id = ?",
      "DELETE FROM web_sessions WHERE participant_id = ?",
    ]) {
      const plan = await db().prepare(
        `EXPLAIN QUERY PLAN ${statement}`,
      ).bind("probe").all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      // The foreign-key probes are what make the plan longer than the one
      // SEARCH of the deleted table itself; if they disappear, foreign key
      // enforcement is off and this test is no longer checking anything.
      expect(details.length).toBeGreaterThan(1);
      expect(details.filter((detail) => /^\s*SCAN\b/u.test(detail)))
        .toEqual([]);
    }
  });

  it("cascades a participant deletion through the indexed children", async () => {
    const now = "2026-07-01T00:00:00.000Z";
    const future = "2027-01-01T00:00:00.000Z";
    const hash = (fill: number) => new Uint8Array(32).fill(fill);
    for (const participant of ["cascade-a", "cascade-b"]) {
      await db().batch([
        db().prepare(
          `INSERT INTO participants (
            id, access_token_id, access_token_hash, recovery_token_id,
            recovery_token_hash, state, consent_version, consented_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.1', ?, ?)`,
        ).bind(participant, `at-${participant}`, hash(1), `rt-${participant}`,
          hash(2), now, now),
        db().prepare(
          `INSERT INTO web_sessions (
            id, participant_id, secret_hash, csrf_hash, scope, state,
            issued_at, expires_at, last_used_at
          ) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
        ).bind(`session-${participant}`, participant, hash(3), hash(4),
          now, future, now),
        db().prepare(
          `INSERT INTO upload_authorizations (
            id, participant_id, issued_by_session_id, secret_hash,
            envelope_digest, body_bytes, content_type, state, issued_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 4096, 'application/json', 'unused', ?, ?)`,
        ).bind(`upload-${participant}`, participant, `session-${participant}`,
          hash(5), "ab".repeat(32), now, future),
        db().prepare(
          `INSERT INTO recovery_retry_receipts (
            old_recovery_token_id, old_recovery_token_hash, recovery_attempt_hash,
            participant_id, derivation_nonce, replacement_recovery_token_id,
            replacement_session_id, issued_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(`receipt-${participant}`, hash(6), hash(7), participant,
          "A".repeat(43), `nrt-${participant}`, `session-${participant}`,
          now, future),
        db().prepare(
          `INSERT INTO device_pairings (
            id, participant_id, issued_by_session_id, secret_hash,
            consent_version, state, issued_at, expires_at
          ) VALUES (?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v0.1', 'unused', ?, ?)`,
        ).bind(`pairing-${participant}`, participant, `session-${participant}`,
          hash(8), now, future),
        db().prepare(
          `INSERT INTO device_credentials (
            id, participant_id, paired_via_pairing_id, secret_hash, state,
            issued_at, expires_at, last_used_at, social_verified_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        ).bind(`device-${participant}`, participant, `pairing-${participant}`,
          hash(9), now, future, now, now),
        db().prepare(
          `INSERT INTO device_credential_rotations (
            id, device_id, participant_id, prior_secret_hash,
            replacement_secret_hash, attempt_id, generation, rotated_at, retire_at
          ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)`,
        ).bind(`rotation-${participant}`, `device-${participant}`, participant,
          hash(10), hash(11), `attempt-${participant}`, now, future),
      ]);
    }

    await db().batch([
      db().prepare("DELETE FROM contributions WHERE participant_id = ?")
        .bind("cascade-a"),
      db().prepare("DELETE FROM participants WHERE id = ?").bind("cascade-a"),
    ]);

    for (const table of [
      "web_sessions", "upload_authorizations", "recovery_retry_receipts",
      "device_pairings", "device_credentials", "device_credential_rotations",
    ]) {
      const remaining = await db().prepare(
        `SELECT COUNT(*) AS total FROM ${table}`,
      ).first<{ total: number }>();
      expect(`${table}:${remaining?.total}`).toBe(`${table}:1`);
    }
    const participants = await db().prepare(
      "SELECT id FROM participants ORDER BY id",
    ).all<{ id: string }>();
    expect(participants.results.map((row) => row.id)).toEqual(["cascade-b"]);
  });
});
