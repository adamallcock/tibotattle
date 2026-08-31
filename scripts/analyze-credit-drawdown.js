#!/usr/bin/env node
// Triangulates Codex model costing from purchased-credit drawdown.
//
// Codex attaches `rate_limits.credits.balance` to every `token_count` rollout
// record. When an account is spending purchased credits the balance is a
// provider-authored meter over the same token stream the local estimator
// prices from API cards, so the ratio credit$/API$ measures whether our
// API-price-equivalent costing reproduces the provider's own accounting --
// per model, without going through quota percentage points.
//
// Two properties of the meter drive the whole design:
//   1. Settlement is lumpy. The balance refreshes roughly every ten requests,
//      so a single drop covers work that cannot be attributed to one request.
//      Only episode aggregates and bootstrapped settlement increments carry
//      meaning; per-request deltas do not.
//   2. `has_credits` flips false at exhaustion, so the terminal zero-balance
//      record is outside the credit rows yet still belongs to the episode.
//
// Usage:
//   node scripts/analyze-credit-drawdown.js [--sessions <dir>] [--since <YYYY-MM-DD>]
//        [--file <rollout.jsonl>]... [--json <out>] [--csv <out>]
//        [--credit-usd <n>] [--bootstrap <n>] [--reveal-paths]
//
// Written artifacts identify rollout files by stable opaque labels
// ("rollout-01", ...) unless --reveal-paths is passed: session paths and
// filenames are private session content and must not ride along into
// artifacts that may be shared or committed.

import { createReadStream } from "node:fs";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { priceCodexUsageEvent } from "@app-usagemonitor/accounting";

// Matches a numeric credit balance. Deliberately NOT `"has_credits":true`:
// the terminal settlement of an exhausted episode reports has_credits:false
// with balance 0, and it can land in the next session's file. Non-credit
// accounts report balance:null and stay excluded.
const BALANCE_PATTERN = /"balance":\s*-?\d/u;
const BALANCE_CARRY = 24;
const DEFAULT_CREDIT_USD = 0.04;
const DEFAULT_BOOTSTRAP = 4000;

function parseArgs(argv) {
  const opts = {
    sessions: join(homedir(), ".codex", "sessions"),
    since: null,
    files: [],
    json: null,
    csv: null,
    creditUsd: DEFAULT_CREDIT_USD,
    bootstrap: DEFAULT_BOOTSTRAP,
    revealPaths: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--sessions") opts.sessions = resolve(next());
    else if (arg === "--since") opts.since = next();
    else if (arg === "--file") opts.files.push(resolve(next()));
    else if (arg === "--json") opts.json = resolve(next());
    else if (arg === "--csv") opts.csv = resolve(next());
    else if (arg === "--credit-usd") opts.creditUsd = Number(next());
    else if (arg === "--bootstrap") opts.bootstrap = Number(next());
    else if (arg === "--reveal-paths") opts.revealPaths = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.creditUsd) || opts.creditUsd <= 0) {
    throw new Error("--credit-usd must be a positive number");
  }
  if (!Number.isInteger(opts.bootstrap) || opts.bootstrap < 0 || opts.bootstrap > 1_000_000) {
    throw new Error("--bootstrap must be an integer between 0 and 1000000");
  }
  if (opts.since !== null && opts.files.length > 0) {
    throw new Error("--since only applies to discovery mode; drop it when passing --file");
  }
  return opts;
}

async function discoverRolloutFiles(root, since, skipped) {
  const cutoff = since ? Date.parse(`${since}T00:00:00.000Z`) : null;
  if (since && !Number.isFinite(cutoff)) throw new Error(`--since must be YYYY-MM-DD, got ${since}`);
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (cutoff !== null) {
          // Rollout files rotate while a scan runs; a vanished or unreadable
          // file must not abort the run, and its path must not reach output.
          try {
            const info = await stat(path);
            if (info.mtimeMs < cutoff) continue;
          } catch {
            skipped.count += 1;
            continue;
          }
        }
        found.push(path);
      }
    }
  }
  await walk(root);
  return found.sort();
}

