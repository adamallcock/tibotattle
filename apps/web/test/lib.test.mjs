import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildSyntheticFixture,
  bytesToBase64Url,
  createSyntheticEnvelope,
  createTelemetryEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  safeApiError,
  safeFilename,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  validateSyntheticFixture,
  validateTelemetryContribution
} from "../public/lib.js";
import {
  CommunityClient,
  demoDashboard,
  LocalCompanionClient,
  normalizeDashboardPayload
} from "../public/data-client.js";

function safeTelemetry() {
  const toolClassCounts = {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 1,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-25T14:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T13:00:00.000Z",
      endAt: "2026-07-25T13:30:00.000Z"
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-25T13:10:00.000Z",
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "standard",
      apiServiceTier: "standard",
      reasoningEffort: "high",
      components: {
        inputUncachedTokens: 1200,
        inputCacheReadTokens: 9000,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 800,
        outputReasoningTokens: 300,
        outputCombinedTokens: null
      },
      totalInputContextTokens: 10200,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts,
      outcome: "completed",
      eventId: `event:v2:${"a".repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "0.420000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices"
      }
    }],
    quotaSnapshots: [],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "0.420000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices"
    }
  };
}

async function rsaPair() {
  return webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );
}

async function decryptEnvelope(envelope, privateKey) {
  const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
  const rawPayloadKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    decode(envelope.wrappedKey)
  );
  const payloadKey = await webcrypto.subtle.importKey(
    "raw",
    rawPayloadKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv) },
    payloadKey,
    decode(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

test("the legacy demo fixture remains fixed, synthetic, and content-free", () => {
  const fixture = buildSyntheticFixture();
  assert.equal(validateSyntheticFixture(fixture), true);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.fixtureId, "codex-weekly-demo-v0.1");
});

test("base64url encoding is unpadded and URL safe", () => {
  assert.equal(bytesToBase64Url(new Uint8Array([])), "");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("foo")), "Zm9v");
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
});

test("synthetic hybrid envelope retains the existing contract", async () => {
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createSyntheticEnvelope({
    publicJwk,
    keyId: "key:test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, true);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), buildSyntheticFixture());
});

test("real privacy-safe telemetry is validated and encrypted without changing its payload", async () => {
  const payload = safeTelemetry();
  assert.equal(validateTelemetryContribution(payload), true);
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk,
    keyId: "key:real-test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, false);
  assert.equal("payload" in envelope, false);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), payload);
});

test("browser telemetry validation rejects raw-content-shaped and identity fields", () => {
  for (const [key, value] of [
    ["prompt", "private"],
    ["response", "private"],
    ["filePath", "/private/project"],
    ["commandArguments", ["--secret"]],
    ["email", "person@example.test"],
    ["participantId", "person_123"]
  ]) {
    const payload = safeTelemetry();
    payload.usageEvents[0][key] = value;
    assert.throws(() => validateTelemetryContribution(payload), /forbidden content field/);
  }
});

test("browser telemetry validation rejects synthetic, wrong-schema, oversized, and deeply nested inputs", () => {
  assert.throws(() => validateTelemetryContribution({ synthetic: false }), /privacy-safe/);
  const synthetic = safeTelemetry();
  synthetic.synthetic = true;
  assert.throws(() => validateTelemetryContribution(synthetic), /privacy-safe/);
  assert.throws(
    () => validateTelemetryContribution(safeTelemetry(), { maxSerializedBytes: 10 }),
    /larger/
  );
  const nested = safeTelemetry();
  nested.extra = { a: { b: { c: 1 } } };
  assert.throws(() => validateTelemetryContribution(nested, { maxDepth: 1 }), /closed telemetry/);
  const tooMany = safeTelemetry();
  tooMany.usageEvents = Array.from({ length: 101 }, () => structuredClone(tooMany.usageEvents[0]));
  tooMany.quotaSnapshots = Array.from({ length: 100 }, () => ({}));
  assert.throws(() => validateTelemetryContribution(tooMany), /smaller batches/);
});

test("local dashboard normalizer accepts artifact rows and keeps stale state explicit", () => {
  const result = normalizeDashboardPayload({
    schemaVersion: "local-dashboard-v0.1",
    mode: "real_local_evidence",
    status: "stale",
    freshness: { latestObservedAt: "2026-07-25T12:00:00Z", ageSeconds: 7200 },
    quotaWindows: [{
      id: "weekly",
      durationMinutes: 10080,
      usedPercent: 39,
      resetAt: "2026-07-28T17:00:00Z"
    }],
    pricing: {
      estimatedApiCostUsd: 12.34,
      pricedEventCoveragePercent: 91,
      components: { input_uncached: { tokens: 1000, costUsd: 1.25 } }
    },
    gradient: {
      snapshot: {
        datasets: {
          summary: [{ mean_absolute_error_pp: 2.7 }],
          rolling_history: [{ timestamp: "2026-07-25T12:00:00Z", series: "Observed quota change", quota_change_pp: 4 }]
        }
      }
    }
  });
  assert.equal(result.state, "stale");
  assert.equal(result.mode, "real_local_evidence");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.pricing.totalCostUsd, 12.34);
  assert.equal(result.gradient.summary.mean_absolute_error_pp, 2.7);
  assert.equal(result.gradient.rollingHistory.length, 1);
});

test("missing numeric evidence stays missing instead of becoming zero", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "insufficient",
    quotaWindows: [{ id: "weekly", usedPercent: null, remainingPercent: null }],
    pricing: { totalCostUsd: null, coveragePercent: null }
  });
  assert.equal(result.quotaWindows[0].usedPercent, null);
  assert.equal(result.quotaWindows[0].remainingPercent, null);
  assert.equal(result.pricing.totalCostUsd, null);
  assert.equal(result.pricing.coveragePercent, null);
});

test("same-duration account windows are visibly distinguishable without exposing account IDs", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      { limitId: "codex", durationMinutes: 10080, usedPercent: 39 },
      { limitId: "codex_bengalfox", durationMinutes: 10080, usedPercent: 0 }
    ]
  });
  assert.equal(result.quotaWindows[0].label, "Account 1 · seven-day allowance");
  assert.equal(result.quotaWindows[1].label, "Account 2 · seven-day allowance");
  assert.doesNotMatch(result.quotaWindows.map((row) => row.label).join(" "), /bengalfox/);
});

test("local split overview contract derives quota and seven-day pricing without exposing identities", () => {
  const result = normalizeDashboardPayload({}, {
    overview: {
      schemaVersion: "local-companion-v0.1",
      mode: "real_local_evidence",
      evidenceStatus: "available",
      latestEvidenceAt: "2026-07-25T12:00:00.000Z",
      freshness: { status: "live", ageSeconds: 30 },
      quota: {
        observedAt: "2026-07-25T12:00:00.000Z",
        windows: [{
          limitId: "codex",
          slot: "secondary",
          planType: "pro",
          usedPercent: 39,
          durationMinutes: 10080,
          resetAt: "2026-07-28T17:00:00.000Z"
        }]
      },
      usage: [
        { id: "24h", label: "Last 24 hours", events: 1, apiPriceEquivalentUsd: 1, pricedEventFraction: 1 },
        {
          id: "7d",
          label: "Last 7 days",
          events: 50,
          apiPriceEquivalentUsd: 511.64,
          pricedEventFraction: .55014,
          components: { input_uncached_tokens: 1000, output_text_tokens: 200 }
        }
      ],
      pricing: { apiServiceTier: "standard" }
    },
    reports: { reports: [{ id: "weekly", title: "Weekly", href: "/reports/weekly", modifiedAt: "2026-07-25T12:00:00Z" }] }
  });
  assert.equal(result.state, "live");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.quotaWindows[0].observedAt, "2026-07-25T12:00:00.000Z");
  assert.equal(result.pricing.totalCostUsd, 511.64);
  assert.equal(result.pricing.coveragePercent, 55.014);
  assert.equal(result.pricing.components.length, 2);
  assert.equal(result.reports[0].updatedAt, "2026-07-25T12:00:00Z");
});

test("demo data is labeled demo at the contract root and has multiple useful sections", () => {
  const result = demoDashboard();
  assert.equal(result.mode, "demo");
  assert.equal(result.state, "demo");
  assert.ok(result.quotaWindows.length >= 2);
  assert.ok(result.gradient.rolling.length > 20);
  assert.ok(result.weekly.weeklyValues.length > 5);
  assert.ok(result.quality.opportunities.length > 2);
});

test("local client prefers consolidated dashboard and falls back to split endpoints", async () => {
  const calls = [];
  const consolidated = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        schemaVersion: "local-dashboard-v0.1",
        status: "ready",
        quotaWindows: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal((await consolidated.load()).state, "live");
  assert.ok(calls.includes("/api/local/v1/dashboard"));

  const split = new LocalCompanionClient({
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/dashboard") || url.endsWith("/v1/status")) {
        return new Response("", { status: 404 });
      }
      if (url.endsWith("/overview")) {
        return new Response(JSON.stringify({ schemaVersion: "split", status: "insufficient" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal((await split.load()).schemaVersion, "split");
});

test("local refresh uses the closed same-origin contract and exposes polling", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ refresh: { status: "succeeded" } }), {
        status: options.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.refresh();
  await client.refreshStatus();
  assert.equal(calls[0].url, "/api/local/refresh");
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.equal(calls[1].options.method, undefined);
});

test("community adapter uses encrypted contribution and current stats paths", async () => {
  const calls = [];
  const client = new CommunityClient({
    getAccessToken: () => "private-capability",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.contribute({ schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION });
  await client.personalStats();
  await client.communityStats();
  await client.participantExport();
  await client.deleteParticipant();
  assert.equal(calls[0].url, "/api/v1/contributions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-capability");
  assert.equal(calls[1].url, "/api/v1/me/stats");
  assert.equal(calls[2].url, "/api/v1/stats/aggregate");
  assert.equal(calls[3].url, "/api/v1/me/export");
  assert.equal(calls[4].url, "/api/v1/me");
  assert.equal(calls[4].options.method, "DELETE");
  await client.enroll();
  assert.match(calls[5].options.body, /privacy-safe-telemetry-v0\.1/);
});

test("public interface is dashboard-first and never substitutes demo data automatically", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const label of ["Overview", "Timeline", "Weekly", "Coverage &amp; gaps", "Data &amp; privacy"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /id="timeline-chart"/);
  assert.match(html, /id="weekly-chart"/);
  assert.match(html, /id="contribution-file"/);
  assert.match(html, /id="download-participant"/);
  assert.match(html, /id="delete-participant"/);
  assert.match(html, /privacy-safe Usage Monitor export/);
  assert.match(appSource, /demo-button.*addEventListener/s);
  const loadBody = appSource.match(/async function loadLocalDashboard\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(loadBody, /demoDashboard/);
});

test("real contribution UI encrypts before sending and distinguishes aggregate suppression", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /createTelemetryEnvelope/);
  assert.match(appSource, /communityClient\.contribute\(envelope\)/);
  assert.match(appSource, /communityClient\.participantExport\(\)/);
  assert.match(appSource, /communityClient\.deleteParticipant\(\)/);
  assert.match(appSource, /if \(payload\.suppressed\)/);
  assert.match(appSource, /minimumParticipants/);
});

test("export filenames and reflected API errors remain bounded", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});
