import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import {
  eraseParticipantWithStore,
  type ParticipantErasureCounts,
  type ParticipantErasureDependencies,
  type ParticipantErasureObjectPage,
  type ParticipantErasureObjectSource,
  type ParticipantErasureTarget,
} from "../src/participant-erasure-store";
import type {
  ParticipantErasureObjectRef,
  ParticipantErasureObjectStore,
} from "../src/erasure-object-store";

const PARTICIPANT_ID = "participant:synthetic";
const FIRST_OPERATION = "operation-first";
const SECOND_OPERATION = "operation-second";
const NOW_EPOCH = Date.parse("2026-09-15T12:00:00.000Z");

type PageOverride = (
  source: ParticipantErasureObjectSource,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  limit: number,
) => ParticipantErasureObjectPage;

interface FixtureOptions {
  readonly rows?: readonly ParticipantErasureObjectRef[];
  readonly target?: ParticipantErasureTarget | null;
  readonly ledgerPresent?: boolean;
  readonly failLedger?: boolean;
  readonly failDeleteOnce?: boolean;
  readonly staleAfterDelete?: boolean;
  readonly counts?: ParticipantErasureCounts;
  readonly pageOverride?: PageOverride;
  readonly maxObjectPages?: number;
}

interface Fixture {
  readonly dependencies: ParticipantErasureDependencies;
  readonly rows: ParticipantErasureObjectRef[];
  readonly deleteBatches: ParticipantErasureObjectRef[][];
  readonly tombstoneWrites: number;
  readonly countsCalls: number;
  readonly finishCalls: number;
  readonly ownerChecks: number;
  readonly claimCalls: number;
  readonly hookCalls: number;
  readonly currentTarget: () => ParticipantErasureTarget | null;
}

function objectRef(
  source: ParticipantErasureObjectSource,
  index: number,
): ParticipantErasureObjectRef {
  const id = `${source}-${String(index).padStart(3, "0")}`;
  return {
    source,
    id,
    key: `quarantine/${source}/${id}`,
    createdAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 1_000).toISOString(),
    version: null,
  };
}

function compareObjects(
  left: ParticipantErasureObjectRef,
  right: ParticipantErasureObjectRef,
): number {
  const byDate = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
}