// Substring pre-scan. Session corpora reach tens of gigabytes and only a
// handful of files ever carry credits, so this avoids JSON-parsing everything.
function fileHasCredits(path) {
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
    let carry = "";
    let hit = false;
    stream.on("data", (chunk) => {
      const window = carry + chunk;
      if (BALANCE_PATTERN.test(window)) {
        hit = true;
        stream.destroy();
        return;
      }
      carry = window.slice(-BALANCE_CARRY);
    });
    stream.on("close", () => resolvePromise(hit));
    stream.on("error", reject);
  });
}

async function readCreditRecords(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records = [];
  let model = null;
  let serviceTier = null;
  let reasoningEffort = null;
  for await (const line of lines) {
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (typeof payload.model === "string" && payload.model !== "") model = payload.model;
    if (typeof payload.service_tier === "string") serviceTier = payload.service_tier;
    if (typeof payload.reasoning_effort === "string") reasoningEffort = payload.reasoning_effort;
    if (payload.type !== "token_count") continue;
    const limits = payload.rate_limits;
    const credits = limits?.credits;
    if (!credits || typeof credits !== "object") continue;
    const balance = credits.balance === null || credits.balance === undefined
      ? null
      : Number(credits.balance);
    if (balance === null || !Number.isFinite(balance)) continue;
    const usage = payload.info?.last_token_usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const cacheRead = usage.cached_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const reasoning = usage.reasoning_output_tokens ?? 0;
    records.push({
      sourceFile: path,
      timestamp: record.timestamp ?? null,
      model,
      serviceTier,
      reasoningEffort,
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance,
      limitId: limits?.limit_id ?? null,
      limitName: limits?.limit_name ?? null,
      planType: limits?.plan_type ?? null,
      usedPercent: limits?.primary?.used_percent ?? null,
      windowMinutes: limits?.primary?.window_minutes ?? null,
      totalInputTokens: inputTokens,
      inputUncachedTokens: Math.max(0, inputTokens - cacheRead),
      inputCacheReadTokens: cacheRead,
      inputCacheWriteTokens: usage.cache_write_input_tokens ?? 0,
      // output_tokens already contains reasoning_output_tokens.
      outputTextTokens: Math.max(0, outputTokens - reasoning),
      outputReasoningTokens: reasoning,
      outputCombinedTokens: outputTokens,
    });
  }
  return records;
}

// An episode runs from a credit-bearing record until the balance is topped up
// (balance rises) or hits zero. The zero record reports has_credits=false but
// is the settlement that closes the episode, so it is retained.
function buildEpisodes(records) {
  const episodes = [];
  let current = null;
  for (const record of records) {
    if (current === null) {
      if (!record.hasCredits) continue;
      current = { records: [record], openingBalance: record.balance, terminator: "in_progress" };
      continue;
    }
    const previous = current.records.at(-1);
    if (record.balance > previous.balance + 1e-9) {
      current.terminator = "topped_up";
      episodes.push(current);
      current = record.hasCredits
        ? { records: [record], openingBalance: record.balance, terminator: "in_progress" }
        : null;
      continue;
    }
    current.records.push(record);
    if (record.balance === 0) {
      current.terminator = "exhausted";
      episodes.push(current);
      current = null;
    }
  }
  if (current !== null) episodes.push(current);
  return episodes;
}

function sumComponents(records) {
  const totals = {
    input_uncached_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
  };
  for (const record of records) {
    totals.input_uncached_tokens += record.inputUncachedTokens;
    totals.input_cache_read_tokens += record.inputCacheReadTokens;
    totals.input_cache_write_tokens += record.inputCacheWriteTokens;
    totals.output_text_tokens += record.outputTextTokens;
    totals.output_reasoning_tokens += record.outputReasoningTokens;
  }
  return totals;
}

