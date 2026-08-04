import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKEND_LIFECYCLE_STALE_MILLISECONDS,
  QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
} from "../src/constants";
import {
  handleRequest,
  runScheduledMaintenance,
} from "../src/index";
import {
  putTrackedQuarantineObject,
  reconcilePendingQuarantineObjects,
  registerPendingQuarantineObject,
  type PendingQuarantineRegistration,
  type QuarantineObjectKind,
} from "../src/quarantine-reconciliation";
import { runBackendLifecycle } from "../src/retention";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const HOUR_MILLISECONDS = 60 * 60 * 1000;
const OLD_REGISTERED_AT = "2026-07-27T00:00:00.000Z";
const RECONCILIATION_NOW = Date.parse("2026-07-27T02:00:00.000Z");

function bindings(overrides: Partial<Env> = {}): Env {
  const runtime = env as TestBindings;
  return {
    ASSETS: runtime.ASSETS,
    DELETION_LEDGER: runtime.DELETION_LEDGER,
    ENROLLMENT_MODE: runtime.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: runtime.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: runtime.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: "",
    ENVELOPE_PUBLIC_JWK: "",
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    QUARANTINE: runtime.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: runtime.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: runtime.RECOVERY_RATE_LIMIT,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: runtime.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    UPLOAD_PRINCIPAL_RATE_LIMIT: runtime.UPLOAD_PRINCIPAL_RATE_LIMIT,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT:
      runtime.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT: runtime.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    UPLOAD_INGRESS_BUDGET: runtime.UPLOAD_INGRESS_BUDGET,
    UPLOAD_INGRESS_QUEUE_MODE: runtime.UPLOAD_INGRESS_QUEUE_MODE,
    UPLOAD_INGRESS_MAX_CONCURRENT: runtime.UPLOAD_INGRESS_MAX_CONCURRENT,
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE:
      runtime.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE,
    UPLOAD_INGRESS_BURST: runtime.UPLOAD_INGRESS_BURST,
    UPLOAD_INGRESS_LEASE_SECONDS: runtime.UPLOAD_INGRESS_LEASE_SECONDS,
    USAGE_MONITOR_DB: runtime.USAGE_MONITOR_DB,
    ...overrides,
  } as Env;
}

function registration(
  suffix: string,
  {
    objectKind = "telemetry",
    registeredAt = OLD_REGISTERED_AT,
  }: {
    objectKind?: QuarantineObjectKind;
    registeredAt?: string;
  } = {},
): PendingQuarantineRegistration {
  return {
    contributionId: `contribution:${suffix}`,
    objectKind,
    r2Key: `${objectKind}/${suffix}`,
    registeredAt,
  };
}

async function pendingCount(): Promise<number> {
  const row = await bindings().USAGE_MONITOR_DB.prepare(
    "SELECT COUNT(*) AS total FROM pending_quarantine_objects",
  ).first<{ total: number }>();
  return row?.total ?? -1;
}

