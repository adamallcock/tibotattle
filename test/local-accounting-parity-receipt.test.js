import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE,
  LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE_VERSION,
  LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION,
  compareLocalAccountingSemanticReceipts,
  createLocalAccountingSemanticReceipt,
} from "../src/local-accounting-parity-receipt.js";

const START_AT = "2026-08-01T00:00:00.000Z";
const END_AT = "2026-08-02T00:00:00.000Z";
const BYTE_KEY = new TextEncoder().encode(
  "local-accounting-parity-test-key-v1",
);
const OTHER_BYTE_KEY = new TextEncoder().encode(
  "local-accounting-parity-other-key-v1",
);

const COMPONENT_KEYS = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];

function usage({
  timestamp = "2026-08-01T12:00:00.000Z",
  model = "gpt-5.6-sol",
  input = 10,
  components = null,
  totalInputContextTokens = 1_000,
  omitTotalInputContext = false,
  speed = "standard",
  apiServiceTier = "unknown",
  surface = "extension_or_ide",
  agentScope = "root",
  lineage = "standalone",
} = {}) {
  return {
    timestamp,
    // These fields are deliberately not part of the semantic projection.
    timestampMs: Date.parse(timestamp),
    sequence: 99,
    sourceRolloutOrdinal: 123,
    sourceRecordOrdinal: 456,
    model,
    ...(omitTotalInputContext ? {} : { totalInputContextTokens }),
    components: components ?? Object.fromEntries(COMPONENT_KEYS.map((key) => [
      key,
      key === "input_uncached_tokens" ? input : 0,
    ])),
    tierSemantics: { codexSpeedMode: speed, apiServiceTier },
    surfaceClassification: {
      surface,
      agentScope,
      lineageDisposition: lineage,
    },
  };
}

function quota({
  timestamp = "2026-08-01T13:00:00.000Z",
  usedPercent = 21.25,
  provider = "openai_codex",
  planType = "pro",
  limitId = "codex",
  slot = "primary",
  durationMinutes = 10_080,
  resetsAt = Math.floor(Date.parse(END_AT) / 1_000),
} = {}) {
  return {
    timestamp,
    timestampMs: Date.parse(timestamp),
    sequence: 100,
    sourceRolloutOrdinal: 789,
    sourceRecordOrdinal: 987,
    window: {
      provider,
      planType,
      limitId,
      slot,
      usedPercent,
      windowDurationMins: durationMinutes,
      resetsAt,
    },
    // Quota classification is not consumed by replay-safe accounting.
    surfaceClassification: { surface: "/private/canary/surface" },
  };
}

function scannerFor(rows, { reverse = false, asynchronous = false } = {}) {
  return async ({ startAt, endAt, signal, onUsage, onRateLimitSnapshot }) => {
    assert.equal(startAt, START_AT);
    assert.equal(endAt, END_AT);
    assert.ok(signal === null || typeof signal === "object");
    const sequence = reverse ? [...rows].reverse() : rows;
    for (const row of sequence) {
      if (row.kind === "usage") {
        if (asynchronous) await Promise.resolve();
        await onUsage(row.value);
      } else {
        if (asynchronous) await Promise.resolve();
        await onRateLimitSnapshot(row.value);
      }
    }
    // Scanner diagnostics are intentionally discarded by the receipt.
    return {
      diagnostics: {
        path: "/private/canary/path",
        content: "PRIVATE_PARITY_CANARY",
        error: "PRIVATE_PARITY_ERROR",
      },
    };
  };
}

function rows() {
  return [
    {
      kind: "usage",
      value: usage({ input: 10, speed: "standard" }),
    },
    {
      kind: "usage",
      value: usage({
        timestamp: "2026-08-01T14:00:00.000Z",
        model: "gpt-5.6-terra",
        input: 20,
        speed: "fast",
        apiServiceTier: "priority",
        surface: "cli_exec",
        agentScope: "subagent",
        lineage: "forked",
      }),
    },
    {
      kind: "quota",
      value: quota({ usedPercent: 21.25 }),
    },
    {
      kind: "quota",
      value: quota({
        timestamp: "2026-08-01T14:00:00.000Z",
        usedPercent: 23.5,
        slot: "secondary",
      }),
    },
  ];
}

async function receipt(source, options = {}) {
  return createLocalAccountingSemanticReceipt({
    scan: source,
    startAt: START_AT,
    endAt: END_AT,
    byteKey: BYTE_KEY,
    ...options,
  });
}

