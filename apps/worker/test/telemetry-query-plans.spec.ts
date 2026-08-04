import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";

/**
 * Both hot paths once reached `telemetry_records` with a correlated subquery
 * filtered on `origin_contribution_id`, and the cost of each was set by the
 * size of the whole table rather than by the size of the request: the ingest
 * finalize UPDATE re-derived four server-pricing aggregates that way, and the
 * dashboard contribution list re-counted accepted records once per listed row,
 * up to a hundred times per load.
 *
 * These tests hold both paths to the property that actually removed the cost —
 * that neither of them reads `telemetry_records` at all — and, separately, to
 * the weaker plan-level property that nothing they do issue degrades into a
 * full or `record_kind`-wide scan of that table.
 *
 * The plan check alone would not have caught either original defect as the
 * schema now stands: `telemetry_records_origin_contribution` (migration 0018)
 * means the old correlated subqueries would today plan as an indexed SEARCH.
 * It is kept as a backstop against *new* query shapes reaching that table
 * without an index to stand on, and `recognises the scan shapes it is meant to
 * catch` guards it against silently decaying into an assertion that cannot
 * fail.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

interface Participant {
  participantId: string;
  csrfToken: string;
  cookie: string;
}

let publicJwkJson = "";
let privateJwkJson = "";
let keyId = "";

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
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
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
    USAGE_MONITOR_DB: test.USAGE_MONITOR_DB,
    ...overrides,
  } as unknown as Env;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = bindings(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("origin")) {
    headers.set("origin", "https://example.test");
  }
  return handleRequest(
    new Request(`https://example.test${path}`, { ...init, headers }),
    runtimeEnv,
  );
}

/**
 * Every statement the Worker prepared, with the arguments it was finally bound
 * to. Recording at `prepare` rather than at `run`/`all`/`first` is what makes
 * the ingest batch visible: `db.batch()` executes its statements without any
 * of those ever being called on them.
 */
interface IssuedQuery {
  query: string;
  params: unknown[];
}

