import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import {
  collectCommunityAllowanceFits,
  summarizeCommunityAllowanceDay,
} from "../src/community-allowance";
import type { CommunityAllowanceFit } from "../src/community-allowance";
import {
  readLatestCommunityDailyAggregate,
  rebuildPendingCommunityDailyAggregates,
} from "../src/community-daily-aggregates";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

interface Participant {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  cookie: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

const TRACK = `account-track:v1:${"a".repeat(64)}`;
const DATASET = `dataset:v1:${"d".repeat(64)}`;

function bindings(overrides: Record<string, unknown> = {}): Env {
  const test = env as TestBindings;
  return {
    ASSETS: test.ASSETS,
    DELETION_LEDGER: test.DELETION_LEDGER,
    ENROLLMENT_MODE: test.ENROLLMENT_MODE,
    ENROLLMENT_RATE_LIMIT: test.ENROLLMENT_RATE_LIMIT,
    CLIENT_ATTEMPT_RATE_LIMIT: test.CLIENT_ATTEMPT_RATE_LIMIT,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVIRONMENT: "synthetic-development",
    QUARANTINE: test.QUARANTINE,
    PUBLIC_READ_RATE_LIMIT: test.PUBLIC_READ_RATE_LIMIT,
    RECOVERY_RATE_LIMIT: test.RECOVERY_RATE_LIMIT,
    UPLOAD_AUTHORIZATION_RATE_LIMIT: test.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    UPLOAD_PRINCIPAL_RATE_LIMIT: test.UPLOAD_PRINCIPAL_RATE_LIMIT,
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT:
      test.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT:
      test.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    UPLOAD_INGRESS_BUDGET: test.UPLOAD_INGRESS_BUDGET,
    UPLOAD_INGRESS_QUEUE_MODE: test.UPLOAD_INGRESS_QUEUE_MODE,
    UPLOAD_INGRESS_MAX_CONCURRENT: test.UPLOAD_INGRESS_MAX_CONCURRENT,
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE:
      test.UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE,
    UPLOAD_INGRESS_BURST: test.UPLOAD_INGRESS_BURST,
    UPLOAD_INGRESS_LEASE_SECONDS: test.UPLOAD_INGRESS_LEASE_SECONDS,
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    USAGE_MONITOR_DB: test.USAGE_MONITOR_DB,
    ACCOUNT_SCOPED_INGEST_MODE: "local_preview",
    ...overrides,
  } as unknown as Env;
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = bindings(),
  base = "http://127.0.0.1:8787",
): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", base);
  }
  return handleRequest(
    new Request(`${base}${path}`, { ...init, headers }),
    runtimeEnv,
  );
}