test("receipt is pinned, content-free, and excludes source identifiers", async () => {
  const value = await receipt(scannerFor(rows()));
  assert.equal(value.version, LOCAL_ACCOUNTING_PARITY_RECEIPT_VERSION);
  assert.equal(value.scope, LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE);
  assert.equal(value.scopeVersion, LOCAL_ACCOUNTING_PARITY_RECEIPT_SCOPE_VERSION);
  assert.deepEqual(value.window, { startAt: START_AT, endAt: END_AT });
  assert.equal(value.usage.count, 2);
  assert.equal(value.usage.totalTokens, 30);
  assert.equal(value.quota.count, 2);
  assert.equal(Object.hasOwn(value, "diagnostics"), false);
  assert.equal(Object.hasOwn(value.usage, "rows"), false);
  assert.equal(Object.hasOwn(value.quota, "rows"), false);
  const serialized = JSON.stringify(value);
  for (const canary of [
    "PRIVATE_PARITY_CANARY",
    "PRIVATE_PARITY_ERROR",
    "/private/canary/path",
    "/private/canary/surface",
  ]) assert.equal(serialized.includes(canary), false);
});

test("order changes do not change a keyed multiset receipt", async () => {
  const first = await receipt(scannerFor(rows()));
  const reversed = await receipt(scannerFor(rows(), {
    reverse: true,
    asynchronous: true,
  }));
  assert.deepEqual(reversed, first);
  assert.deepEqual(compareLocalAccountingSemanticReceipts(first, reversed), {
    equal: true,
    mismatchCategories: [],
  });
});

test("duplicate rows are multiplicity-sensitive", async () => {
  const originalRows = rows();
  const first = await receipt(scannerFor(originalRows));
  const duplicated = await receipt(scannerFor([
    ...originalRows,
    originalRows[0],
  ]));
  const comparison = compareLocalAccountingSemanticReceipts(first, duplicated);
  assert.equal(comparison.equal, false);
  assert.ok(comparison.mismatchCategories.includes("usage_count"));
  assert.ok(comparison.mismatchCategories.includes("usage_tokens"));
  assert.ok(comparison.mismatchCategories.includes("usage_digest"));
  assert.ok(comparison.mismatchCategories.includes("usage_dimensions"));
});

test("zero-token usage callbacks are suppressed before receipt aggregation", async () => {
  const baseline = await receipt(scannerFor(rows()));
  const withZero = await receipt(scannerFor([
    { kind: "usage", value: usage({ input: 0 }) },
    ...rows(),
  ]));
  assert.deepEqual(
    compareLocalAccountingSemanticReceipts(baseline, withZero),
    { equal: true, mismatchCategories: [] },
  );
  assert.equal(withZero.usage.count, baseline.usage.count);
  assert.equal(withZero.usage.totalTokens, baseline.usage.totalTokens);
});

test("absent context tokens remain distinct from an explicit zero", async () => {
  const absent = await receipt(scannerFor([{
    kind: "usage",
    value: usage({ omitTotalInputContext: true }),
  }]));
  const explicitZero = await receipt(scannerFor([{
    kind: "usage",
    value: usage({ totalInputContextTokens: 0 }),
  }]));
  assert.equal(absent.usage.totalInputContextTokens, 0);
  assert.equal(explicitZero.usage.totalInputContextTokens, 0);
  assert.equal(absent.usage.missingTotalInputContextCount, 1);
  assert.equal(explicitZero.usage.missingTotalInputContextCount, 0);
  const comparison = compareLocalAccountingSemanticReceipts(
    absent,
    explicitZero,
  );
  assert.equal(comparison.equal, false);
  assert.ok(comparison.mismatchCategories.includes("usage_tokens"));
  assert.ok(comparison.mismatchCategories.includes("usage_digest"));
});

test("callbacks outside the pinned window do not enter the receipt", async () => {
  const baseline = await receipt(scannerFor(rows()));
  const outside = await receipt(scannerFor([
    {
      kind: "usage",
      value: usage({
        timestamp: "2026-07-31T23:59:59.999Z",
        input: 999,
      }),
    },
    {
      kind: "quota",
      value: quota({
        timestamp: "2026-08-02T00:00:00.001Z",
        usedPercent: 99,
      }),
    },
    ...rows(),
  ]));
  assert.deepEqual(
    compareLocalAccountingSemanticReceipts(baseline, outside),
    { equal: true, mismatchCategories: [] },
  );
});

