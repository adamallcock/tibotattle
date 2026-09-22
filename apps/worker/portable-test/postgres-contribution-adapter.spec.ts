import { describe, expect, it, vi } from "vitest";
import {
  createExperimentalPostgresTelemetryV1ContributionStore,
  type PostgresTelemetryV1Client,
  type PostgresTelemetryV1Pool,
  type PostgresTelemetryV1QueryResult,
} from "../src/postgres-telemetry-v1-contribution-store";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  type TelemetryV1Chunk,
} from "../src/telemetry-v1";
import type { TelemetryV1ContributionWrite } from "../src/telemetry-v1-contribution-store";

const queryReceipt: PostgresTelemetryV1QueryResult = {
  rows: [{ accepted_records: 1 }],
  rowCount: 1,
};

function contribution(): TelemetryV1ContributionWrite {
  const chunk: TelemetryV1Chunk = {
    schemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    stream: "usage",
    chunkDay: "2026-09-15",
    chunkSeq: 0,
    chunkId: "usage:2026-09-15:0",
    chunkRevision: 1,
    chunkDigest: "a".repeat(64),
    parserVersion: "synthetic-parser-v1",
    consent: {
      telemetrySchemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
      fieldDictionaryVersion: TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
      privacyContractVersion: TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
    },
    records: [{
      schemaVersion: "usage-event-v1.0",
      eventId: "event-0001",
      eventTime: "2026-09-15T00:00:00.000Z",
      sessionUuid: "session-0001",
      provider: "synthetic",
      modelId: "synthetic-model",
      speedMode: "standard",
      apiServiceTier: "standard",
      surface: "synthetic",
      billingSurface: "synthetic",
      reasoningEffort: "none",
      agentScope: "synthetic",
      outcome: "success",
      totalInputContextTokens: 1,
      components: {
        inputUncachedTokens: 1,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTextTokens: 1,
        outputReasoningTokens: 0,
        outputCombinedTokens: 1,
      },
    }],
  };
  return {
    participantId: "participant-0001",
    deviceId: "device-0001",
    uploadAuthorizationId: "authorization-0001",
    uploadAuthorizationLeaseExpiresAt: "2026-09-15T00:30:00.000Z",
    chunkId: chunk.chunkId,
    objectKey: "telemetry/participant-0001/chunk-0001",
    envelopeDigest: "b".repeat(64),
    chunk,
    supersedes: null,
    createdAt: "2026-09-15T00:01:00.000Z",
  };
}

function mockPool(
  query: (text: string, values?: unknown[]) => Promise<PostgresTelemetryV1QueryResult>,
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const releases: boolean[] = [];
  const client: PostgresTelemetryV1Client = {
    async query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return query(text, values) as unknown as {
        readonly rows: readonly Row[];
        readonly rowCount: number | null;
      };
    },
    release(discard = false) {
      releases.push(discard);
    },
  };
  const connect = vi.fn(async () => client);
  const pool: PostgresTelemetryV1Pool = { connect };
  return { pool, client, connect, calls, releases };
}

function errorWithSqlState(code: string, message = "provider private details") {
  return Object.assign(new Error(message), { code });
}