function toolCounts(): Record<string, number> {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function hex64(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function usageEvent(index: number, eventTime: string): Record<string, unknown> {
  return {
    schemaVersion: "usage-event-v0.2",
    accountTrackId: TRACK,
    eventTime,
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "fast",
    apiServiceTier: "priority",
    reasoningEffort: "xhigh",
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 1000,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: toolCounts(),
    outcome: "completed",
    eventId: `event:v2:${hex64(index + 1)}`,
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "999.000000",
      pricingCoveragePercent: 100,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

function quotaSnapshot(
  index: number,
  observedTime: string,
  usedPercent: number,
  planVariant = "pro-20x",
): Record<string, unknown> {
  return {
    schemaVersion: "quota-snapshot-v0.2",
    accountTrackId: TRACK,
    observedTime,
    receivedTime: new Date(Date.parse(observedTime) + 1_000).toISOString(),
    provider: "openai_codex",
    planType: "pro",
    planVariant,
    limitId: "codex",
    slot: "seven_day",
    usedPercent,
    displayPrecision: 0,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-31T12:00:00.000Z",
    snapshotSource: "rollout",
    providerSurface: "account_shared_unallocated",
    snapshotId: `snapshot:v2:${hex64(index + 1)}`,
  };
}

/**
 * A v0.2 contribution whose quota series supports a real seven-day Codex
 * reset fit under the shared calibration gates: nine strictly increasing
 * snapshots (nine boundaries, 40pp displayed span) with a fully priced usage
 * event between each pair, all within one reset and one complete dataset.
 */
function calibratableContribution(planVariant = "pro-20x"): Record<string, unknown> {
  const startMs = Date.parse("2026-07-25T12:00:00.000Z");
  const quotaSnapshots = [];
  const usageEvents = [];
  for (let index = 0; index < 9; index += 1) {
    quotaSnapshots.push(quotaSnapshot(
      index,
      new Date(startMs + index * 5 * 60_000).toISOString(),
      10 + index * 5,
      planVariant,
    ));
    if (index < 8) {
      usageEvents.push(usageEvent(
        index,
        new Date(startMs + index * 5 * 60_000 + 150_000).toISOString(),
      ));
    }
  }
  return {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: DATASET,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T12:00:00.000Z",
      endAt: "2026-07-25T12:45:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents,
    quotaSnapshots,
    activityMarkers: [],
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      // Reconciles with the eight per-event diagnostics of 999 USD each; the
      // server ignores this claimed cost and reprices from tokens anyway.
      estimatedApiCostUsd: "7992.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

async function encrypt(value: unknown): Promise<object> {
  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(publicJwkJson) as JsonWebKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  if ("publicKey" in generated) throw new Error("expected symmetric key");
  const exportedKey = await crypto.subtle.exportKey("raw", generated);
  if (!(exportedKey instanceof ArrayBuffer)) {
    throw new Error("expected raw key bytes");
  }
  const rawKey = new Uint8Array(exportedKey);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    rawKey,
  ));
  rawKey.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    generated,
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  return {
    schemaVersion: "telemetry-envelope-v0.1",
    synthetic: false,
    keyId,
    wrappedKey: encodeBase64Url(wrappedKey),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

async function enrolledParticipant(): Promise<Participant> {
  const response = await api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "privacy-safe-telemetry-v0.2",
      syntheticOnly: false,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json<Omit<Participant, "cookie">>();
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing session cookie");
  return { ...body, cookie: setCookie.split(";", 1)[0]! };
}

async function upload(
  participant: Participant,
  value: unknown,
): Promise<Response> {
  const envelope = await encrypt(value);
  const raw = JSON.stringify(envelope);
  const authorizationResponse = await api(
    "/api/v1/me/upload-authorizations",
    {
      method: "POST",
      headers: {
        cookie: participant.cookie,
        "content-type": "application/json",
        "x-usage-monitor-csrf": participant.csrfToken,
      },
      body: JSON.stringify({
        envelopeDigest: await sha256Hex(raw),
        contentLengthBytes: new TextEncoder().encode(raw).byteLength,
        contentType: "application/json",
      }),
    },
  );
  expect(authorizationResponse.status).toBe(201);
  const authorization = await authorizationResponse.json<{
    uploadAuthorization: string;
  }>();
  return api("/api/v1/contributions", {
    method: "POST",
    headers: {
      authorization: `Upload ${authorization.uploadAuthorization}`,
      "content-type": "application/json",
    },
    body: raw,
  });
}

async function enqueueDailyRebuild(day: string): Promise<void> {
  await db().prepare(
    `INSERT INTO community_daily_aggregate_rebuilds (
      day, requested_epoch, requested_at
    ) VALUES (
      ?,
      (
        SELECT mutation_epoch FROM community_snapshot_mutation_control
         WHERE singleton_id = 1
      ),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    ON CONFLICT(day) DO UPDATE SET
      requested_epoch = excluded.requested_epoch,
      requested_at = excluded.requested_at`,
  ).bind(day).run();
}

function fit(
  overrides: Partial<CommunityAllowanceFit> = {},
): CommunityAllowanceFit {
  return {
    participantId: "participant-a",
    capacityNanousd: 100_000_000_000,
    lastObservedAt: "2026-07-25T12:40:00.000Z",
    ...overrides,
  };
}

beforeAll(async () => {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in generated)) throw new Error("expected RSA key pair");
  keyId = `key:${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: keyId });
});

beforeEach(async () => {
  await reset();
  const test = env as TestBindings;
  await applyD1Migrations(test.USAGE_MONITOR_DB, test.TEST_MIGRATIONS);
  await applyD1Migrations(
    test.DELETION_LEDGER,
    test.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("summarizeCommunityAllowanceDay", () => {
  it("selects exactly the trailing 30-day half-open window", () => {
    const fits = [
      // Exactly at end of day: qualifies (inclusive upper bound).
      fit({ lastObservedAt: "2026-08-09T00:00:00.000Z", capacityNanousd: 10e9 }),
      // Exactly 30 days before end of day: excluded (open lower bound).
      fit({ lastObservedAt: "2026-07-10T00:00:00.000Z", capacityNanousd: 20e9 }),
      // Just inside the lower bound: qualifies.
      fit({ lastObservedAt: "2026-07-10T00:00:00.001Z", capacityNanousd: 30e9 }),
      // After the day being summarized: never qualifies.
      fit({ lastObservedAt: "2026-08-09T00:00:00.001Z", capacityNanousd: 40e9 }),
    ];
    const summary = summarizeCommunityAllowanceDay(fits, "2026-08-08");
    expect(summary.fitCount).toBe(2);
    expect(summary.centralUsd).toBe(20);
    expect(summary.basis).toBe("seven_day_codex_pro20x_trailing_30d");
    expect(summary.planType).toBe("pro");
    expect(summary.planVariant).toBe("pro-20x");
    expect(summary.trailingDays).toBe(30);
    expect(summary.windowDurationMinutes).toBe(10_080);
    expect(summary.limitId).toBe("codex");
    expect(summary.spanFloorPp).toBe(0);
  });

  it("publishes the honest empty summary for a day with no qualifying fits", () => {
    const summary = summarizeCommunityAllowanceDay([], "2026-08-08");
    expect(summary).toMatchObject({
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
      band80Usd: null,
    });
  });

  it("withholds the band below three fits and reports it from three", () => {
    const two = summarizeCommunityAllowanceDay([
      fit({ capacityNanousd: 100e9 }),
      fit({ capacityNanousd: 300e9 }),
    ], "2026-07-25");
    expect(two.fitCount).toBe(2);
    expect(two.centralUsd).toBe(200);
    expect(two.band80Usd).toBeNull();

    const five = summarizeCommunityAllowanceDay([
      fit({ capacityNanousd: 100e9, participantId: "p1" }),
      fit({ capacityNanousd: 200e9, participantId: "p1" }),
      fit({ capacityNanousd: 300e9, participantId: "p2" }),
      fit({ capacityNanousd: 400e9, participantId: "p2" }),
      fit({ capacityNanousd: 500e9, participantId: "p3" }),
    ], "2026-07-25");
    expect(five.fitCount).toBe(5);
    expect(five.participantCount).toBe(3);
    expect(five.centralUsd).toBe(300);
    // q10/q90 with linear interpolation over five points.
    expect(five.band80Usd).toEqual({ lowerUsd: 140, upperUsd: 460 });
  });
});

describe("community allowance in the daily aggregate", () => {
  it("collects fits from the v0.2 corpus and publishes the allowance block", async () => {
    const participant = await enrolledParticipant();
    const accepted = await upload(participant, calibratableContribution());
    expect(accepted.status, await accepted.clone().text()).toBe(202);

    const fits = await collectCommunityAllowanceFits(db());
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({
      participantId: participant.participantId,
      lastObservedAt: "2026-07-25T12:40:00.000Z",
    });
    expect(fits[0]!.capacityNanousd).toBeGreaterThan(0);

    // The contribution day and a much later day: the fit qualifies for the
    // first (observed that day) and has aged out of the second's trailing
    // window.
    await enqueueDailyRebuild("2026-07-25");
    await enqueueDailyRebuild("2026-09-30");
    const outcome = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.parse("2026-08-09T01:00:00.000Z"),
    );
    expect(outcome.processed).toBe(2);
    expect(outcome.remaining).toBe(false);

    const contributionDay = await readLatestCommunityDailyAggregate(
      db(),
      "2026-07-25",
    );
    expect(contributionDay?.release_state).toBe("published");
    const contributionPayload = JSON.parse(contributionDay!.payload_json) as {
      schemaVersion: string;
      allowance: {
        basis: string;
        fitCount: number;
        participantCount: number;
        centralUsd: number | null;
        band80Usd: { lowerUsd: number; upperUsd: number } | null;
        qualification: string;
        spanFloorPp: number;
      };
    };
    // Additive field on the unchanged v1.0 schema version.
    expect(contributionPayload.schemaVersion)
      .toBe("community-daily-aggregate-v1.0");
    expect(contributionPayload.allowance).toMatchObject({
      basis: "seven_day_codex_pro20x_trailing_30d",
      planType: "pro",
      planVariant: "pro-20x",
      qualification: "shared_reset_fit_gates_no_span_floor",
      spanFloorPp: 0,
      fitCount: 1,
      participantCount: 1,
      band80Usd: null,
    });
    expect(contributionPayload.allowance.centralUsd).toBeGreaterThan(0);

    const staleDay = await readLatestCommunityDailyAggregate(
      db(),
      "2026-09-30",
    );
    const stalePayload = JSON.parse(staleDay!.payload_json) as {
      allowance: { fitCount: number; centralUsd: number | null };
    };
    expect(stalePayload.allowance).toMatchObject({
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
      band80Usd: null,
    });
  });

  it("excludes fits from other plan cohorts: the series is one plan, not a pool", async () => {
    const participant = await enrolledParticipant();
    // The identical calibratable series, but observed on a pro-5x track: the
    // fit gates pass, yet the published Pro (20x) series must not absorb a
    // smaller plan's allowance into its median.
    const accepted = await upload(
      participant,
      calibratableContribution("pro-5x"),
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect(await collectCommunityAllowanceFits(db())).toHaveLength(0);
  });

  it("re-enqueues published days whose allowance drifts when late v0.2 fits arrive", async () => {
    // A day publishes before any v0.2 contribution exists: honest empty block.
    await enqueueDailyRebuild("2026-07-25");
    const initial = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.parse("2026-08-09T00:00:00.000Z"),
    );
    expect(initial).toMatchObject({ processed: 1, remaining: false });
    const before = JSON.parse(
      (await readLatestCommunityDailyAggregate(db(), "2026-07-25"))!
        .payload_json,
    ) as { revision: number; allowance: { fitCount: number } };
    expect(before.revision).toBe(1);
    expect(before.allowance.fitCount).toBe(0);

    // A late v0.2 contribution lands. Nothing in the v0.2 path touches the
    // rebuild queue (the 0031 trigger watches v1 chunks only) — the drift
    // reconciliation in the rebuild pass is what must catch this.
    const participant = await enrolledParticipant();
    const accepted = await upload(participant, calibratableContribution());
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const queued = await db().prepare(
      "SELECT COUNT(*) AS total FROM community_daily_aggregate_rebuilds",
    ).first<{ total: number }>();
    expect(queued?.total).toBe(0);

    const reconciled = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.parse("2026-08-09T01:00:00.000Z"),
    );
    expect(reconciled).toMatchObject({
      processed: 1,
      remaining: false,
      aggregateIds: ["community-daily:2026-07-25:r2"],
    });
    const after = JSON.parse(
      (await readLatestCommunityDailyAggregate(db(), "2026-07-25"))!
        .payload_json,
    ) as {
      revision: number;
      allowance: { fitCount: number; centralUsd: number | null };
    };
    expect(after.revision).toBe(2);
    expect(after.allowance.fitCount).toBe(1);
    expect(after.allowance.centralUsd).toBeGreaterThan(0);

    // Convergent: with the republished block matching the corpus, a further
    // pass finds no drift and rebuilds nothing.
    const settled = await rebuildPendingCommunityDailyAggregates(
      db(),
      Date.parse("2026-08-09T02:00:00.000Z"),
    );
    expect(settled).toMatchObject({ processed: 0, remaining: false });
  });

  it("excludes participants who are no longer active from the fit corpus", async () => {
    const participant = await enrolledParticipant();
    const accepted = await upload(participant, calibratableContribution());
    expect(accepted.status).toBe(202);
    expect(await collectCommunityAllowanceFits(db())).toHaveLength(1);

    await db().prepare(
      "UPDATE participants SET state = 'deleting' WHERE id = ?",
    ).bind(participant.participantId).run();
    expect(await collectCommunityAllowanceFits(db())).toHaveLength(0);
  });
});