// Priced per request so each event lands in the context band its own input
// size implies; summing components first would misprice mixed-band episodes.
function priceRecords(records) {
  let totalUsd = 0;
  const coverage = new Map();
  for (const record of records) {
    // A truncated or rotated file can carry credit records before any model
    // context line. Their cost cannot be attributed; surfacing them as
    // model_unknown coverage keeps the run alive and the gap explicit.
    if (typeof record.model !== "string" || record.model === "") {
      coverage.set("model_unknown", (coverage.get("model_unknown") ?? 0) + 1);
      continue;
    }
    const components = {
      input_uncached_tokens: record.inputUncachedTokens,
      input_cache_read_tokens: record.inputCacheReadTokens,
      input_cache_write_tokens: record.inputCacheWriteTokens,
      output_text_tokens: record.outputTextTokens,
      output_reasoning_tokens: record.outputReasoningTokens,
    };
    const priced = priceCodexUsageEvent({
      timestamp: record.timestamp,
      model: record.model,
      raw: { input_tokens: record.totalInputTokens },
      components,
      componentAvailability: Object.fromEntries(Object.keys(components).map((key) => [key, true])),
    });
    totalUsd += Number(priced.totalUsd);
    coverage.set(priced.coverageStatus, (coverage.get(priced.coverageStatus) ?? 0) + 1);
  }
  return { totalUsd, coverage: Object.fromEntries(coverage) };
}

// A settlement charges whatever the provider has finished billing at the moment
// the balance is next read -- not the work co-located with that read. When a
// session ends with unsettled work, the charge lands on the NEXT session to
// request a balance, which may be a different model entirely. Observed 1h42m
// later and across a session boundary in the 2026-08-19 corpus, where a $3.09
// sol charge settled onto a terra session's first reading. Settlements whose
// drop dwarfs their co-located work are therefore flagged, not trusted.
const TAIL_SUSPECT_RATIO = 3;

function settlementIncrements(records, creditUsd) {
  const steps = [];
  let anchor = 0;
  for (let i = 1; i < records.length; i += 1) {
    if (records[i].balance >= records[i - 1].balance) continue;
    // Disjoint windows: the anchor record's own work is already reflected in
    // the anchor balance (settled before that read), so it belongs to the
    // PREVIOUS window. Including it would double-count every boundary record
    // and bias the per-step ratios low.
    const slice = records.slice(anchor + 1, i + 1);
    const usdDrawn = (records[anchor].balance - records[i].balance) * creditUsd;
    const apiUsd = priceRecords(slice).totalUsd;
    const previousAt = Date.parse(records[i - 1]?.timestamp ?? records[i].timestamp);
    const settledAt = Date.parse(records[i].timestamp);
    const idleMinutes = Number.isFinite(previousAt) && Number.isFinite(settledAt)
      ? (settledAt - previousAt) / 60000
      : null;
    steps.push({
      timestamp: records[i].timestamp,
      creditsDrawn: records[anchor].balance - records[i].balance,
      usdDrawn,
      requests: slice.length,
      models: [...new Set(slice.map((record) => record.model))].sort(),
      sessionBoundary: records[i].sourceFile !== records[anchor].sourceFile,
      idleMinutesBefore: idleMinutes,
      ...sumComponents(slice),
      apiUsd,
      // A drop with NO priceable co-located work is the limiting case of
      // "drop dwarfs its work" -- maximally suspect, not exempt.
      tailSuspect: usdDrawn > 0
        && (apiUsd === 0 || usdDrawn / apiUsd > TAIL_SUSPECT_RATIO),
    });
    anchor = i;
  }
  return steps;
}

