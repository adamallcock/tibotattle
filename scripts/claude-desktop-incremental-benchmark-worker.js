import { runClaudeDesktopIncrementalRefresh } from "../src/claude-desktop-incremental-refresh.js";

function aggregateRefreshResult(result) {
  return {
    status: result.status,
    elapsedMs: result.elapsedMs,
    inventoryMs: result.inventoryMs,
    canonicalizationMs: result.canonicalizationMs,
    canonical: result.canonical,
    merge: result.merge,
    quotaParseMs: result.quotaParseMs,
    quotaMerge: result.quotaMerge,
    projection: result.projection
      ? { generation: result.projection.generation }
      : null,
    pricingSummary: result.pricingSummary ? {
      eventCount: result.pricingSummary.eventCount,
      coverageStatus: result.pricingSummary.coverageStatus,
      payloadSha256: result.pricingSummary.payloadSha256,
    } : null,
    pricingCachePublication: result.pricingCachePublication ? {
      status: result.pricingCachePublication.status,
      publicationGeneration: result.pricingCachePublication.publicationGeneration,
      payloadSha256: result.pricingCachePublication.payloadSha256,
    } : null,
    peakMemory: result.peakMemory,
  };
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
const configuration = JSON.parse(input.toString("utf8"));
input.fill(0);
for (const chunk of chunks) chunk.fill(0);
const secret = Buffer.from(configuration.secretBase64, "base64");
const aggregateOnly = configuration.aggregateOnly === true;
delete configuration.aggregateOnly;
delete configuration.secretBase64;
try {
  const result = await runClaudeDesktopIncrementalRefresh({ ...configuration, secret });
  process.stdout.write(`${JSON.stringify({
    ...(aggregateOnly ? aggregateRefreshResult(result) : result),
    lifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
  })}\n`);
} finally {
  secret.fill(0);
}