function recordingStatement(
  statement: D1PreparedStatement,
  issued: IssuedQuery,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...params: unknown[]) => {
          issued.params = params;
          return recordingStatement(target.bind(...params), issued);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function recordingDb(base: D1Database, sink: IssuedQuery[]): D1Database {
  return new Proxy(base, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const issued: IssuedQuery = { query, params: [] };
          sink.push(issued);
          return recordingStatement(base.prepare(query), issued);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const TELEMETRY_RECORDS = "telemetry_records";

/** Words that can follow a table name without being an alias for it. */
const NOT_AN_ALIAS = new Set([
  "where", "set", "values", "select", "on", "using", "group", "order", "limit",
  "join", "left", "inner", "outer", "cross", "natural", "when", "then", "and",
  "or", "as", "returning", "having", "union", "except", "intersect", "from",
  "default", "not", "is", "in",
]);

function referencesTelemetryRecords(query: string): boolean {
  return new RegExp(`\\b${TELEMETRY_RECORDS}\\b`, "iu").test(query);
}

/**
 * The names `telemetry_records` answers to inside one query. A plan row reports
 * whichever alias the query gave the table — `SCAN r`, not `SCAN
 * telemetry_records` — so a matcher that only looked for the table's own name
 * would miss every aliased scan, which is exactly the form both defects took.
 */
function telemetryRecordNames(query: string): Set<string> {
  const names = new Set([TELEMETRY_RECORDS]);
  const aliased = new RegExp(
    `\\b${TELEMETRY_RECORDS}\\s+(?:as\\s+)?([a-z_][a-z0-9_]*)`,
    "giu",
  );
  for (const match of query.matchAll(aliased)) {
    const alias = match[1]!.toLowerCase();
    if (!NOT_AN_ALIAS.has(alias)) names.add(alias);
  }
  return names;
}

function isTelemetryRecordsIndex(index: string): boolean {
  return index.startsWith(`${TELEMETRY_RECORDS}_`)
    || index.startsWith(`sqlite_autoindex_${TELEMETRY_RECORDS}_`);
}

/** The columns an indexed SEARCH is actually constrained by. */
function constrainedColumns(constraints: string): Set<string> {
  const columns = new Set<string>();
  for (const term of constraints.split(/\s+and\s+/iu)) {
    const column = /^\s*([a-z_][a-z0-9_]*)\s*(?:=|>|<|>=|<=|is\b)/iu.exec(term);
    if (column) columns.add(column[1]!.toLowerCase());
  }
  return columns;
}

/**
 * A plan row that visits `telemetry_records` in a quantity set by the table
 * rather than by the request: either a scan of the whole table, or a SEARCH
 * whose only constraint is `record_kind`, which — `telemetry_records_aggregate_time`
 * leading with that column — visits every row of that kind.
 */
function scanViolation(query: string, detail: string): string | null {
  const names = telemetryRecordNames(query);
  const scan = /^\s*SCAN\s+([a-z_][a-z0-9_]*)/iu.exec(detail);
  if (scan) {
    const index = /USING\s+(?:COVERING\s+)?INDEX\s+([a-z_][a-z0-9_]*)/iu
      .exec(detail);
    if (names.has(scan[1]!.toLowerCase())
      || (index && isTelemetryRecordsIndex(index[1]!))) {
      return `full scan of ${TELEMETRY_RECORDS}: ${detail}`;
    }
    return null;
  }
  const search = new RegExp(
    "^\\s*SEARCH\\s+([a-z_][a-z0-9_]*)\\s+USING\\s+(?:COVERING\\s+)?"
      + "INDEX\\s+([a-z_][a-z0-9_]*)\\s*\\(([^)]*)\\)",
    "iu",
  ).exec(detail);
  if (!search) return null;
  const [, alias, index, constraints] = search;
  if (!names.has(alias!.toLowerCase()) && !isTelemetryRecordsIndex(index!)) {
    return null;
  }
  const columns = constrainedColumns(constraints!);
  if (columns.size === 1 && columns.has("record_kind")) {
    return `record_kind-wide scan of ${TELEMETRY_RECORDS}: ${detail}`;
  }
  return null;
}

interface PlannedQuery {
  query: string;
  plan: string[];
  violations: string[];
  explainError: string | null;
}

async function explain(
  base: D1Database,
  issued: IssuedQuery,
): Promise<PlannedQuery> {
  const flattened = issued.query.replace(/\s+/gu, " ").trim();
  try {
    const statement = base.prepare(`EXPLAIN QUERY PLAN ${issued.query}`);
    const bound = issued.params.length > 0
      ? statement.bind(...issued.params)
      : statement;
    const result = await bound.all<{ detail: string }>();
    const plan = result.results.map((row) => row.detail);
    return {
      query: flattened,
      plan,
      violations: plan
        .map((detail) => scanViolation(issued.query, detail))
        .filter((violation): violation is string => violation !== null),
      explainError: null,
    };
  } catch (error) {
    return {
      query: flattened,
      plan: [],
      violations: [],
      explainError: (error as Error).message,
    };
  }
}

async function planAll(
  base: D1Database,
  issued: readonly IssuedQuery[],
): Promise<PlannedQuery[]> {
  return Promise.all(issued.map((entry) => explain(base, entry)));
}

/**
 * A statement that reads `telemetry_records`. The ingest path is allowed to
 * write to that table and nothing else; the personal profile is allowed
 * neither.
 */
function readsTelemetryRecords(query: string): boolean {
  if (!referencesTelemetryRecords(query)) return false;
  const withoutInsertTarget = query.replace(
    new RegExp(`INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${TELEMETRY_RECORDS}`, "giu"),
    "INSERT INTO written_table",
  );
  return referencesTelemetryRecords(withoutInsertTarget);
}

async function encrypt(value: unknown): Promise<object> {
  const publicJwk = JSON.parse(publicJwkJson) as JsonWebKey;
  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  ) as CryptoKey;
  const rawDataKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", dataKey) as ArrayBuffer,
  );
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawDataKey),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKey,
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

function telemetryFixture(suffix: string): Record<string, unknown> {
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T12:00:00.000Z",
      endAt: "2026-07-25T12:30:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-25T12:05:00.000Z",
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
      toolClassCounts: {
        webSearch: 1,
        fileSearch: 0,
        codeInterpreter: 0,
        hostedShell: 0,
        computerUse: 0,
        mcp: 0,
        applyPatch: 1,
        localShell: 2,
        subagent: 0,
        toolGateway: 1,
        other: 0,
        unknown: 0,
      },
      outcome: "completed",
      eventId: `event:v2:${suffix.repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "1.000000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1",
      observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z",
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 31,
      displayPrecision: 0,
      windowDurationMinutes: 10080,
      resetsAt: "2026-07-31T12:00:00.000Z",
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${suffix.repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "1.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

async function enrollTelemetry(): Promise<Participant> {
  const response = await api("/api/v1/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion: "privacy-safe-telemetry-v0.1",
      syntheticOnly: false,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json<Omit<Participant, "cookie">>();
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("enrollment issued no session cookie");
  return { ...body, cookie: setCookie.split(";", 1)[0]! };
}

async function contribute(
  participant: Participant,
  suffix: string,
  runtimeEnv = bindings(),
): Promise<Response> {
  const raw = JSON.stringify(await encrypt(telemetryFixture(suffix)));
  const authorization = await api("/api/v1/me/upload-authorizations", {
    method: "POST",
    headers: {
      cookie: participant.cookie,
      "x-usage-monitor-csrf": participant.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopeDigest: await sha256Hex(raw),
      contentLengthBytes: new TextEncoder().encode(raw).byteLength,
      contentType: "application/json",
    }),
  });
  expect(authorization.status).toBe(201);
  const { uploadAuthorization } = await authorization
    .json<{ uploadAuthorization: string }>();
  const accepted = await api("/api/v1/contributions", {
    method: "POST",
    headers: {
      authorization: `Upload ${uploadAuthorization}`,
      "content-type": "application/json",
    },
    body: raw,
  }, runtimeEnv);
  expect(accepted.status).toBe(202);
  return accepted;
}

async function personalProfile(
  participant: Participant,
  sink: IssuedQuery[],
): Promise<Response> {
  const base = (env as TestBindings).USAGE_MONITOR_DB;
  const response = await api(
    "/api/v1/me",
    { headers: { cookie: participant.cookie } },
    bindings({ USAGE_MONITOR_DB: recordingDb(base, sink) }),
  );
  expect(response.status).toBe(200);
  return response;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  ) as CryptoKeyPair;
  keyId = `key:${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
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

describe("telemetry_records is never scanned by a hot path", () => {
  it("ingests a contribution without reading telemetry_records", async () => {
    const base = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enrollTelemetry();
    const issued: IssuedQuery[] = [];
    await contribute(
      participant,
      "a",
      bindings({ USAGE_MONITOR_DB: recordingDb(base, issued) }),
    );

    const touching = issued
      .filter((entry) => referencesTelemetryRecords(entry.query))
      .map((entry) => entry.query.replace(/\s+/gu, " ").trim());
    // The records themselves still have to be written, or the path under test
    // is not the ingest path.
    expect(touching.length).toBeGreaterThan(0);
    expect(touching.filter((query) => !(
      /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+telemetry_records\b/iu.test(query)
    ))).toEqual([]);

    const reads = issued
      .filter((entry) => readsTelemetryRecords(entry.query))
      .map((entry) => entry.query.replace(/\s+/gu, " ").trim());
    expect(reads).toEqual([]);
  });

  it("serves /api/v1/me without reading telemetry_records", async () => {
    const participant = await enrollTelemetry();
    await contribute(participant, "a");
    await contribute(participant, "b");

    const issued: IssuedQuery[] = [];
    await personalProfile(participant, issued);

    expect(issued.length).toBeGreaterThan(0);
    const touching = issued
      .filter((entry) => referencesTelemetryRecords(entry.query))
      .map((entry) => entry.query.replace(/\s+/gu, " ").trim());
    expect(touching).toEqual([]);
  });

  it("keeps /api/v1/me query count flat as contributions accumulate", async () => {
    const participant = await enrollTelemetry();
    await contribute(participant, "a");
    const single: IssuedQuery[] = [];
    await personalProfile(participant, single);

    for (const suffix of ["b", "c", "d", "e"]) {
      await contribute(participant, suffix);
    }
    const many: IssuedQuery[] = [];
    const profile = await personalProfile(participant, many);

    // Five contributions are listed, so the read-time count the dashboard used
    // to run per listed row would show up here as four extra statements.
    const body = await profile.json<{ contributions: unknown[] }>();
    expect(body.contributions).toHaveLength(5);
    expect(many.length).toBe(single.length);
  });

  it("plans no full or record_kind-wide scan of telemetry_records", async () => {
    const base = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enrollTelemetry();

    const ingest: IssuedQuery[] = [];
    await contribute(
      participant,
      "a",
      bindings({ USAGE_MONITOR_DB: recordingDb(base, ingest) }),
    );
    await contribute(participant, "b");
    const profile: IssuedQuery[] = [];
    await personalProfile(participant, profile);

    const planned = [
      ...await planAll(base, ingest),
      ...await planAll(base, profile),
    ];
    expect(planned.length).toBeGreaterThan(0);

    // An EXPLAIN that failed to run is not a passing assertion, it is an
    // unchecked query.
    expect(planned
      .filter((entry) => entry.explainError !== null)
      .map((entry) => `${entry.query.slice(0, 80)} :: ${entry.explainError}`))
      .toEqual([]);

    expect(planned.flatMap((entry) => entry.violations.map(
      (violation) => `${violation} — in: ${entry.query.slice(0, 80)}`,
    ))).toEqual([]);
  });

  it("recognises the scan shapes it is meant to catch", async () => {
    const base = (env as TestBindings).USAGE_MONITOR_DB;

    // Without this, every assertion above would still pass if `scanViolation`
    // silently stopped matching anything.
    const fullScan = await explain(base, {
      query: "SELECT COUNT(*) FROM telemetry_records r WHERE r.record_json LIKE ?",
      params: ["%needle%"],
    });
    expect(fullScan.explainError).toBeNull();
    expect(fullScan.violations.join(" ")).toContain("full scan of telemetry_records");

    const recordKindWide = await explain(base, {
      query: "SELECT COUNT(*) FROM telemetry_records WHERE record_kind = ?",
      params: ["usage"],
    });
    expect(recordKindWide.explainError).toBeNull();
    expect(recordKindWide.violations.join(" "))
      .toContain("record_kind-wide scan of telemetry_records");

    // A contribution-bounded read is the shape the repair path uses, and must
    // not be reported as a scan.
    const bounded = await explain(base, {
      query: `SELECT COUNT(*) FROM telemetry_records r
                WHERE r.origin_contribution_id = ?`,
      params: ["contribution:none"],
    });
    expect(bounded.explainError).toBeNull();
    expect(bounded.violations).toEqual([]);
  });
});
