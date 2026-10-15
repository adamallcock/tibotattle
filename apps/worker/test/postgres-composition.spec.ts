import { describe, expect, it, vi } from "vitest";

import {
  createPostgresWorkerBackend,
  POSTGRES_ADMIN_HOST_ROUTE_IDS,
  POSTGRES_PORTED_WORKER_ROUTE_IDS,
  POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS,
} from "../src/backend-composition";
import { WORKER_ROUTE_POLICY } from "../src/route-registry";
import {
  handleRequest,
  isPostgresWorkerRequestPathSupported,
} from "../src/index";
import {
  setTimingSafeEqualImplementation,
  timingSafeEqual,
} from "../src/crypto";
import type { PostgresPool } from "../src/postgres-client";
import { grantPostgresTelemetryV12AccountlessAuthorization } from "../src/postgres-accountless-enrollment";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
} from "../src/telemetry-transport-policy";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";

function pool(): PostgresPool {
  return {
    async connect() {
      throw new Error("composition must not open a PostgreSQL connection");
    },
  };
}

describe("PostgreSQL migration foundation", () => {
  it("compares equal-length inputs and rejects mismatches", () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
  });

  it("validates one explicit primary pool without claiming current Worker readiness", () => {
    const primaryPool = pool();
    const backend = createPostgresWorkerBackend({ primaryPool });

    expect(backend.provider).toBe("postgres");
    expect(backend.applicationReady).toBe(false);
    expect(backend.schemas).toEqual({ primary: "tibotattle" });
    expect(backend.pools).toEqual({ primary: primaryPool });
    expect(Object.keys(backend.pools)).toEqual(["primary"]);
    expect(backend.unsupportedContracts).toEqual(POSTGRES_UNSUPPORTED_CURRENT_MAIN_CONTRACTS);
    expect(createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "tibotattle_isolated" },
    }).schemas).toEqual({ primary: "tibotattle_isolated" });
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "pg_catalog" },
    })).toThrow("invalid PostgreSQL schema configuration");
  });

  it("refuses the retired deletion-ledger pool and schema options", () => {
    // A stale caller fails closed rather than having either option ignored.
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: pool(),
    } as unknown as Parameters<typeof createPostgresWorkerBackend>[0])).toThrow("POSTGRES_LEDGER_POOL_RETIRED");
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      ledgerPool: undefined,
    } as unknown as Parameters<typeof createPostgresWorkerBackend>[0])).toThrow("POSTGRES_LEDGER_POOL_RETIRED");
    expect(() => createPostgresWorkerBackend({
      primaryPool: pool(),
      schemaOptions: { primarySchema: "tibotattle", ledgerSchema: "tibotattle_ledger" } as never,
    })).toThrow("invalid PostgreSQL schema configuration");
    expect(() => createPostgresWorkerBackend({ ledgerPool: pool() } as never)).toThrow("POSTGRES_POOL_INVALID");
  });

  it("does not route an injected PostgreSQL foundation through a D1 request handler", async () => {
    const backend = createPostgresWorkerBackend({ primaryPool: pool() });
    const response = await handleRequest(
      new Request("https://worker.test/api/v1/community/daily"),
      { POSTGRES_WORKER_BACKEND: backend } as unknown as Env,
      false,
    );

    expect(isPostgresWorkerRequestPathSupported()).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "POSTGRES_REQUEST_PATH_UNSUPPORTED" },
    });
  });

  it("names the origin's ported pathnames and keeps the zero-argument call false", () => {
    // OD-CR-1: the 21 scope routes plus all nine contested ones; OD-CR-2: the
    // six admin routes are admin-host only and the other 13 stay unported.
    expect(POSTGRES_PORTED_WORKER_ROUTE_IDS).toHaveLength(30);
    expect(Object.isFrozen(POSTGRES_PORTED_WORKER_ROUTE_IDS)).toBe(true);
    expect(POSTGRES_ADMIN_HOST_ROUTE_IDS).toEqual([
      "admin_overview", "admin_metrics_history", "admin_community_allowance_preview",
      "admin_database_health", "admin_reconstruction_progress", "admin_action",
    ]);
    const policyOrder = WORKER_ROUTE_POLICY.map((route) => route.id)
      .filter((id) => (POSTGRES_PORTED_WORKER_ROUTE_IDS as readonly string[]).includes(id));
    expect(policyOrder).toEqual([...POSTGRES_PORTED_WORKER_ROUTE_IDS]);
    expect(isPostgresWorkerRequestPathSupported("/api/v1/contributions")).toBe(true);
    expect(isPostgresWorkerRequestPathSupported("/api/ready")).toBe(true);
    expect(isPostgresWorkerRequestPathSupported("/api/v1/device/credential/renew")).toBe(true);
    for (const pathname of [
      "/api/v1/me/export",
      "/api/v1/admin/overview",
      "/.well-known/apple-developer-domain-association.txt",
      "/api/v1/me/telemetry-v12/effective-page",
      "/api/v1/enroll",
      "/api/v1/identity/google/start",
      "/api/v1/contributions/",
      "/api/v1/nope",
    ]) {
      expect(isPostgresWorkerRequestPathSupported(pathname)).toBe(false);
    }
    expect(isPostgresWorkerRequestPathSupported(undefined)).toBe(false);
    expect(isPostgresWorkerRequestPathSupported(["/api/ready"])).toBe(false);
    expect(isPostgresWorkerRequestPathSupported()).toBe(false);
  });

  it("lets a host install native timing-safe comparison without changing mismatch behavior", () => {
    const observed: Array<readonly [number, number[]]> = [];
    const restore = setTimingSafeEqualImplementation((left, right) => {
      observed.push([left.byteLength, Array.from(right)]);
      let difference = 0;
      for (let index = 0; index < left.byteLength; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      }
      return difference === 0;
    });
    try {
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
      expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
      expect(observed).toEqual([
        [2, [1, 2]],
        [2, [1, 3]],
        [2, [0, 0]],
      ]);
    } finally {
      restore();
    }
  });
});