function defaultRows(): ParticipantErasureObjectRef[] {
  return [objectRef("synthetic", 0)];
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const rows = [...(options.rows ?? defaultRows())];
  let target = options.target === undefined
    ? {
      state: "active" as const,
      deletionFence: null,
      ownerKind: "social" as const,
      enrollmentDeviceId: null,
    }
    : options.target;
  let ledgerPresent = options.ledgerPresent ?? false;
  let tombstoneWrites = 0;
  let countsCalls = 0;
  let finishCalls = 0;
  let ownerChecks = 0;
  let claimCalls = 0;
  let hookCalls = 0;
  let deleteFailed = false;
  const deleteBatches: ParticipantErasureObjectRef[][] = [];
  let currentFence: string | null = null;

  const counts = (): ParticipantErasureCounts => options.counts ?? {
    synthetic: rows.filter((row) => row.source === "synthetic").length,
    telemetry: rows.filter((row) => row.source === "telemetry").length,
    telemetryV1: rows.filter((row) => row.source === "telemetry_v1").length,
    telemetryV11: rows.filter((row) => row.source === "telemetry_v11").length,
  };

  const objectStore: ParticipantErasureObjectStore = {
    async deleteBatch(objects): Promise<void> {
      deleteBatches.push([...objects]);
      if (options.failDeleteOnce && !deleteFailed) {
        deleteFailed = true;
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      if (options.staleAfterDelete) {
        // The provider has completed the destructive operation before the
        // second owner fence check observes that this caller is stale.
        return;
      }
    },
  };

  const dependencies: ParticipantErasureDependencies = {
    primary: {
      async readParticipant() {
        return target;
      },
      async claimDeletion(_participantId, existingTarget, operationId) {
        claimCalls++;
        currentFence = operationId;
        target = {
          ...existingTarget,
          state: "deleting",
          deletionFence: operationId,
        };
        return operationId;
      },
      async assertOwner(_participantId, deletionFence) {
        ownerChecks++;
        if (currentFence !== deletionFence || (options.staleAfterDelete && deleteBatches.length > 0)) {
          throw new ApiError(409, "LIFECYCLE_STATE_CONFLICT");
        }
      },
      async revokeLegacySessions() {},
      async identityLinkKey() {
        return null;
      },
      async countObjects() {
        countsCalls++;
        return counts();
      },
      async listObjectPage(_participantId, source, cursor, limit) {
        if (options.pageOverride !== undefined) {
          return options.pageOverride(source, cursor, limit);
        }
        const sourceRows = rows.filter((row) => row.source === source).sort(compareObjects);
        const start = cursor === null
          ? 0
          : sourceRows.findIndex((row) => compareObjects(row, {
            source,
            id: cursor.id,
            key: "",
            createdAt: cursor.createdAt,
            version: null,
          }) > 0);
        const offset = start < 0 ? sourceRows.length : start;
        const pageRows = sourceRows.slice(offset, offset + limit);
        const last = pageRows.at(-1);
        return {
          objects: pageRows,
          nextCursor: pageRows.length === limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
        };
      },
      async finish() {
        finishCalls++;
        target = null;
      },
    },
    ledger: {
      async hasTombstone() {
        return ledgerPresent;
      },
      async recordTombstone() {
        tombstoneWrites++;
        if (options.failLedger) {
          throw new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
        }
        ledgerPresent = true;
      },
    },
    objects: objectStore,
    hooks: {
      async revokeAccountlessEnrollment() {
        hookCalls++;
      },
      async assertIdentityConfiguration() {
        hookCalls++;
      },
      async recordIdentityCooldown() {
        hookCalls++;
      },
    },
    ...(options.maxObjectPages === undefined ? {} : { maxObjectPages: options.maxObjectPages }),
  };

  return {
    dependencies,
    rows,
    deleteBatches,
    get tombstoneWrites() { return tombstoneWrites; },
    get countsCalls() { return countsCalls; },
    get finishCalls() { return finishCalls; },
    get ownerChecks() { return ownerChecks; },
    get claimCalls() { return claimCalls; },
    get hookCalls() { return hookCalls; },
    currentTarget: () => target,
  };
}

async function erase(fixture: Fixture, operationId = FIRST_OPERATION) {
  return eraseParticipantWithStore(
    fixture.dependencies,
    PARTICIPANT_ID,
    operationId,
    NOW_EPOCH,
  );
}

describe("provider-neutral participant erasure workflow", () => {
  it("records the ledger before deletion and leaves objects untouched when it fails", async () => {
    const fixture = makeFixture({ failLedger: true });

    await expect(erase(fixture)).rejects.toMatchObject({
      status: 503,
      code: "DELETION_LEDGER_UNAVAILABLE",
    });
    expect(fixture.tombstoneWrites).toBe(1);
    expect(fixture.countsCalls).toBe(0);
    expect(fixture.deleteBatches).toEqual([]);
    expect(fixture.finishCalls).toBe(0);
    expect(fixture.rows).toHaveLength(1);
  });

  it("rejects a total count that cannot be represented safely", async () => {
    const fixture = makeFixture({
      rows: [],
      counts: {
        synthetic: Number.MAX_SAFE_INTEGER,
        telemetry: 1,
        telemetryV1: 0,
        telemetryV11: 0,
      },
    });

    await expect(erase(fixture)).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_STORAGE_UNAVAILABLE",
    });
    expect(fixture.countsCalls).toBe(1);
    expect(fixture.deleteBatches).toEqual([]);
    expect(fixture.finishCalls).toBe(0);
  });

  it("does not delete or finalize a truncated page with a continuation cursor", async () => {
    const row = objectRef("synthetic", 0);
    const fixture = makeFixture({
      rows: [row],
      pageOverride: (source) => source === "synthetic"
        ? {
          objects: [row],
          nextCursor: { createdAt: row.createdAt, id: "cursor-after-truncated-page" },
        }
        : { objects: [], nextCursor: null },
    });

    await expect(erase(fixture)).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_STORAGE_UNAVAILABLE",
    });
    expect(fixture.deleteBatches).toEqual([]);
    expect(fixture.finishCalls).toBe(0);
    expect(fixture.rows).toEqual([row]);
  });

  it("does not finalize when a provider repeats a page cursor", async () => {
    const pageRows = Array.from({ length: 100 }, (_, index) => objectRef("synthetic", index));
    const fixture = makeFixture({
      // Keep the page source immutable so a repeated cursor is observable
      // after the first provider delete removes the live rows.
      rows: pageRows,
      pageOverride: (source, cursor) => {
        if (source !== "synthetic") return { objects: [], nextCursor: null };
        if (cursor === null) {
          const last = pageRows.at(-1)!;
          return {
            objects: pageRows,
            nextCursor: { createdAt: last.createdAt, id: last.id },
          };
        }
        return {
          objects: pageRows,
          nextCursor: null,
        };
      },
    });

    await expect(erase(fixture)).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_STORAGE_UNAVAILABLE",
    });
    expect(fixture.deleteBatches).toHaveLength(1);
    expect(fixture.deleteBatches[0]).toHaveLength(100);
    expect(fixture.finishCalls).toBe(0);
  });

  it("refuses finalization when the owner fence is lost after object deletion", async () => {
    const fixture = makeFixture({ staleAfterDelete: true });

    await expect(erase(fixture)).rejects.toMatchObject({
      status: 409,
      code: "LIFECYCLE_STATE_CONFLICT",
    });
    expect(fixture.deleteBatches).toHaveLength(1);
    expect(fixture.deleteBatches[0]).toHaveLength(1);
    expect(fixture.finishCalls).toBe(0);
    expect(fixture.rows).toHaveLength(1);
  });

  it("keeps the deleting state and retries after an object provider failure", async () => {
    const fixture = makeFixture({ failDeleteOnce: true });

    await expect(erase(fixture, FIRST_OPERATION)).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_STORAGE_UNAVAILABLE",
    });
    expect(fixture.tombstoneWrites).toBe(1);
    expect(fixture.deleteBatches).toHaveLength(1);
    expect(fixture.rows).toHaveLength(1);
    expect(fixture.finishCalls).toBe(0);
    expect(fixture.currentTarget()).toMatchObject({
      state: "deleting",
      deletionFence: FIRST_OPERATION,
    });

    await expect(erase(fixture, SECOND_OPERATION)).resolves.toEqual({
      deleted: true,
      alreadyDeleted: false,
      contributionsDeleted: 1,
    });
    expect(fixture.tombstoneWrites).toBe(2);
    expect(fixture.deleteBatches).toHaveLength(2);
    expect(fixture.rows).toHaveLength(1);
    expect(fixture.finishCalls).toBe(1);
  });

  it("returns a null count only when an independent ledger proves absence", async () => {
    const fixture = makeFixture({ target: null, ledgerPresent: true });

    await expect(erase(fixture)).resolves.toEqual({
      deleted: true,
      alreadyDeleted: true,
      contributionsDeleted: null,
    });
    expect(fixture.claimCalls).toBe(0);
    expect(fixture.countsCalls).toBe(0);
    expect(fixture.deleteBatches).toEqual([]);
    expect(fixture.finishCalls).toBe(0);
    expect(fixture.hookCalls).toBe(0);
  });
});