describe("experimental PostgreSQL telemetry v1 contribution adapter", () => {
  it("uses one transaction, neutral JSON names, and the exact receipt", async () => {
    const fixture = contribution();
    const mocked = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        return queryReceipt;
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      createExperimentalPostgresTelemetryV1ContributionStore(mocked.pool).insert(fixture),
    ).resolves.toEqual({ acceptedRecords: 1 });
    expect(mocked.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout='10000ms'",
      "SET LOCAL lock_timeout='5000ms'",
      "SET LOCAL search_path TO \"tibotattle\", pg_catalog",
      "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)",
      "COMMIT",
    ]);
    expect(mocked.releases).toEqual([false]);
    const select = mocked.calls[4];
    const payload = JSON.parse(String(select?.values?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      participantId: fixture.participantId,
      deviceId: fixture.deviceId,
      uploadAuthorizationId: fixture.uploadAuthorizationId,
      uploadAuthorizationLeaseExpiresAt: fixture.uploadAuthorizationLeaseExpiresAt,
      objectKey: fixture.objectKey,
      envelopeDigest: fixture.envelopeDigest,
      supersedes: null,
      createdAt: fixture.createdAt,
    });
    expect(payload).not.toHaveProperty("r2Key");
    expect(payload).not.toHaveProperty("device_upload_authorization_id");
  });

  it.each([
    ["P1001", 409, "PARTICIPANT_DELETING"],
    ["P1002", 401, "UPLOAD_AUTH_INVALID"],
    ["P1003", 429, "CHUNK_ADMISSION_LIMIT_REACHED"],
    ["P1004", 409, "RECORD_OWNED_BY_OTHER_CHUNK"],
    ["P1005", 409, "CHUNK_REVISION_CONFLICT"],
    ["P1006", 403, "TELEMETRY_CONSENT_INVALID"],
    ["P1007", 409, "TELEMETRY_TRANSPORT_BLOCKED"],
  ] as const)("maps SQLSTATE %s without exposing provider text", async (sqlState, status, code) => {
    const mocked = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        throw errorWithSqlState(sqlState);
      }
      return { rows: [], rowCount: 0 };
    });

    const error = await createExperimentalPostgresTelemetryV1ContributionStore(mocked.pool)
      .insert(contribution()).catch((value: unknown) => value);
    expect(error).toMatchObject({ status, code });
    expect(String(error)).not.toContain("provider private details");
    expect(mocked.releases).toEqual([false]);
    expect(mocked.calls.at(-1)?.text).toBe("ROLLBACK");
    if (sqlState === "P1003") {
      expect((error as { responseHeaders?: HeadersInit }).responseHeaders).toEqual({ "retry-after": "60" });
    }
  });

  it("sanitizes unknown SQL errors and connection acquisition failures", async () => {
    const unknown = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        throw errorWithSqlState("23505", "secret table and participant details");
      }
      return { rows: [], rowCount: 0 };
    });
    const unknownError = await createExperimentalPostgresTelemetryV1ContributionStore(unknown.pool)
      .insert(contribution()).catch((value: unknown) => value);
    expect(unknownError).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(String(unknownError)).not.toContain("secret table");

    const connectError = new Error("secret connection string");
    const connect = vi.fn(async () => { throw connectError; });
    const pool: PostgresTelemetryV1Pool = { connect };
    const acquisitionError = await createExperimentalPostgresTelemetryV1ContributionStore(pool)
      .insert(contribution()).catch((value: unknown) => value);
    expect(acquisitionError).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(String(acquisitionError)).not.toContain("connection string");
  });

  it("rolls back malformed receipts before commit", async () => {
    const mocked = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        return { rows: [{ accepted_records: 1 }, { accepted_records: 1 }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    const error = await createExperimentalPostgresTelemetryV1ContributionStore(mocked.pool)
      .insert(contribution()).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(mocked.calls.map(({ text }) => text)).not.toContain("COMMIT");
    expect(mocked.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(mocked.releases).toEqual([false]);
  });

  it("discards the client after an uncertain COMMIT and never retries the write", async () => {
    const fixture = contribution();
    let selectCalls = 0;
    const mocked = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        selectCalls++;
        return queryReceipt;
      }
      if (text === "COMMIT") throw errorWithSqlState("08006", "commit may have reached the server");
      return { rows: [], rowCount: 0 };
    });

    const error = await createExperimentalPostgresTelemetryV1ContributionStore(mocked.pool)
      .insert(fixture).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(selectCalls).toBe(1);
    expect(mocked.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout='10000ms'",
      "SET LOCAL lock_timeout='5000ms'",
      "SET LOCAL search_path TO \"tibotattle\", pg_catalog",
      "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)",
      "COMMIT",
    ]);
    expect(mocked.releases).toEqual([true]);
  });

  it("discards the client when rollback itself fails", async () => {
    const mocked = mockPool(async (text) => {
      if (text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)") {
        throw new Error("private provider failure");
      }
      if (text === "ROLLBACK") throw new Error("private rollback failure");
      return { rows: [], rowCount: 0 };
    });

    const error = await createExperimentalPostgresTelemetryV1ContributionStore(mocked.pool)
      .insert(contribution()).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(mocked.releases).toEqual([true]);
    expect(mocked.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("freezes the provider payload before an awaited connection acquisition", async () => {
    const fixture = contribution();
    let resolveConnection!: (client: PostgresTelemetryV1Client) => void;
    const connection = new Promise<PostgresTelemetryV1Client>((resolve) => {
      resolveConnection = resolve;
    });
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client: PostgresTelemetryV1Client = {
      async query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]) {
        calls.push({ text, values });
        const result = text === "SELECT accepted_records FROM \"tibotattle\".\"insert_telemetry_v1_contribution\"($1::jsonb)"
          ? queryReceipt
          : { rows: [], rowCount: 0 };
        return result as unknown as {
          readonly rows: readonly Row[];
          readonly rowCount: number | null;
        };
      },
      release() {},
    };
    const pool: PostgresTelemetryV1Pool = { connect: async () => connection };
    const pending = createExperimentalPostgresTelemetryV1ContributionStore(pool).insert(fixture);
    fixture.chunk.chunkDigest = "c".repeat(64);
    (fixture.chunk.records[0] as { eventId: string }).eventId = "mutated-after-snapshot";
    resolveConnection(client);
    await expect(pending).resolves.toEqual({ acceptedRecords: 1 });
    const select = calls.find(({ text }) => text.startsWith("SELECT "));
    const payload = JSON.parse(String(select?.values?.[0])) as {
      chunk: { chunkDigest: string; records: Array<{ eventId: string }> };
    };
    expect(payload.chunk.chunkDigest).toBe("a".repeat(64));
    expect(payload.chunk.records[0]?.eventId).toBe("event-0001");
  });

  const oversizedRecords = Array.from(
    { length: 201 },
    () => contribution().chunk.records[0]!,
  );
  it.each([
    [[] as TelemetryV1Chunk["records"]],
    [oversizedRecords],
  ])("rejects record counts outside 1..200 before connecting (%s records)", async (records) => {
    const fixture = contribution();
    fixture.chunk.records = records;
    const connect = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const pool: PostgresTelemetryV1Pool = { connect };
    const error = await createExperimentalPostgresTelemetryV1ContributionStore(pool)
      .insert(fixture).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("sanitizes serialization failures before acquiring a client", async () => {
    const fixture = contribution();
    (fixture.chunk as unknown as { unrepresentable: bigint }).unrepresentable = 1n;
    const connect = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const pool: PostgresTelemetryV1Pool = { connect };
    const error = await createExperimentalPostgresTelemetryV1ContributionStore(pool)
      .insert(fixture).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect(connect).not.toHaveBeenCalled();
  });
});