test("a different receipt key changes the keyed digests", async () => {
  const first = await receipt(scannerFor(rows()));
  const second = await receipt(scannerFor(rows()), { byteKey: OTHER_BYTE_KEY });
  const comparison = compareLocalAccountingSemanticReceipts(first, second);
  assert.equal(comparison.equal, false);
  assert.ok(comparison.mismatchCategories.includes("usage_digest"));
  assert.ok(comparison.mismatchCategories.includes("usage_dimensions"));
  assert.ok(comparison.mismatchCategories.includes("quota_digest"));
  assert.ok(comparison.mismatchCategories.includes("quota_dimensions"));
});

test("omitted combined-output components are zero, matching the legacy reader", async () => {
  const omitted = usage({ input: 7 });
  delete omitted.components.output_combined_tokens;
  const explicitZero = usage({ input: 7 });
  const omittedReceipt = await receipt(scannerFor([{
    kind: "usage",
    value: omitted,
  }]));
  const explicitReceipt = await receipt(scannerFor([{
    kind: "usage",
    value: explicitZero,
  }]));
  assert.equal(omittedReceipt.usage.totalTokens, 7);
  assert.deepEqual(
    compareLocalAccountingSemanticReceipts(omittedReceipt, explicitReceipt),
    { equal: true, mismatchCategories: [] },
  );
});

test("separated output takes precedence over the overlapping combined alias", async () => {
  const withAlias = usage({
    input: 1,
    components: {
      input_uncached_tokens: 1,
      input_cache_read_tokens: 0,
      input_cache_write_tokens: 0,
      output_text_tokens: 4,
      output_reasoning_tokens: 6,
      output_combined_tokens: 999,
    },
  });
  const separatedOnly = structuredClone(withAlias);
  separatedOnly.components.output_combined_tokens = 0;
  const withAliasReceipt = await receipt(scannerFor([{
    kind: "usage",
    value: withAlias,
  }]));
  const separatedOnlyReceipt = await receipt(scannerFor([{
    kind: "usage",
    value: separatedOnly,
  }]));
  assert.equal(withAliasReceipt.usage.totalTokens, 11);
  assert.deepEqual(
    compareLocalAccountingSemanticReceipts(
      withAliasReceipt,
      separatedOnlyReceipt,
    ),
    { equal: true, mismatchCategories: [] },
  );
});

test("semantic usage and quota changes have fixed mismatch categories", async () => {
  const changedRows = rows();
  changedRows[1] = {
    ...changedRows[1],
    value: usage({
      timestamp: "2026-08-01T14:00:00.000Z",
      model: "gpt-5.6-terra",
      input: 20,
      speed: "standard",
      apiServiceTier: "priority",
      surface: "cli_exec",
      agentScope: "subagent",
      lineage: "forked",
    }),
  };
  changedRows[3] = {
    ...changedRows[3],
    value: quota({
      timestamp: "2026-08-01T14:00:00.000Z",
      usedPercent: 24.5,
      slot: "secondary",
    }),
  };
  const comparison = compareLocalAccountingSemanticReceipts(
    await receipt(scannerFor(rows())),
    await receipt(scannerFor(changedRows)),
  );
  assert.equal(comparison.equal, false);
  assert.deepEqual(comparison.mismatchCategories, [
    "usage_digest",
    "usage_dimensions",
    "quota_digest",
    "quota_dimensions",
  ]);
});

test("receipt schema changes are reported as a fixed category", async () => {
  const first = await receipt(scannerFor(rows()));
  const changed = { ...first, version: "local-accounting-semantic-receipt-v2" };
  assert.deepEqual(compareLocalAccountingSemanticReceipts(first, changed), {
    equal: false,
    mismatchCategories: ["receipt_schema"],
  });
});

test("malformed callback values fail with fixed errors and no scanner text", async () => {
  await assert.rejects(
    receipt(scannerFor([{
      kind: "usage",
      value: usage({
        components: "PRIVATE_PARITY_CANARY",
      }),
    }])),
    (error) => (
      error.code === "accounting_parity_usage_callback_invalid"
      && error.message === "accounting_parity_usage_callback_invalid"
      && !error.message.includes("PRIVATE_PARITY_CANARY")
    ),
  );
  await assert.rejects(
    receipt(scannerFor([{
      kind: "quota",
      value: quota({ usedPercent: Number.NaN }),
    }])),
    (error) => (
      error.code === "accounting_parity_quota_callback_invalid"
      && error.message === "accounting_parity_quota_callback_invalid"
    ),
  );
  await assert.rejects(
    receipt(async () => {
      throw new Error("PRIVATE_PARITY_CANARY /private/canary/path");
    }),
    (error) => (
      error.code === "accounting_parity_scan_failed"
      && error.message === "accounting_parity_scan_failed"
      && !error.message.includes("PRIVATE_PARITY_CANARY")
      && !error.message.includes("/private/canary/path")
    ),
  );
});

