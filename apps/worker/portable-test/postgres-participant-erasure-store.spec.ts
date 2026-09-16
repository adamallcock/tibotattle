import { describe, expect, it } from "vitest";

import {
  createExperimentalPostgresParticipantErasureStores,
} from "../src/postgres-participant-erasure-store";
import type {
  PostgresTelemetryV1Client,
  PostgresTelemetryV1Pool,
  PostgresTelemetryV1QueryResult,
} from "../src/postgres-telemetry-v1-contribution-store";

const PARTICIPANT_ID = "participant-1";
const DELETION_FENCE = "deletion-fence";

function fixture(failAt: string | null = null): {
  readonly pool: PostgresTelemetryV1Pool;
  readonly queries: string[];
  readonly releases: boolean[];
} {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const client: PostgresTelemetryV1Client = {
    async query(sql): Promise<PostgresTelemetryV1QueryResult> {
      queries.push(sql);
      if (failAt !== null && sql.includes(failAt)) {
        throw new Error("synthetic-private-driver-details");
      }
      if (sql.includes("deletion_tombstones")) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "tibotattle_v1_test"."participants"')) {
        return {
          rows: [{
            state: "deleting",
            deletion_session_id: DELETION_FENCE,
            owner_kind: "social",
            enrollment_device_id: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release(discard = false) {
      releases.push(discard);
    },
  };
  return {
    pool: { async connect() { return client; } },
    queries,
    releases,
  };
}

describe("experimental PostgreSQL participant erasure store", () => {
  it("bounds primary and ledger reads with configured read-only transactions", async () => {
    const primary = fixture();
    const ledger = fixture();
    const stores = createExperimentalPostgresParticipantErasureStores(
      primary.pool,
      ledger.pool,
      {
        statementTimeoutMilliseconds: 123,
        lockTimeoutMilliseconds: 45,
      },
    );

    await expect(stores.primary.readParticipant(PARTICIPANT_ID)).resolves.toEqual({
      state: "deleting",
      deletionFence: DELETION_FENCE,
      ownerKind: "social",
      enrollmentDeviceId: null,
    });
    await expect(stores.ledger.hasTombstone(PARTICIPANT_ID, 0)).resolves.toBe(false);

    expect(primary.queries.slice(0, 3)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout='123ms'",
      "SET LOCAL lock_timeout='45ms'",
    ]);
    expect(primary.queries.at(-1)).toBe("COMMIT");
    expect(primary.releases).toEqual([false]);
    expect(ledger.queries.slice(0, 3)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout='123ms'",
      "SET LOCAL lock_timeout='45ms'",
    ]);
    expect(ledger.queries.at(-1)).toBe("COMMIT");
    expect(ledger.releases).toEqual([false]);
  });

  it("rolls back and sanitizes a bounded read failure with one normal release", async () => {
    const primary = fixture('FROM "tibotattle_v1_test"."participants"');
    const stores = createExperimentalPostgresParticipantErasureStores(primary.pool, fixture().pool);

    await expect(stores.primary.readParticipant(PARTICIPANT_ID))
      .rejects.toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(primary.queries.at(-1)).toBe("ROLLBACK");
    expect(primary.queries).not.toContain("COMMIT");
    expect(primary.releases).toEqual([false]);
  });

  it("discards a connection when a bounded read commit acknowledgement is lost", async () => {
    const primary = fixture("COMMIT");
    const stores = createExperimentalPostgresParticipantErasureStores(primary.pool, fixture().pool);

    await expect(stores.primary.readParticipant(PARTICIPANT_ID))
      .rejects.toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(primary.queries.at(-1)).toBe("ROLLBACK");
    expect(primary.releases).toEqual([true]);
  });
});