// Contiguous single-model runs inside an episode. The leading settlement of a
// block is contaminated whenever the previous block left work unsettled, so a
// block is only usable for a per-model rate once its suspect settlements are
// excluded and enough clean ones remain.
function modelBlocks(records, creditUsd) {
  const blocks = [];
  let current = null;
  for (const record of records) {
    if (current === null || record.model !== current.model) {
      if (current) blocks.push(current);
      current = { model: record.model, records: [record] };
      continue;
    }
    current.records.push(record);
  }
  if (current) blocks.push(current);
  return blocks.map((block) => {
    const steps = settlementIncrements(block.records, creditUsd);
    const clean = steps.filter((step) => !step.tailSuspect);
    const usdDrawn = steps.reduce((acc, step) => acc + step.usdDrawn, 0);
    const apiUsd = priceRecords(block.records).totalUsd;
    const cleanUsd = clean.reduce((acc, step) => acc + step.usdDrawn, 0);
    const cleanApi = clean.reduce((acc, step) => acc + step.apiUsd, 0);
    return {
      model: block.model,
      startedAt: block.records[0].timestamp,
      endedAt: block.records.at(-1).timestamp,
      requests: block.records.length,
      settlements: steps.length,
      suspectSettlements: steps.length - clean.length,
      usdDrawn,
      apiEquivalentUsd: apiUsd,
      ratioAllSettlements: apiUsd > 0 ? usdDrawn / apiUsd : null,
      ratioCleanSettlements: cleanApi > 0 ? cleanUsd / cleanApi : null,
      usable: clean.length >= 5,
    };
  });
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ratio of provider credit spend to our API-equivalent price, fitted through
// the origin on settlement increments. The bootstrap interval is the honest
// error bar: settlement misattribution makes any single increment noisy, and
// with ~20 settlements the interval is wide enough that a point estimate
// several points away from parity is not evidence of a real gap.
function fitScale(steps, bootstrap) {
  const usable = steps.filter((step) => step.apiUsd > 0);
  if (usable.length < 3) return null;
  const slope = (sample) => {
    let sxx = 0;
    let sxy = 0;
    for (const step of sample) {
      sxx += step.apiUsd * step.apiUsd;
      sxy += step.apiUsd * step.usdDrawn;
    }
    return sxx === 0 ? null : sxy / sxx;
  };
  const point = slope(usable);
  let ssRes = 0;
  let ssTot = 0;
  const mean = usable.reduce((acc, step) => acc + step.usdDrawn, 0) / usable.length;
  for (const step of usable) {
    ssRes += (step.usdDrawn - point * step.apiUsd) ** 2;
    ssTot += (step.usdDrawn - mean) ** 2;
  }
  const random = mulberry32(0x5eed);
  const draws = [];
  for (let b = 0; b < bootstrap; b += 1) {
    const sample = Array.from({ length: usable.length }, () => usable[Math.floor(random() * usable.length)]);
    const value = slope(sample);
    if (value !== null) draws.push(value);
  }
  draws.sort((a, b) => a - b);
  return {
    point,
    r2: ssTot === 0 ? null : 1 - ssRes / ssTot,
    ci95: draws.length
      ? [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]]
      : null,
    settlements: usable.length,
  };
}

function analyzeEpisode(episode, index, creditUsd, bootstrap) {
  const { records, terminator } = episode;
  const closingBalance = records.at(-1).balance;
  const creditsDrawn = episode.openingBalance - closingBalance;
  const usdDrawn = creditsDrawn * creditUsd;
  const priced = priceRecords(records);
  const steps = settlementIncrements(records, creditUsd);
  const models = [...new Set(records.map((record) => record.model))].sort();
  const mixedSettlements = steps.filter((step) => step.models.length > 1).length;
  return {
    episode: index,
    startedAt: records[0].timestamp,
    endedAt: records.at(-1).timestamp,
    sourceFiles: [...new Set(records.map((record) => record.sourceFile))],
    terminator,
    models,
    modelPure: models.length === 1,
    limitIds: [...new Set(records.map((record) => record.limitId))],
    planTypes: [...new Set(records.map((record) => record.planType))],
    usedPercentRange: (() => {
      const observed = records
        .map((record) => record.usedPercent)
        .filter((value) => Number.isFinite(value));
      return observed.length
        ? [Math.min(...observed), Math.max(...observed)]
        : [null, null];
    })(),
    requests: records.length,
    openingBalance: episode.openingBalance,
    closingBalance,
    creditsDrawn,
    usdDrawn,
    tokens: sumComponents(records),
    apiEquivalentUsd: priced.totalUsd,
    coverage: priced.coverage,
    ratioCreditToApi: priced.totalUsd > 0 ? usdDrawn / priced.totalUsd : null,
    // Exhaustion truncates the final charge at the remaining balance, so the
    // provider's true cost is at least the amount drawn.
    ratioIsFloor: terminator === "exhausted",
    settlements: steps.length,
    meanRequestsPerSettlement: steps.length ? records.length / steps.length : null,
    mixedModelSettlements: mixedSettlements,
    suspectSettlements: steps.filter((step) => step.tailSuspect).length,
    // Credits drawn that no observed request accounts for: work on surfaces the
    // rollout logs do not see, or tails settling from an already-closed session.
    unattributedUsd: usdDrawn - priced.totalUsd,
    modelBlocks: modelBlocks(records, creditUsd),
    scaleFit: fitScale(steps.filter((step) => !step.tailSuspect), bootstrap),
    steps,
  };
}