test("pinned windows, byte keys, and aborts are validated", async () => {
  await assert.rejects(
    createLocalAccountingSemanticReceipt({
      scan: scannerFor(rows()),
      startAt: "2026-08-01T00:00:00Z",
      endAt: END_AT,
      byteKey: BYTE_KEY,
    }),
    (error) => error.code === "accounting_parity_window_invalid",
  );
  await assert.rejects(
    receipt(scannerFor(rows()), { byteKey: new Uint8Array(31) }),
    (error) => error.code === "accounting_parity_byte_key_invalid",
  );
  await assert.rejects(
    receipt(scannerFor(rows()), { byteKey: new Uint8Array(257) }),
    (error) => error.code === "accounting_parity_byte_key_invalid",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    receipt(scannerFor(rows()), { signal: controller.signal }),
    (error) => (
      error.name === "AbortError"
      && error.code === "accounting_parity_aborted"
    ),
  );
});

test("the companion projection accounts money by component per model, as the replay-safe cache does", async () => {
  const {
    addUsageToPeriod,
    finalizeUsagePeriod,
    newUsagePeriod,
    usageProjection,
  } = await import("../src/local-companion-usage-model.js");

  const usageRecord = (model, observedAt, components) => ({
    model,
    observedAt,
    components,
    tierSemantics: { codexSpeedMode: "standard", apiServiceTier: "standard" },
    surfaceClassification: { surface: "cli_exec", agentScope: "root" },
  });

  const period = newUsagePeriod("test", "Test period");
  const records = [
    usageRecord("gpt-5.6-sol", "2026-08-01T10:00:00.000Z", {
      input_cache_read_tokens: 1_000_000,
      input_uncached_tokens: 200_000,
      output_text_tokens: 40_000,
      output_reasoning_tokens: 10_000,
    }),
    usageRecord("gpt-5.6-sol", "2026-08-01T11:00:00.000Z", {
      input_cache_read_tokens: 500_000,
      input_uncached_tokens: 100_000,
      output_text_tokens: 20_000,
      output_reasoning_tokens: 5_000,
    }),
    usageRecord("gpt-5.6-luna", "2026-08-01T12:00:00.000Z", {
      input_cache_read_tokens: 2_000_000,
      input_uncached_tokens: 50_000,
      output_text_tokens: 8_000,
      output_reasoning_tokens: 4_000,
    }),
  ];
  for (const record of records) {
    addUsageToPeriod(period, usageProjection(record));
  }
  const finalized = finalizeUsagePeriod(period);

  // Money by component per model was previously unavailable on this source:
  // the projection carried the token split but never the priced breakdown, so
  // the model table could show a model's tokens by component and none of its
  // cost. Every row must now reconcile against its own total.
  assert.equal(finalized.byModel.length, 2);
  for (const row of finalized.byModel) {
    const componentTotal = Object.values(row.componentCosts)
      .reduce((sum, cost) => sum + cost.costUsd, 0);
    assert.equal(
      Number(componentTotal.toFixed(6)),
      row.apiPriceEquivalentUsd,
      `${row.model} component costs reconcile with its own total`,
    );
    assert.ok(
      row.apiPriceEquivalentUsd > 0,
      `${row.model} is priced, so its components are not all zero`,
    );
  }

  // And the models must reconcile against the period, in both units, so the
  // model table and the component bars stay two margins of one crossing.
  for (const key of Object.keys(finalized.components)) {
    assert.equal(
      finalized.byModel.reduce((sum, row) => sum + row.components[key], 0),
      finalized.components[key],
      `${key} tokens add up across models`,
    );
    assert.equal(
      Number(finalized.byModel
        .reduce((sum, row) => sum + row.componentCosts[key].costUsd, 0)
        .toFixed(6)),
      finalized.componentCosts[key].costUsd,
      `${key} cost adds up across models`,
    );
  }
  assert.equal(
    Number(Object.values(finalized.componentCosts)
      .reduce((sum, cost) => sum + cost.costUsd, 0)
      .toFixed(6)),
    finalized.apiPriceEquivalentUsd,
  );
});