const GRANT_CLOCK_BEFORE_LOCK = Date.parse("2026-10-13T00:00:00.000Z");
const GRANT_CLOCK_AFTER_LOCK = GRANT_CLOCK_BEFORE_LOCK + 2;
const GRANT_CLOCK_OWNER_EXPIRY = GRANT_CLOCK_BEFORE_LOCK + 60_000;
const GRANT_CLOCK_PRINCIPAL = Object.freeze({
  participantId: "participant:00000000-0000-4000-8000-000000000001",
  deviceId: "00000000-0000-4000-8000-000000000002",
});
const GRANT_CLOCK_REQUEST = Object.freeze({
  schemaVersion: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
});

function grantClockFixture(options: {
  readonly waitForLock?: () => Promise<void>;
  readonly existing?: Readonly<Record<string, unknown>>;
  readonly ownerExpiresAt?: number;
  readonly authorityPresent?: boolean;
  readonly insert?: boolean;
} = {}) {
  const ownerExpiresAt = options.ownerExpiresAt ?? GRANT_CLOCK_OWNER_EXPIRY;
  const owner = {
    enrollment_device_id: GRANT_CLOCK_PRINCIPAL.deviceId,
    participant_id: GRANT_CLOCK_PRINCIPAL.participantId,
    device_credential_id: GRANT_CLOCK_PRINCIPAL.deviceId,
    owner_expires_at: new Date(ownerExpiresAt).toISOString(),
  };
  const existing = {
    ...owner,
    schema_version: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
    policy_version: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
    authorization_basis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
    telemetry_schema_version: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    field_dictionary_version: TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
    privacy_contract_version: TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
    authorized_at: new Date(GRANT_CLOCK_BEFORE_LOCK + 1).toISOString(),
    expires_at: owner.owner_expires_at,
    state: "active",
    revoked_at: null,
    revocation_reason: null,
    ...options.existing,
  };
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("pg_advisory_xact_lock")) {
      await options.waitForLock?.();
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM \"tibotattle\".\"accountless_upload_owners\" owner")) {
      const authorized = options.authorityPresent !== false
        && Date.parse(values[2] as string) < ownerExpiresAt;
      return { rows: authorized ? [owner] : [], rowCount: authorized ? 1 : 0 };
    }
    if (text.startsWith("INSERT INTO \"tibotattle\".\"accountless_v12_device_authorizations\"")) {
      return { rows: [], rowCount: options.insert === true ? 1 : 0 };
    }
    if (text.includes("WHERE enrollment_device_id = $1 FOR UPDATE")) {
      return { rows: [existing], rowCount: 1 };
    }
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK"
        || text.startsWith("SET LOCAL ")) return { rows: [], rowCount: 0 };
    throw new Error("unexpected synthetic PostgreSQL statement");
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as PostgresPool, connect, query, release };
}

function authorityClock(fixture: ReturnType<typeof grantClockFixture>): string | undefined {
  return fixture.query.mock.calls.find(([text]) => text.includes(
    "FROM \"tibotattle\".\"accountless_upload_owners\" owner",
  ))?.[1]?.[2] as string | undefined;
}

function insertedClock(fixture: ReturnType<typeof grantClockFixture>): string | undefined {
  return fixture.query.mock.calls.find(([text]) => text.startsWith(
    "INSERT INTO \"tibotattle\".\"accountless_v12_device_authorizations\"",
  ))?.[1]?.[9] as string | undefined;
}