function crossModelTable(episodes) {
  const byModel = new Map();
  for (const episode of episodes) {
    if (!episode.modelPure || episode.apiEquivalentUsd <= 0) continue;
    const model = episode.models[0];
    const entry = byModel.get(model) ?? { model, episodes: 0, usdDrawn: 0, apiUsd: 0, floors: 0 };
    entry.episodes += 1;
    entry.usdDrawn += episode.usdDrawn;
    entry.apiUsd += episode.apiEquivalentUsd;
    if (episode.ratioIsFloor) entry.floors += 1;
    byModel.set(model, entry);
  }
  return [...byModel.values()]
    .map((entry) => ({ ...entry, ratio: entry.usdDrawn / entry.apiUsd }))
    .sort((a, b) => b.apiUsd - a.apiUsd);
}

function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}

function modelLabel(model) {
  return typeof model === "string" && model !== "" ? model : "(unknown)";
}

function report(episodes, creditUsd) {
  const lines = [];
  lines.push(`credit value assumed: $${creditUsd} per credit`);
  lines.push(`episodes: ${episodes.length}`);
  lines.push("");
  for (const episode of episodes) {
    lines.push(`EPISODE ${episode.episode}  [${episode.terminator}]`);
    lines.push(`  window     ${episode.startedAt} -> ${episode.endedAt}`);
    lines.push(`  models     ${episode.models.map(modelLabel).join(", ")}${episode.modelPure ? "" : "  (MIXED - per-model rates not attributable)"}`);
    lines.push(`  limit      ${episode.limitIds.join(",")}  plan=${episode.planTypes.join(",")}  used_percent=${episode.usedPercentRange[0]}..${episode.usedPercentRange[1]}`);
    lines.push(`  balance    ${episode.openingBalance} -> ${episode.closingBalance}   drawn=${episode.creditsDrawn.toFixed(4)} cr = ${formatUsd(episode.usdDrawn)}`);
    const tokens = episode.tokens;
    lines.push(`  tokens     uncached=${tokens.input_uncached_tokens.toLocaleString()}  cache_read=${tokens.input_cache_read_tokens.toLocaleString()}  cache_write=${tokens.input_cache_write_tokens.toLocaleString()}  output=${(tokens.output_text_tokens + tokens.output_reasoning_tokens).toLocaleString()}`);
    lines.push(`  API-equiv  ${formatUsd(episode.apiEquivalentUsd)}   coverage=${JSON.stringify(episode.coverage)}`);
    const ratio = episode.ratioCreditToApi;
    lines.push(`  credit$/API$ = ${ratio === null ? "n/a" : ratio.toFixed(4)}${episode.ratioIsFloor ? "   (FLOOR: exhaustion truncates the final charge)" : ""}`);
    lines.push(`  settlements ${episode.settlements} over ${episode.requests} requests (${episode.meanRequestsPerSettlement?.toFixed(1) ?? "n/a"} req/settlement), mixed-model buckets=${episode.mixedModelSettlements}, tail-suspect=${episode.suspectSettlements}`);
    if (Math.abs(episode.unattributedUsd) > 0.01) {
      const share = episode.usdDrawn > 0 ? (episode.unattributedUsd / episode.usdDrawn) * 100 : 0;
      lines.push(`  UNATTRIBUTED ${formatUsd(episode.unattributedUsd)} of ${formatUsd(episode.usdDrawn)} drawn (${share.toFixed(1)}%) has no observed request behind it`);
    }
    if (episode.modelBlocks.length > 1) {
      lines.push("  model blocks:");
      for (const block of episode.modelBlocks) {
        const clean = block.ratioCleanSettlements;
        lines.push(`    ${modelLabel(block.model).padEnd(16)} req=${String(block.requests).padStart(4)} settl=${String(block.settlements).padStart(3)} suspect=${String(block.suspectSettlements).padStart(2)}  drawn=${formatUsd(block.usdDrawn)} api=${formatUsd(block.apiEquivalentUsd)}  ratio(all)=${block.ratioAllSettlements?.toFixed(3) ?? "n/a"} ratio(clean)=${clean?.toFixed(3) ?? "n/a"}${block.usable ? "" : "  [NOT USABLE: <5 clean settlements]"}`);
      }
    }
    const fit = episode.scaleFit;
    if (fit) {
      const ci = fit.ci95 ? `[${fit.ci95[0].toFixed(4)}, ${fit.ci95[1].toFixed(4)}]` : "n/a";
      lines.push(`  scale fit  k=${fit.point.toFixed(4)}  R2=${fit.r2?.toFixed(4) ?? "n/a"}  bootstrap 95% CI ${ci}`);
      if (fit.ci95 && fit.ci95[0] <= 1 && fit.ci95[1] >= 1) {
        lines.push("             -> interval contains 1.0: consistent with API-price parity");
      }
    } else {
      lines.push("  scale fit  insufficient settlements for an interval");
    }
    lines.push("");
  }
  const table = crossModelTable(episodes);
  if (table.length) {
    lines.push("PER-MODEL RATIO (model-pure episodes only)");
    lines.push(`  ${"model".padEnd(20)}${"episodes".padStart(9)}${"credit$".padStart(12)}${"API$".padStart(12)}${"ratio".padStart(9)}`);
    for (const row of table) {
      lines.push(`  ${modelLabel(row.model).padEnd(20)}${String(row.episodes).padStart(9)}${row.usdDrawn.toFixed(4).padStart(12)}${row.apiUsd.toFixed(4).padStart(12)}${row.ratio.toFixed(4).padStart(9)}${row.floors ? "  (floor)" : ""}`);
    }
    if (table.length > 1) {
      const base = table[0];
      lines.push("");
      lines.push(`  relative to ${modelLabel(base.model)}:`);
      for (const row of table.slice(1)) {
        lines.push(`    ${modelLabel(row.model).padEnd(20)} ${(row.ratio / base.ratio).toFixed(4)}x`);
      }
    } else {
      lines.push("");
      lines.push("  only one model observed - inter-model ratios need a credit episode per model");
    }
  }
  return lines.join("\n");
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(episodes, labelFor) {
  const header = [
    "episode", "timestamp", "model", "service_tier", "reasoning_effort", "balance",
    "total_input_tokens", "input_uncached_tokens", "input_cache_read_tokens",
    "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens",
    "limit_id", "plan_type", "used_percent", "source_file",
  ];
  const rows = [header.join(",")];
  for (const episode of episodes) {
    for (const record of episode.records) {
      rows.push([
        episode.episode, record.timestamp, record.model ?? "", record.serviceTier ?? "",
        record.reasoningEffort ?? "", record.balance, record.totalInputTokens,
        record.inputUncachedTokens, record.inputCacheReadTokens, record.inputCacheWriteTokens,
        record.outputTextTokens, record.outputReasoningTokens, record.limitId ?? "",
        record.planType ?? "", record.usedPercent ?? "", labelFor(record.sourceFile),
      ].map(csvField).join(","));
    }
  }
  return rows.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`Usage: node scripts/analyze-credit-drawdown.js [options]

  --sessions <dir>     rollout root (default ~/.codex/sessions)
  --since <YYYY-MM-DD> only scan files modified on/after this date
  --file <path>        analyze specific rollout files (repeatable, skips discovery)
  --json <path>        write the full analysis as JSON
  --csv <path>         write per-request credit rows as CSV
  --credit-usd <n>     dollar value of one credit (default ${DEFAULT_CREDIT_USD})
  --bootstrap <n>      bootstrap resamples for the scale interval (default ${DEFAULT_BOOTSTRAP})
  --reveal-paths       write real rollout paths into --json/--csv artifacts
                       (default: stable opaque labels; session paths are private)
`);
    return;
  }

  // Session files rotate, compact, and change permissions while a scan runs.
  // One bad file must neither abort the run nor leak its private path into
  // any output channel: skips are counted, never named.
  const skipped = { count: 0 };

  let targets = opts.files;
  if (targets.length === 0) {
    const candidates = await discoverRolloutFiles(opts.sessions, opts.since, skipped);
    process.stderr.write(`scanning ${candidates.length} rollout files for credit records...\n`);
    targets = [];
    for (const candidate of candidates) {
      try {
        if (await fileHasCredits(candidate)) targets.push(candidate);
      } catch {
        skipped.count += 1;
      }
    }
  } else {
    // The same rollout named twice (directly or through a symlink) would
    // silently double-count every settlement it carries.
    const seen = new Set();
    const unique = [];
    for (const target of targets) {
      let key = target;
      try {
        key = await realpath(target);
      } catch {
        // Unreadable now; readCreditRecords below skips and counts it.
      }
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(target);
    }
    targets = unique;
  }

  const records = [];
  const readTargets = [];
  for (const target of targets) {
    try {
      records.push(...await readCreditRecords(target));
      readTargets.push(target);
    } catch {
      skipped.count += 1;
    }
  }
  targets = readTargets;
  if (skipped.count > 0) {
    process.stderr.write(`unreadable rollout files skipped: ${skipped.count}\n`);
  }
  if (targets.length === 0) {
    process.stdout.write("no credit-bearing rollout records found\n");
    return;
  }
  process.stderr.write(`credit-bearing files: ${targets.length}\n`);

  records.sort((a, b) => {
    const left = Date.parse(a.timestamp);
    const right = Date.parse(b.timestamp);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
      return left - right;
    }
    return String(a.timestamp).localeCompare(String(b.timestamp));
  });

  const episodes = buildEpisodes(records);
  const analyzed = episodes.map((episode, index) =>
    analyzeEpisode(episode, index + 1, opts.creditUsd, opts.bootstrap));
  for (const [index, episode] of episodes.entries()) analyzed[index].records = episode.records;

  process.stdout.write(`${report(analyzed, opts.creditUsd)}\n`);

  const fileLabels = new Map(
    [...targets].sort().map((path, index) =>
      [path, `rollout-${String(index + 1).padStart(2, "0")}`]),
  );
  const labelFor = opts.revealPaths
    ? (path) => path
    : (path) => fileLabels.get(path) ?? "rollout-unknown";

  if (opts.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      creditUsd: opts.creditUsd,
      sourceFiles: targets.map(labelFor),
      episodes: analyzed.map(({ records: _records, ...rest }) => ({
        ...rest,
        sourceFiles: rest.sourceFiles.map(labelFor),
      })),
      perModel: crossModelTable(analyzed),
    };
    await writeFile(opts.json, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`wrote ${opts.json}\n`);
  }
  if (opts.csv) {
    await writeFile(opts.csv, `${toCsv(analyzed, labelFor)}\n`);
    process.stderr.write(`wrote ${opts.csv}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
