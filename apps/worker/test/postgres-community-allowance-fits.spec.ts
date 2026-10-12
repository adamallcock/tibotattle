import { describe, expect, it } from "vitest";
import {
  COMMUNITY_ALLOWANCE_FIT_METHOD,
} from "../src/community-allowance";
import {
  persistPostgresCommunityAllowanceFitResult,
} from "../src/postgres-community-allowance-fits";
import { PostgresStorageError } from "../src/postgres-client";

const sourceId = "synthetic-fit-source";
const sourceNamespace = "synthetic-fit-namespace";
const ownerDigest = "e".repeat(64);
const participantId = "synthetic-fit-owner";
const generationId = "00000000-0000-4000-8000-000000000001";
const effectiveSourcePin = {
  sourceId,
  sourceNamespace,
  storageAuthorityEpoch: 0,
  sourceCursorSequence: 0,
  sourceCursorAuthorityEpoch: 0,
  v1ImportGeneration: 1,
  v1ImportDigest: "a".repeat(64),
  v11ImportGeneration: 1,
  v11ImportDigest: "b".repeat(64),
};
const sourcePin = {
  sourceId,
  sourceNamespace,
  sourceAuthorityEpoch: 0,
  analyticsAuthorityEpoch: 0,
  sequence: 0,
  telemetryV12RuntimeState: "active",
  telemetryV12RuntimeRevision: 0,
  telemetryV12TypedRuntimeState: "active",
  telemetryV12TypedRuntimePolicyRevision: 1,
  accountlessAuthorizationCount: 0,
  nextAccountlessAuthorizationExpiry: null,
  effectiveSourcePin,
  policyRevision: 1,
  collectionRevision: 2,
};
const ownerPin = {
  ...effectiveSourcePin,
  ownerDigest,
  participantId,
  inputRevision: 0,
  ownerRevision: 1,
  authorityEpoch: 0,
  v12State: "active:active",
  v12GenerationId: generationId,
};
const owner = {
  participantId,
  ownerDigest,
  inputRevision: 4,
  ownerRevision: 1,
  authorityEpoch: 0,
  sourceKind: "effective" as const,
  hasV1: false,
  hasV11: false,
  hasLegacy: false,
  hasV12: true as const,
  v12GenerationId: generationId,
  ownerPin,
};

describe("PostgreSQL persisted allowance-fit input contract", () => {
  it("rejects open source pins before acquiring a database connection", async () => {
    const input = {
      sourcePin: { ...sourcePin, unreviewed: true },
      owner,
      observedDay: "2026-09-23",
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      fits: [],
    };
    let connections = 0;
    const pool = { async connect() { connections += 1; throw new Error("must not connect"); } } as never;

    await expect(persistPostgresCommunityAllowanceFitResult(pool, input))
      .rejects.toMatchObject({ code: "invalid", operation: "community_fit.input" } satisfies Partial<PostgresStorageError>);
    expect(connections).toBe(0);
  });

  it("rejects a plan outside the telemetry contract allowlist before database access", async () => {
    let connections = 0;
    const pool = { async connect() { connections += 1; throw new Error("must not connect"); } } as never;

    await expect(persistPostgresCommunityAllowanceFitResult(pool, {
      sourcePin,
      owner,
      observedDay: "2026-09-23",
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      fits: [{ planType: "unrecognized-plan", capacityNanousd: 1, lastObservedAt: "2026-09-23T00:00:00.000Z" }],
    })).rejects.toMatchObject({ code: "invalid", operation: "community_fit.fit" });
    expect(connections).toBe(0);
  });

  it("requires the reviewed completed-fit method version", async () => {
    let connections = 0;
    const pool = { async connect() { connections += 1; throw new Error("must not connect"); } } as never;

    await expect(persistPostgresCommunityAllowanceFitResult(pool, {
      sourcePin,
      owner,
      observedDay: "2026-09-23",
      fitMethodVersion: "unreviewed-fit-method",
      fits: [],
    })).rejects.toMatchObject({ code: "invalid", operation: "community_fit.input" });
    expect(connections).toBe(0);
  });

  it("rejects owners with legacy-source presence while PostgreSQL correction parity is absent", async () => {
    let connections = 0;
    const pool = { async connect() { connections += 1; throw new Error("must not connect"); } } as never;

    await expect(persistPostgresCommunityAllowanceFitResult(pool, {
      sourcePin,
      owner: { ...owner, hasV1: true, hasLegacy: true },
      observedDay: "2026-09-23",
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      fits: [],
    })).rejects.toMatchObject({ code: "invalid", operation: "community_fit.input" });
    expect(connections).toBe(0);
  });
});