async function seedParticipantAndUpload(
  suffix: string,
): Promise<{
  participantId: string;
  uploadAuthorizationId: string;
}> {
  const db = bindings().USAGE_MONITOR_DB;
  const participantId = `participant:${suffix}`;
  const sessionId = `session:${suffix}`;
  const uploadAuthorizationId = `upload:${suffix}`;
  const issuedAt = "2026-07-27T00:00:00.000Z";
  const expiresAt = "2099-07-27T00:00:00.000Z";
  await db.batch([
    db.prepare(
      `INSERT INTO participants (
        id, access_token_id, access_token_hash, recovery_token_id,
        recovery_token_hash, state, consent_version, consented_at,
        created_at, deletion_session_id
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
    ).bind(
      participantId,
      `access:${suffix}`,
      new Uint8Array(32),
      `recovery:${suffix}`,
      new Uint8Array(32),
      "privacy-safe-telemetry-v0.1",
      issuedAt,
      issuedAt,
    ),
    db.prepare(
      `INSERT INTO web_sessions (
        id, participant_id, secret_hash, csrf_hash, scope, state,
        issued_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?, NULL)`,
    ).bind(
      sessionId,
      participantId,
      new Uint8Array(32),
      new Uint8Array(32),
      issuedAt,
      expiresAt,
      issuedAt,
    ),
    db.prepare(
      `INSERT INTO upload_authorizations (
        id, participant_id, issued_by_session_id, secret_hash,
        envelope_digest, body_bytes, content_type, state, issued_at,
        expires_at, consumed_at, revoked_at, consume_lease_expires_at,
        consumed_contribution_id
      ) VALUES (?, ?, ?, ?, ?, 1, 'application/json', 'consuming', ?, ?,
                NULL, NULL, ?, NULL)`,
    ).bind(
      uploadAuthorizationId,
      participantId,
      sessionId,
      new Uint8Array(32),
      "a".repeat(64),
      issuedAt,
      expiresAt,
      expiresAt,
    ),
  ]);
  return { participantId, uploadAuthorizationId };
}

async function insertCanonicalContribution(
  object: PendingQuarantineRegistration,
  suffix: string,
): Promise<void> {
  const db = bindings().USAGE_MONITOR_DB;
  const authority = await seedParticipantAndUpload(suffix);
  if (object.objectKind === "synthetic") {
    await db.prepare(
      `INSERT INTO contributions (
        id, participant_id, envelope_digest, r2_key,
        envelope_schema_version, key_id, status, fixture_id, range_start,
        range_end, quota_window_minutes, quota_used_percent_before,
        quota_used_percent_after, quota_display_precision, model_id,
        subscription_speed, api_tier_assumption, input_uncached_tokens,
        input_cached_tokens, output_text_tokens, output_reasoning_tokens,
        web_search_calls, unknown_tool_units, estimated_api_cost_usd,
        priced_event_coverage_percent, unknown_billable_units, price_basis,
        created_at, upload_authorization_id
      ) VALUES (
        ?, ?, ?, ?, 'synthetic-envelope-v0.1', 'key:test',
        'accepted_synthetic', 'codex-weekly-demo-v0.1', ?, ?, 300, 10, 20,
        0, 'gpt-test', 'standard', 'standard', 1, 1, 1, 1, 0, 0,
        '0.000001', 100, 0, 'test', ?, ?
      )`,
    ).bind(
      object.contributionId,
      authority.participantId,
      "b".repeat(64),
      object.r2Key,
      "2026-07-27T00:00:00.000Z",
      "2026-07-27T00:30:00.000Z",
      "2026-07-27T00:30:00.000Z",
      authority.uploadAuthorizationId,
    ).run();
    return;
  }
  await db.prepare(
    `INSERT INTO telemetry_contributions (
      id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
      schema_version, range_start, range_end, client_platform,
      provider_policy_epoch, estimated_api_cost_usd,
      priced_event_coverage_percent, unknown_model_event_count,
      unknown_billable_units, price_basis, declared_record_count, created_at,
      upload_authorization_id
    ) VALUES (
      ?, ?, ?, ?, ?, 'accepted', 'telemetry-contribution-v0.1', ?, ?,
      'macos', 'test-policy', '0.000001', 100, 0, 0, 'test', 0, ?, ?
    )`,
  ).bind(
    object.contributionId,
    authority.participantId,
    "c".repeat(64),
    "d".repeat(64),
    object.r2Key,
    "2026-07-27T00:00:00.000Z",
    "2026-07-27T00:30:00.000Z",
    "2026-07-27T00:30:00.000Z",
    authority.uploadAuthorizationId,
  ).run();
}

function r2Proxy(
  base: R2Bucket,
  overrides: {
    delete?: (key: string | string[]) => Promise<void>;
    head?: (key: string) => Promise<R2Object | null>;
    put?: (
      key: string,
      value: string,
      options?: R2PutOptions,
    ) => Promise<R2Object>;
  },
): R2Bucket {
  return new Proxy(base, {
    get(target, property) {
      if (property === "delete" && overrides.delete) return overrides.delete;
      if (property === "head" && overrides.head) return overrides.head;
      if (property === "put" && overrides.put) return overrides.put;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pauseFirstReferenceRead(
  base: D1Database,
  reached: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): D1Database {
  let paused = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => (
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (property === "first") {
          return async (columnName?: string) => {
            if (!paused) {
              paused = true;
              reached.resolve();
              await release.promise;
            }
            return columnName === undefined
              ? target.first()
              : target.first(columnName);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
  );
  return d1PrepareProxy(base, (query) => {
    const statement = base.prepare(query);
    return query.includes("SELECT CASE") ? wrap(statement) : statement;
  });
}

function pauseFirstLeaseFence(
  base: D1Database,
  reached: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): D1Database {
  let paused = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => (
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (property === "first") {
          return async (columnName?: string) => {
            if (!paused) {
              paused = true;
              reached.resolve();
              await release.promise;
            }
            return columnName === undefined
              ? target.first()
              : target.first(columnName);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
  );
  return d1PrepareProxy(base, (query) => {
    const statement = base.prepare(query);
    return query.includes("AS lease_active") ? wrap(statement) : statement;
  });
}

function d1PrepareProxy(
  base: D1Database,
  prepare: (query: string) => D1PreparedStatement,
): D1Database {
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") return prepare;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function markLifecycleAndReconciliationComplete(
  nowEpoch = Date.now(),
): Promise<void> {
  await runBackendLifecycle(
    bindings().USAGE_MONITOR_DB,
    bindings().DELETION_LEDGER,
    bindings().QUARANTINE,
    nowEpoch,
  );
  await reconcilePendingQuarantineObjects(
    bindings().USAGE_MONITOR_DB,
    bindings().QUARANTINE,
    nowEpoch,
  );
}

async function ready(): Promise<Response> {
  return handleRequest(
    new Request("https://example.test/api/ready"),
    bindings(),
  );
}

beforeEach(async () => {
  await reset();
  const runtime = env as TestBindings;
  await applyD1Migrations(
    runtime.USAGE_MONITOR_DB,
    runtime.TEST_MIGRATIONS,
  );
  await applyD1Migrations(
    runtime.DELETION_LEDGER,
    runtime.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("quarantine crash reconciliation", () => {
  it("registers before put and recovers a put-before-D1 termination", async () => {
    const object = registration("put-before-d1");
    const baseBucket = bindings().QUARANTINE;
    const terminatingBucket = r2Proxy(baseBucket, {
      async put(key, value, options) {
        expect(await pendingCount()).toBe(1);
        await baseBucket.put(key, value, options);
        throw new Error("injected termination after R2 put");
      },
    });

    await expect(putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      terminatingBucket,
      object,
      "{}",
      { httpMetadata: { contentType: "application/json" } },
    )).rejects.toThrow("injected termination after R2 put");
    expect(await pendingCount()).toBe(1);
    expect(await baseBucket.head(object.r2Key)).not.toBeNull();

    await expect(reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      baseBucket,
      RECONCILIATION_NOW,
    )).resolves.toEqual({
      reconciliationCutoffAt: "2026-07-27T01:00:00.000Z",
      registrationsExamined: 1,
      orphanObjectsDeleted: 1,
      referencedObjectsPreserved: 0,
      reconciliationComplete: true,
    });
    expect(await pendingCount()).toBe(0);
    expect(await baseBucket.head(object.r2Key)).toBeNull();
  });

  it("preserves unreferenced objects inside the grace period", async () => {
    const registeredAt = "2026-07-27T01:30:00.000Z";
    const object = registration("inside-grace", { registeredAt });
    await putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      object,
      "{}",
    );
    const result = await reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      Date.parse(registeredAt)
        + QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS - 1,
    );
    expect(result).toMatchObject({
      registrationsExamined: 0,
      orphanObjectsDeleted: 0,
      reconciliationComplete: true,
    });
    expect(await pendingCount()).toBe(1);
    expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();
  });

  it("purges expired OIDC handoffs in bounded scheduled batches without retaining identity link keys", async () => {
    const now = Date.now();
    const expiredAt = new Date(now - 1_000).toISOString();
    const activeAt = new Date(now + 60_000).toISOString();
    const db = bindings().USAGE_MONITOR_DB;
    const identityLinkKey = "a".repeat(64);
    for (let index = 0; index < 101; index += 1) {
      await db.prepare(
        `INSERT INTO apple_signin_handoffs
           (state, identity_link_key, proof, created_at, expires_at, delivered_at)
         VALUES (?, ?, NULL, ?, ?, NULL)`,
      ).bind(
        `apple-expired-${index}`,
        identityLinkKey,
        expiredAt,
        expiredAt,
      ).run();
    }
    await db.prepare(
      `INSERT INTO apple_signin_handoffs
         (state, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES ('apple-active', ?, NULL, ?, ?, NULL)`,
    ).bind(identityLinkKey, new Date(now).toISOString(), activeAt).run();
    await db.prepare(
      `INSERT INTO google_signin_handoffs
         (state, code_verifier, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES ('google-expired', NULL, ?, NULL, ?, ?, NULL)`,
    ).bind(identityLinkKey, expiredAt, expiredAt).run();

    const first = await runScheduledMaintenance(bindings(), now);
    expect(first).toMatchObject({
      expiredIdentityHandoffsPurged: 101,
      expiredIdentityHandoffPurgeComplete: false,
    });
    const remainingAfterFirst = await db.prepare(
      `SELECT COUNT(*) AS total FROM apple_signin_handoffs WHERE expires_at <= ?`,
    ).bind(new Date(now).toISOString()).first<{ total: number }>();
    expect(remainingAfterFirst?.total).toBe(1);

    const second = await runScheduledMaintenance(bindings(), now + 1);
    expect(second).toMatchObject({
      expiredIdentityHandoffsPurged: 1,
      expiredIdentityHandoffPurgeComplete: true,
    });
    const expiredRows = await db.prepare(
      `SELECT COUNT(*) AS total
         FROM (
           SELECT state FROM apple_signin_handoffs WHERE expires_at <= ?
           UNION ALL
           SELECT state FROM google_signin_handoffs WHERE expires_at <= ?
         )`,
    ).bind(new Date(now + 1).toISOString(), new Date(now + 1).toISOString()).first<{
      total: number;
    }>();
    expect(expiredRows?.total).toBe(0);
    const activeRows = await db.prepare(
      `SELECT COUNT(*) AS total FROM apple_signin_handoffs WHERE state = 'apple-active'`,
    ).first<{ total: number }>();
    expect(activeRows?.total).toBe(1);
  });

  it.each<QuarantineObjectKind>(["synthetic", "telemetry"])(
    "preserves a stale %s object referenced by a canonical table",
    async (objectKind) => {
      const object = registration(`referenced-${objectKind}`, { objectKind });
      await insertCanonicalContribution(
        object,
        `referenced-authority-${objectKind}`,
      );
      await putTrackedQuarantineObject(
        bindings().USAGE_MONITOR_DB,
        bindings().QUARANTINE,
        object,
        "{}",
      );
      const result = await reconcilePendingQuarantineObjects(
        bindings().USAGE_MONITOR_DB,
        bindings().QUARANTINE,
        RECONCILIATION_NOW,
      );
      expect(result).toMatchObject({
        registrationsExamined: 1,
        orphanObjectsDeleted: 0,
        referencedObjectsPreserved: 1,
        reconciliationComplete: true,
      });
      expect(await pendingCount()).toBe(0);
      expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();
    },
  );

  it("clears registration in the canonical contribution transaction", async () => {
    const object = registration("canonical-trigger");
    await putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      object,
      "{}",
    );
    expect(await pendingCount()).toBe(1);
    await insertCanonicalContribution(object, "canonical-trigger-authority");
    expect(await pendingCount()).toBe(0);
    expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();
  });

  it("retains failed R2 work and retries it idempotently", async () => {
    const object = registration("r2-retry");
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      baseBucket,
      object,
      "{}",
    );
    const failingBucket = r2Proxy(baseBucket, {
      async delete() {
        throw new Error("injected R2 delete failure");
      },
    });
    await expect(reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      failingBucket,
      RECONCILIATION_NOW,
    )).rejects.toThrow("injected R2 delete failure");
    const failed = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT state, reconciliation_complete, failure_code
         FROM quarantine_reconciliation_state WHERE singleton = 1`,
    ).first<{
      state: string;
      reconciliation_complete: number;
      failure_code: string;
    }>();
    expect(failed).toEqual({
      state: "failed",
      reconciliation_complete: 0,
      failure_code: "QUARANTINE_RECONCILIATION_FAILED",
    });
    expect(await pendingCount()).toBe(1);
    expect(await baseBucket.head(object.r2Key)).not.toBeNull();

    await expect(reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      baseBucket,
      RECONCILIATION_NOW + 1,
    )).resolves.toMatchObject({
      orphanObjectsDeleted: 1,
      reconciliationComplete: true,
    });
    expect(await pendingCount()).toBe(0);
    expect(await baseBucket.head(object.r2Key)).toBeNull();
  });

  it("marks a D1 read failure retryable without deleting the object", async () => {
    const object = registration("d1-retry");
    const baseDb = bindings().USAGE_MONITOR_DB;
    await putTrackedQuarantineObject(
      baseDb,
      bindings().QUARANTINE,
      object,
      "{}",
    );
    let failReferenceRead = true;
    const failingDb = d1PrepareProxy(baseDb, (query) => {
      if (failReferenceRead && query.includes("SELECT CASE")) {
        failReferenceRead = false;
        throw new Error("injected D1 reference read failure");
      }
      return baseDb.prepare(query);
    });
    await expect(reconcilePendingQuarantineObjects(
      failingDb,
      bindings().QUARANTINE,
      RECONCILIATION_NOW,
    )).rejects.toThrow("injected D1 reference read failure");
    await expect(baseDb.prepare(
      `SELECT state FROM quarantine_reconciliation_state WHERE singleton = 1`,
    ).first<{ state: string }>()).resolves.toEqual({ state: "failed" });
    expect(await pendingCount()).toBe(1);
    expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();

    await expect(reconcilePendingQuarantineObjects(
      baseDb,
      bindings().QUARANTINE,
      RECONCILIATION_NOW + 1,
    )).resolves.toMatchObject({
      orphanObjectsDeleted: 1,
      reconciliationComplete: true,
    });
  });

  it("persists and resumes a bounded reconciliation cursor", async () => {
    for (const suffix of ["cursor-a", "cursor-b", "cursor-c"]) {
      await registerPendingQuarantineObject(
        bindings().USAGE_MONITOR_DB,
        registration(suffix),
      );
    }
    const first = await reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      RECONCILIATION_NOW,
      2,
    );
    expect(first).toMatchObject({
      registrationsExamined: 2,
      reconciliationComplete: false,
    });
    const cursor = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT state, cursor_registered_at, cursor_r2_key,
              reconciliation_complete
         FROM quarantine_reconciliation_state WHERE singleton = 1`,
    ).first<{
      state: string;
      cursor_registered_at: string;
      cursor_r2_key: string;
      reconciliation_complete: number;
    }>();
    expect(cursor).toEqual({
      state: "completed",
      cursor_registered_at: OLD_REGISTERED_AT,
      cursor_r2_key: "telemetry/cursor-b",
      reconciliation_complete: 0,
    });
    expect(await pendingCount()).toBe(1);

    const second = await reconcilePendingQuarantineObjects(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      RECONCILIATION_NOW + 1,
      2,
    );
    expect(second).toMatchObject({
      registrationsExamined: 1,
      reconciliationComplete: true,
    });
    const completed = await bindings().USAGE_MONITOR_DB.prepare(
      `SELECT cursor_registered_at, cursor_r2_key, registrations_examined,
              reconciliation_complete
         FROM quarantine_reconciliation_state WHERE singleton = 1`,
    ).first<{
      cursor_registered_at: string | null;
      cursor_r2_key: string | null;
      registrations_examined: number;
      reconciliation_complete: number;
    }>();
    expect(completed).toEqual({
      cursor_registered_at: null,
      cursor_r2_key: null,
      registrations_examined: 3,
      reconciliation_complete: 1,
    });
    expect(await pendingCount()).toBe(0);
  });

  it("fences an expired worker after its replacement claims the row", async () => {
    const object = registration("expired-lease-race");
    const baseDb = bindings().USAGE_MONITOR_DB;
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(baseDb, baseBucket, object, "{}");

    const staleReferenceReached = deferred();
    const releaseStaleReference = deferred();
    const staleDb = pauseFirstReferenceRead(
      baseDb,
      staleReferenceReached,
      releaseStaleReference,
    );
    let staleHeadCalled = false;
    const staleBucket = r2Proxy(baseBucket, {
      async head(key) {
        staleHeadCalled = true;
        throw new Error(`stale worker reached R2 head for ${key}`);
      },
    });
    const staleRun = reconcilePendingQuarantineObjects(
      staleDb,
      staleBucket,
      RECONCILIATION_NOW,
    );
    const staleOutcome = expect(staleRun).rejects.toThrow(
      "LIFECYCLE_STATE_CONFLICT",
    );
    await staleReferenceReached.promise;

    const replacementHeadReached = deferred();
    const releaseReplacementHead = deferred();
    const replacementBucket = r2Proxy(baseBucket, {
      async head(key) {
        const objectAtClaim = await baseBucket.head(key);
        replacementHeadReached.resolve();
        await releaseReplacementHead.promise;
        return objectAtClaim;
      },
    });
    const replacementRun = reconcilePendingQuarantineObjects(
      baseDb,
      replacementBucket,
      RECONCILIATION_NOW + HOUR_MILLISECONDS,
    );
    await replacementHeadReached.promise;

    releaseStaleReference.resolve();
    await staleOutcome;
    expect(staleHeadCalled).toBe(false);
    const fenced = await baseDb.prepare(
      `SELECT pending.reconciliation_state,
              pending.reconciliation_lease_id = state.lease_id AS fenced
         FROM pending_quarantine_objects pending
         JOIN quarantine_reconciliation_state state ON state.singleton = 1
        WHERE pending.r2_key = ?`,
    ).bind(object.r2Key).first<{
      reconciliation_state: string;
      fenced: number;
    }>();
    expect(fenced).toEqual({
      reconciliation_state: "deleting",
      fenced: 1,
    });

    releaseReplacementHead.resolve();
    await expect(replacementRun).resolves.toMatchObject({
      orphanObjectsDeleted: 1,
      reconciliationComplete: true,
    });
    expect(await pendingCount()).toBe(0);
    expect(await baseBucket.head(object.r2Key)).toBeNull();
  });

  it("fences an expired worker that paused after claiming the row", async () => {
    const object = registration("expired-after-claim");
    const baseDb = bindings().USAGE_MONITOR_DB;
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(baseDb, baseBucket, object, "{}");

    const staleFenceReached = deferred();
    const releaseStaleFence = deferred();
    const staleDb = pauseFirstLeaseFence(
      baseDb,
      staleFenceReached,
      releaseStaleFence,
    );
    let staleHeadCalled = false;
    const staleBucket = r2Proxy(baseBucket, {
      async head(key) {
        staleHeadCalled = true;
        throw new Error(`stale worker reached R2 head for ${key}`);
      },
    });
    const staleRun = reconcilePendingQuarantineObjects(
      staleDb,
      staleBucket,
      RECONCILIATION_NOW,
    );
    const staleOutcome = expect(staleRun).rejects.toThrow(
      "LIFECYCLE_STATE_CONFLICT",
    );
    await staleFenceReached.promise;

    const replacementHeadReached = deferred();
    const releaseReplacementHead = deferred();
    const replacementBucket = r2Proxy(baseBucket, {
      async head(key) {
        const objectAtClaim = await baseBucket.head(key);
        replacementHeadReached.resolve();
        await releaseReplacementHead.promise;
        return objectAtClaim;
      },
    });
    const replacementRun = reconcilePendingQuarantineObjects(
      baseDb,
      replacementBucket,
      RECONCILIATION_NOW + HOUR_MILLISECONDS,
    );
    await replacementHeadReached.promise;

    releaseStaleFence.resolve();
    await staleOutcome;
    expect(staleHeadCalled).toBe(false);

    releaseReplacementHead.resolve();
    await expect(replacementRun).resolves.toMatchObject({
      orphanObjectsDeleted: 1,
      reconciliationComplete: true,
    });
    expect(await pendingCount()).toBe(0);
    expect(await baseBucket.head(object.r2Key)).toBeNull();
  });
});

describe("backend readiness and scheduled observability", () => {
  it("stops a lifecycle pass before a later destructive phase when its owner is fenced", async () => {
    const object = registration("lifecycle-phase-fence");
    const baseDb = bindings().USAGE_MONITOR_DB;
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(baseDb, baseBucket, object, "{}");
    await insertCanonicalContribution(object, "lifecycle-phase-fence");

    let guardCalls = 0;
    await expect(runBackendLifecycle(
      baseDb,
      bindings().DELETION_LEDGER,
      baseBucket,
      Date.parse("2026-08-04T00:00:00.000Z"),
      async () => {
        guardCalls += 1;
        // Permit state setup and restore replay, then fence before R2
        // retention so an old maintenance owner cannot delete the object.
        return guardCalls < 3;
      },
    )).rejects.toMatchObject({ code: "LIFECYCLE_STATE_CONFLICT" });

    expect(guardCalls).toBe(3);
    expect(await baseBucket.head(object.r2Key)).not.toBeNull();
    await expect(baseDb.prepare(
      "SELECT state FROM retention_state WHERE singleton = 1",
    ).first<{ state: string }>()).resolves.toEqual({ state: "running" });
  });

  it("fences an expired maintenance owner before it can begin reconciliation", async () => {
    const object = registration("maintenance-expiry-fence");
    const baseDb = bindings().USAGE_MONITOR_DB;
    await putTrackedQuarantineObject(baseDb, bindings().QUARANTINE, object, "{}");

    let successorToken = "";
    let takeoverComplete = false;
    const fencedDb = d1PrepareProxy(baseDb, (query) => {
      const statement = baseDb.prepare(query);
      if (takeoverComplete
          || !query.includes("SET state = 'completed'")
          || !query.includes("quarantine_retention_complete")) {
        return statement;
      }
      const takeOverAfterLifecycle = (candidate: D1PreparedStatement): D1PreparedStatement => (
        new Proxy(candidate, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => takeOverAfterLifecycle(target.bind(...values));
          }
          if (property === "run") {
            return async () => {
              const result = await target.run();
              const now = new Date().toISOString();
              await baseDb.prepare(
                `UPDATE retention_state
                    SET maintenance_lease_expires_at = '2000-01-01T00:00:00.000Z'
                  WHERE singleton = 1`,
              ).run();
              successorToken = crypto.randomUUID();
              const successor = await baseDb.prepare(
                `UPDATE retention_state
                    SET maintenance_lease_token = ?, maintenance_lease_expires_at = ?
                  WHERE singleton = 1 AND maintenance_lease_expires_at <= ?`,
              ).bind(
                successorToken,
                new Date(Date.now() + HOUR_MILLISECONDS).toISOString(),
                now,
              ).run();
              if (successor.meta.changes !== 1) {
                throw new Error("successor could not acquire expired maintenance lease");
              }
              takeoverComplete = true;
              return result;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
        }) as D1PreparedStatement
      );
      return takeOverAfterLifecycle(statement);
    });

    await expect(runScheduledMaintenance(
      bindings({ USAGE_MONITOR_DB: fencedDb }),
      RECONCILIATION_NOW,
    )).rejects.toMatchObject({ code: "LIFECYCLE_STATE_CONFLICT" });
    expect(takeoverComplete).toBe(true);
    expect(await pendingCount()).toBe(1);
    expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();
    await expect(baseDb.prepare(
      `SELECT maintenance_lease_token, maintenance_lease_expires_at
         FROM retention_state WHERE singleton = 1`,
    ).first<{
      maintenance_lease_token: string | null;
      maintenance_lease_expires_at: string | null;
    }>()).resolves.toMatchObject({
      maintenance_lease_token: successorToken,
      maintenance_lease_expires_at: expect.stringMatching(/Z$/u),
    });
    await expect(baseDb.prepare(
      `SELECT state FROM quarantine_reconciliation_state WHERE singleton = 1`,
    ).first<{ state: string }>()).resolves.toEqual({ state: "never_run" });
  });

  it("preserves the original maintenance failure when a successor owns release", async () => {
    const object = registration("maintenance-release-takeover");
    const baseDb = bindings().USAGE_MONITOR_DB;
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(baseDb, baseBucket, object, "{}");
    let successorToken = "";
    const failingBucket = r2Proxy(baseBucket, {
      async delete() {
        const now = new Date().toISOString();
        await baseDb.prepare(
          `UPDATE retention_state
              SET maintenance_lease_expires_at = '2000-01-01T00:00:00.000Z'
            WHERE singleton = 1`,
        ).run();
        successorToken = crypto.randomUUID();
        const successor = await baseDb.prepare(
          `UPDATE retention_state
              SET maintenance_lease_token = ?, maintenance_lease_expires_at = ?
            WHERE singleton = 1 AND maintenance_lease_expires_at <= ?`,
        ).bind(
          successorToken,
          new Date(Date.now() + HOUR_MILLISECONDS).toISOString(),
          now,
        ).run();
        if (successor.meta.changes !== 1) {
          throw new Error("successor could not acquire expired maintenance lease");
        }
        throw new Error("injected original reconciliation failure");
      },
    });

    await expect(runScheduledMaintenance(
      bindings({ QUARANTINE: failingBucket }),
      RECONCILIATION_NOW,
    )).rejects.toThrow("injected original reconciliation failure");
    await expect(baseDb.prepare(
      `SELECT maintenance_lease_token FROM retention_state WHERE singleton = 1`,
    ).first<{ maintenance_lease_token: string | null }>()).resolves.toEqual({
      maintenance_lease_token: successorToken,
    });
  });

  it("fails readiness closed before the first lifecycle run", async () => {
    const response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: {
        lifecycle: "never_run",
        lifecycleFresh: false,
        quarantineReconciliation: "never_run",
        quarantineReconciliationComplete: false,
      },
    });
  });

  it("reports ready only after fresh complete maintenance", async () => {
    await markLifecycleAndReconciliationComplete();
    const response = await ready();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: {
        lifecycle: "ready",
        lifecycleFresh: true,
        quarantineRetentionComplete: true,
        restoreReplayComplete: true,
        aggregateRebuildComplete: true,
        maintenanceCycleMatched: true,
        quarantineReconciliation: "completed",
        quarantineReconciliationComplete: true,
      },
      policy: {
        lifecycleStaleAfterMilliseconds:
          BACKEND_LIFECYCLE_STALE_MILLISECONDS,
      },
    });
  });

  it("stays unready if retention completes but reconciliation never starts", async () => {
    const firstRunAt = Date.now() - 1_000;
    await markLifecycleAndReconciliationComplete(firstRunAt);
    const object = registration("crash-before-reconciliation");
    await putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      bindings().QUARANTINE,
      object,
      "{}",
    );
    await runBackendLifecycle(
      bindings().USAGE_MONITOR_DB,
      bindings().DELETION_LEDGER,
      bindings().QUARANTINE,
      firstRunAt + 1,
    );

    const response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: {
        lifecycle: "ready",
        lifecycleFresh: true,
        maintenanceCycleMatched: false,
        quarantineReconciliation: "completed",
        quarantineReconciliationComplete: false,
      },
    });
    expect(await pendingCount()).toBe(1);
    expect(await bindings().QUARANTINE.head(object.r2Key)).not.toBeNull();
  });

  it("returns 503 for stale, failed, or incomplete lifecycle state", async () => {
    await markLifecycleAndReconciliationComplete();
    const db = bindings().USAGE_MONITOR_DB;
    await db.prepare(
      `UPDATE retention_state
          SET last_completed_at = ?
        WHERE singleton = 1`,
    ).bind(
      new Date(
        Date.now() - BACKEND_LIFECYCLE_STALE_MILLISECONDS - 1,
      ).toISOString(),
    ).run();
    let response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { lifecycle: "stale", lifecycleFresh: false },
    });

    await db.prepare(
      `UPDATE retention_state
          SET state = 'failed',
              last_completed_at = ?
        WHERE singleton = 1`,
    ).bind(new Date().toISOString()).run();
    response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { lifecycle: "failed", lifecycleFresh: false },
    });

    await db.prepare(
      `UPDATE retention_state
          SET state = 'completed',
              restore_replay_complete = 0
        WHERE singleton = 1`,
    ).run();
    response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: {
        lifecycle: "incomplete",
        lifecycleFresh: true,
        restoreReplayComplete: false,
      },
    });
  });

  it("returns 503 for pending rebuild or reconciliation work", async () => {
    await markLifecycleAndReconciliationComplete();
    const db = bindings().USAGE_MONITOR_DB;
    await db.prepare(
      `INSERT INTO community_weekly_snapshot_rebuilds (
        week_start, week_end, ingestion_cutoff_at, requested_epoch,
        requested_at
      ) VALUES (?, ?, ?, 1, ?)`,
    ).bind(
      "2026-07-06T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-27T00:00:00.000Z",
    ).run();
    let response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { aggregateRebuildComplete: false },
    });

    await db.prepare(
      "DELETE FROM community_weekly_snapshot_rebuilds",
    ).run();
    await db.prepare(
      `UPDATE quarantine_reconciliation_state
          SET reconciliation_complete = 0
        WHERE singleton = 1`,
    ).run();
    response = await ready();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: {
        aggregateRebuildComplete: true,
        quarantineReconciliationComplete: false,
      },
    });
  });

  it("emits a fixed-field scheduled success log", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      await runScheduledMaintenance(bindings(), Date.now());
    } finally {
      console.log = originalLog;
    }
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({
      level: "info",
      event: "scheduled_backend_maintenance",
      outcome: "success",
      code: "OK",
      lifecycleComplete: true,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      quarantineReconciliationComplete: true,
      expiredIdentityHandoffsPurged: 0,
      expiredIdentityHandoffPurgeComplete: true,
      aggregateRebuildComplete: true,
      publicationEnabled: true,
    });
  });

  it("emits a fixed-field failure log without object details", async () => {
    const object = registration("PRIVATE_OBJECT_KEY_CANARY");
    const baseBucket = bindings().QUARANTINE;
    await putTrackedQuarantineObject(
      bindings().USAGE_MONITOR_DB,
      baseBucket,
      object,
      "{}",
    );
    const failingBucket = r2Proxy(baseBucket, {
      async delete(key) {
        throw new Error(`injected deletion failure for ${String(key)}`);
      },
    });
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      await expect(runScheduledMaintenance(
        bindings({ QUARANTINE: failingBucket }),
        RECONCILIATION_NOW,
      )).rejects.toThrow("injected deletion failure");
    } finally {
      console.error = originalError;
    }
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({
      level: "error",
      event: "scheduled_backend_maintenance",
      outcome: "failure",
      code: "INTERNAL_ERROR",
      lifecycleComplete: true,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      quarantineReconciliationComplete: false,
      expiredIdentityHandoffsPurged: 0,
      expiredIdentityHandoffPurgeComplete: true,
      aggregateRebuildComplete: false,
      publicationEnabled: null,
    });
    expect(messages[0]).not.toContain("PRIVATE_OBJECT_KEY_CANARY");
    expect(messages[0]).not.toContain(object.r2Key);
  });
});
