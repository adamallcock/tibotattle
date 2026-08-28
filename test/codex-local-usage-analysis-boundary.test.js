import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as codexLocalUsageAnalysis from "../src/codex-local-usage-analysis.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const START_AT = "2026-07-30T00:00:00.000Z";
const END_AT = "2026-07-31T00:00:00.000Z";
const MODEL = "gpt-boundary-test";
const SURFACE = "cli_exec";
const PRIVATE_CONTENT = "PRIVATE_PROMPT_BOUNDARY_SENTINEL";
const PRIVATE_PATH = "/Users/private-owner/Secret Project";
const PRIVATE_SESSION = "private-session-boundary-sentinel";
const PRIVATE_TOOL_ID = "private-tool-call-boundary-sentinel";
const PRIVATE_ROLLOUT_NAME = "private-rollout-boundary-sentinel";

const PRICE_CARDS = [{
  schema_version: "0.1",
  id: "openai:gpt-boundary-test:exact-decimals",
  provider: "openai",
  model: MODEL,
  components: [
    {
      usage_component: "input_uncached_tokens",
      unit: "token",
      price: { amount: "0.125", currency: "USD", per: "1" },
    },
    {
      usage_component: "input_cache_read_tokens",
      unit: "token",
      price: { amount: "0.05", currency: "USD", per: "1" },
    },
    {
      usage_component: "input_cache_write_tokens",
      unit: "token",
      price: { amount: "0.025", currency: "USD", per: "1" },
    },
    {
      usage_component: "output_text_tokens",
      unit: "token",
      price: { amount: "0.2", currency: "USD", per: "1" },
    },
    {
      usage_component: "output_reasoning_tokens",
      unit: "token",
      price: { amount: "0.3", currency: "USD", per: "1" },
    },
  ],
  source: {
    name: "boundary fixture",
    url: "https://example.invalid/openai-token-pricing",
    retrieved_at: "2026-07-30T00:00:00.000Z",
  },
}, {
  schema_version: "0.1",
  id: "openai:provider-tools:exact-decimals",
  provider: "openai",
  model: "openai-provider-tools",
  service_tier: "standard",
  components: [{
    usage_component: "web_search_units",
    unit: "search",
    price: { amount: "7", currency: "USD", per: "1000" },
  }],
  source: {
    name: "boundary fixture",
    url: "https://example.invalid/openai-tool-pricing",
    retrieved_at: "2026-07-30T00:00:00.000Z",
  },
}];

function isForbiddenScannerImport(specifier) {
  if (typeof specifier !== "string") return false;
  return specifier === "@app-usagemonitor/accounting"
    || specifier.startsWith("@app-usagemonitor/accounting/")
    || specifier === "runcost"
    || specifier.startsWith("runcost/")
    || /(?:^|\/)(?:cost-ledger|local-api-pricing|price-registry)(?:\.js)?$/u.test(specifier);
}

async function createCodexRolloutFixture() {
  const codexHome = await mkdtemp(
    join(tmpdir(), "usage-monitor-analysis-boundary-"),
  );
  const archivedSessions = join(codexHome, "archived_sessions");
  await mkdir(archivedSessions, { recursive: true });
  const rolloutPath = join(
    archivedSessions,
    `rollout-2026-07-30T12-00-00-${PRIVATE_ROLLOUT_NAME}.jsonl`,
  );
  const usage = {
    input_tokens: 11,
    cached_input_tokens: 3,
    cache_write_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 2,
    total_tokens: 16,
  };
  const records = [
    {
      timestamp: "2026-07-30T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: PRIVATE_SESSION,
        source: "cli",
        cwd: PRIVATE_PATH,
        title: PRIVATE_CONTENT,
      },
    },
    {
      timestamp: "2026-07-30T12:00:01.000Z",
      type: "turn_context",
      payload: {
        model: MODEL,
        cwd: PRIVATE_PATH,
        user_instructions: PRIVATE_CONTENT,
      },
    },
    {
      timestamp: "2026-07-30T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "web_search_call",
        id: PRIVATE_TOOL_ID,
        query: PRIVATE_CONTENT,
      },
    },
    {
      timestamp: "2026-07-30T12:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage,
          last_token_usage: usage,
        },
      },
    },
  ];
  await writeFile(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return { codexHome, rolloutPath };
}