describe("PostgreSQL accountless v1.2 grant serialization clock", () => {
  it("samples its default clock after the lock wait and replays a grant committed during that wait", async () => {
    let nowEpoch = GRANT_CLOCK_BEFORE_LOCK;
    let unlock!: () => void;
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const lockReleased = new Promise<void>((resolve) => { unlock = resolve; });
    const fixture = grantClockFixture({ waitForLock: async () => {
      entered();
      await lockReleased;
    } });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowEpoch);
    let pending: Promise<void> | undefined;
    try {
      pending = grantPostgresTelemetryV12AccountlessAuthorization(
        fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST,
      );
      await lockEntered;
      expect(clock).not.toHaveBeenCalled();
      nowEpoch = GRANT_CLOCK_AFTER_LOCK;
      unlock();
      await expect(pending).resolves.toBeUndefined();
      expect(clock).toHaveBeenCalledTimes(1);
      const expected = new Date(GRANT_CLOCK_AFTER_LOCK).toISOString();
      expect(authorityClock(fixture)).toBe(expected);
      expect(insertedClock(fixture)).toBe(expected);
      expect(fixture.query.mock.calls.map(([text]) => text)).toContain("COMMIT");
      expect(fixture.query.mock.calls.map(([text]) => text)).not.toContain("ROLLBACK");
      expect(fixture.release).toHaveBeenCalledTimes(1);
    } finally {
      unlock();
      await pending?.catch(() => undefined);
      clock.mockRestore();
    }
  });

  it("uses the same post-lock clock for the first insertion", async () => {
    const fixture = grantClockFixture({ insert: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(GRANT_CLOCK_AFTER_LOCK);
    try {
      await grantPostgresTelemetryV12AccountlessAuthorization(
        fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST,
      );
      const expected = new Date(GRANT_CLOCK_AFTER_LOCK).toISOString();
      expect(authorityClock(fixture)).toBe(expected);
      expect(insertedClock(fixture)).toBe(expected);
      expect(clock).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("retains an explicit pinned clock and rejects a grant later than that clock", async () => {
    const fixture = grantClockFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(GRANT_CLOCK_AFTER_LOCK);
    try {
      await expect(grantPostgresTelemetryV12AccountlessAuthorization(
        fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST,
        { nowEpoch: GRANT_CLOCK_BEFORE_LOCK },
      )).rejects.toMatchObject({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
      expect(clock).not.toHaveBeenCalled();
      const expected = new Date(GRANT_CLOCK_BEFORE_LOCK).toISOString();
      expect(authorityClock(fixture)).toBe(expected);
      expect(insertedClock(fixture)).toBe(expected);
      expect(fixture.query.mock.calls.map(([text]) => text)).toContain("ROLLBACK");
      expect(fixture.query.mock.calls.map(([text]) => text)).not.toContain("COMMIT");
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the captured explicit clock if the caller changes its options during the lock wait", async () => {
    const options = { nowEpoch: GRANT_CLOCK_AFTER_LOCK };
    const fixture = grantClockFixture({ waitForLock: async () => {
      options.nowEpoch = GRANT_CLOCK_BEFORE_LOCK;
    } });
    await expect(grantPostgresTelemetryV12AccountlessAuthorization(
      fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST, options,
    )).resolves.toBeUndefined();
    const expected = new Date(GRANT_CLOCK_AFTER_LOCK).toISOString();
    expect(authorityClock(fixture)).toBe(expected);
    expect(insertedClock(fixture)).toBe(expected);
  });

  it("validates explicit clocks before opening a PostgreSQL connection", async () => {
    const fixture = grantClockFixture();
    for (const nowEpoch of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(grantPostgresTelemetryV12AccountlessAuthorization(
        fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST, { nowEpoch },
      )).rejects.toBeInstanceOf(TypeError);
    }
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["future", { authorized_at: new Date(GRANT_CLOCK_AFTER_LOCK + 1).toISOString() }],
    ["expired", { expires_at: new Date(GRANT_CLOCK_BEFORE_LOCK).toISOString() }],
    ["revoked", { state: "revoked", revoked_at: new Date(GRANT_CLOCK_BEFORE_LOCK).toISOString(),
      revocation_reason: "user_opt_out" }],
    ["wrong schema", { schema_version: "unrecognized-schema" }],
    ["wrong policy", { policy_version: "unrecognized-policy" }],
    ["wrong owner", { participant_id: "participant:00000000-0000-4000-8000-000000000003" }],
  ] as const)("keeps %s grants denied", async (_name, existing) => {
    const fixture = grantClockFixture({ existing });
    await expect(grantPostgresTelemetryV12AccountlessAuthorization(
      fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST,
      { nowEpoch: GRANT_CLOCK_AFTER_LOCK },
    )).rejects.toMatchObject({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
    expect(fixture.query.mock.calls.map(([text]) => text)).toContain("ROLLBACK");
  });

  it("denies an owner that expires while waiting for the grant lock", async () => {
    let nowEpoch = GRANT_CLOCK_BEFORE_LOCK;
    const fixture = grantClockFixture({
      ownerExpiresAt: GRANT_CLOCK_AFTER_LOCK,
      waitForLock: async () => { nowEpoch = GRANT_CLOCK_AFTER_LOCK; },
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowEpoch);
    try {
      await expect(grantPostgresTelemetryV12AccountlessAuthorization(
        fixture.pool, GRANT_CLOCK_PRINCIPAL, GRANT_CLOCK_REQUEST,
      )).rejects.toMatchObject({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
      expect(authorityClock(fixture)).toBe(new Date(GRANT_CLOCK_AFTER_LOCK).toISOString());
      expect(insertedClock(fixture)).toBeUndefined();
      expect(fixture.query.mock.calls.map(([text]) => text)).toContain("ROLLBACK");
    } finally {
      clock.mockRestore();
    }
  });
});