test("Codex pricing analysis has one public entry point and stays out of the scanner owner", async () => {
  assert.deepEqual(
    Object.keys(codexLocalUsageAnalysis),
    ["scanAndPriceCodexLogs"],
  );
  assert.equal(Object.hasOwn(localCodexLogScanner, "scanAndPriceCodexLogs"), false);

  const scannerSource = await readFile(
    new URL("../src/application/local-codex-log-scanner.js", import.meta.url),
    "utf8",
  );
  const forbiddenImports = (await extractEsmImports(scannerSource, {
    sourceName: "src/application/local-codex-log-scanner.js",
  }))
    .map(({ specifier }) => specifier)
    .filter(isForbiddenScannerImport);
  assert.deepEqual(
    forbiddenImports,
    [],
    "the Codex scanner owner must remain independent from every pricing/accounting entry point",
  );
});

test("Codex pricing analysis preserves exact model/day/surface and tool-unit output without content or paths", async () => {
  const fixture = await createCodexRolloutFixture();
  try {
    const result = await codexLocalUsageAnalysis.scanAndPriceCodexLogs({
      codexHome: fixture.codexHome,
      startAt: START_AT,
      endAt: END_AT,
      priceCards: PRICE_CARDS,
    });

    assert.equal(result.eventCount, 1);
    assert.equal(result.totalTokens, 16);
    assert.deepEqual(result.components, {
      input_uncached_tokens: 6,
      input_cache_read_tokens: 3,
      input_cache_write_tokens: 2,
      output_text_tokens: 3,
      output_reasoning_tokens: 2,
    });
    assert.deepEqual({
      pricing: {
        totalUsdExact: result.runcost.totalUsdExact,
        tokenCostUsdExact: result.runcost.tokenCostUsdExact,
        providerToolCostUsdExact:
          result.runcost.providerToolCostUsdExact,
      },
      toolUnits: result.serverBillableUnits,
      modelKeys: Object.keys(result.runcost.byModel),
      model: {
        costUsdExact: result.runcost.byModel[MODEL].costUsdExact,
        providerToolCostUsdExact:
          result.runcost.byModel[MODEL].providerToolCostUsdExact,
        providerToolUnits:
          result.runcost.byModel[MODEL].providerToolUnits,
      },
      day: {
        date: result.daily[0].date,
        totalUsdExact: result.daily[0].totalUsdExact,
        providerToolUnits: result.daily[0].providerToolUnits,
        modelCostUsdExact:
          result.daily[0].byModel[MODEL].costUsdExact,
        surfaceCostUsdExact:
          result.daily[0].bySurface[SURFACE].totalUsdExact,
        surfaceProviderToolUnits:
          result.daily[0].bySurface[SURFACE].providerToolUnits,
      },
      surfaceKeys: Object.keys(result.bySurface),
      surface: {
        totalUsdExact: result.bySurface[SURFACE].totalUsdExact,
        providerToolUnits:
          result.bySurface[SURFACE].providerToolUnits,
        modelCostUsd: result.bySurface[SURFACE].byModel[MODEL],
      },
    }, {
      pricing: {
        totalUsdExact: "2.157",
        tokenCostUsdExact: "2.15",
        providerToolCostUsdExact: "0.007",
      },
      toolUnits: {
        responses_web_search_call: 1,
      },
      modelKeys: [MODEL],
      model: {
        costUsdExact: "2.157",
        providerToolCostUsdExact: "0.007",
        providerToolUnits: {
          responses_web_search_call: 1,
        },
      },
      day: {
        date: "2026-07-30",
        totalUsdExact: "2.157",
        providerToolUnits: {
          responses_web_search_call: 1,
        },
        modelCostUsdExact: "2.157",
        surfaceCostUsdExact: "2.157",
        surfaceProviderToolUnits: {
          responses_web_search_call: 1,
        },
      },
      surfaceKeys: [SURFACE],
      surface: {
        totalUsdExact: "2.157",
        providerToolUnits: {
          responses_web_search_call: 1,
        },
        modelCostUsd: 2.157,
      },
    });

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      fixture.codexHome,
      fixture.rolloutPath,
      PRIVATE_CONTENT,
      PRIVATE_PATH,
      PRIVATE_SESSION,
      PRIVATE_TOOL_ID,
      PRIVATE_ROLLOUT_NAME,
    ]) {
      assert.equal(
        serialized.includes(privateValue),
        false,
        `analysis output retained private fixture data: ${privateValue}`,
      );
    }
  } finally {
    await rm(fixture.codexHome, { recursive: true, force: true });
  }
});
