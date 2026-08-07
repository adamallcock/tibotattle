#!/usr/bin/env node
// What the dashboard is actually saying, read from the running companion.
//
// This exists because the alternative was asking the owner to describe their
// own screen. That is slow, it is lossy, and three separate defects this
// session were misdiagnosed from a screenshot: a "stale" banner that was a
// build-versus-source mismatch, a Spark card whose CSS could not produce what
// the picture showed, and an app that "looked old" because it was old. Every
// one of them is answerable from the companion's own payload plus the bundle
// on disk, so this asks both and prints the answer.
//
// It reads. It never writes, never refreshes, and never mutates state.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The companion binds an ephemeral port chosen by the OS, so a fixed default
 * finds nothing. Ask lsof which local ports the running TiboTattle (or a
 * repo-run companion) is listening on and probe each for the health route.
 */
async function discoverOrigin() {
  if (process.env.TIBOTATTLE_ORIGIN) return process.env.TIBOTATTLE_ORIGIN;
  let listing = "";
  try {
    listing = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return "http://127.0.0.1:8787";
  }
  const ports = [...new Set([...listing.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)]
    .map((match) => Number(match[1])))];
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/local/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (typeof body?.schemaVersion === "string"
          && body.schemaVersion.startsWith("local-companion")) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      continue;
    }
  }
  return "http://127.0.0.1:8787";
}

const ORIGIN = await discoverOrigin();
const BUNDLE = process.env.TIBOTATTLE_APP
  ?? "/Applications/TiboTattle.app/Contents/Resources/app";
const REPO = new URL("../", import.meta.url).pathname;

const out = [];
const say = (line = "") => out.push(line);

async function json(path) {
  const response = await fetch(`${ORIGIN}${path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

function ageOf(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null;
}

/**
 * The single question that wasted the most time this session: is the fix the
 * owner is looking for actually inside the app they are running? A committed
 * fix in an unbuilt bundle looks exactly like a fix that did not work.
 */
function bundleDrift() {
  // index.html is deliberately absent: release packaging substitutes its
  // `__USAGE_MONITOR_*__` slots at build time, so a correct bundle never
  // matches the repo byte-for-byte and comparing it reports a permanent false
  // "STALE". Caught on this script's first run.
  const files = [
    "src/local-companion-data.js",
    "apps/web/public/app.js",
    "apps/web/public/styles.css",
    "apps/web/public/data-client.js",
  ];
  const rows = [];
  for (const file of files) {
    let installed = null;
    let repo = null;
    try { installed = readFileSync(join(BUNDLE, file), "utf8"); } catch {}
    try { repo = readFileSync(join(REPO, file), "utf8"); } catch {}
    rows.push({
      file,
      present: installed !== null,
      matchesRepo: installed !== null && repo !== null && installed === repo,
    });
  }
  return rows;
}

try {
  const [health, overview, refreshStatus] = await Promise.all([
    json("/api/local/health"),
    json("/api/local/overview"),
    json("/api/local/refresh").catch(() => null),
  ]);
  const freshness = overview.freshness ?? {};

  say("COMPANION");
  say(`  origin                ${ORIGIN}`);
  say(`  status                ${health.status}`);
  say(`  snapshot              ${JSON.stringify(health.snapshot ?? null)}`);
  say("");
  const refresh = refreshStatus?.refresh ?? null;
  say("LAST REFRESH  (a failed refresh is why the index stops advancing)");
  if (refresh === null) {
    say("  (refresh status unavailable)");
  } else {
    say(`  status                ${refresh.status}`);
    say(`  startedAt             ${refresh.startedAt}  finishedAt ${refresh.finishedAt}`);
    if (refresh.errorCode) say(`  errorCode             ${refresh.errorCode}`);
    if (refresh.failedStep) say(`  failedStep            ${refresh.failedStep}`);
    if (refresh.failureCode) say(`  failureCode           ${refresh.failureCode}`);
    if (refresh.status === "failed" && !refresh.failedStep) {
      say("  (no failedStep: companion predates the step-stamped failures)");
    }
    if (refresh.result?.unifiedIndex) {
      say(`  unifiedIndex          ${JSON.stringify(refresh.result.unifiedIndex).slice(0, 200)}`);
    }
  }
  say("");
  say("FRESHNESS  (what the banner is derived from)");
  say(`  freshness.status      ${freshness.status}`);
  say(`  observation age       ${freshness.ageSeconds}s  (threshold ${freshness.staleAfterSeconds}s)`);
  say(`  accountingStatus      ${freshness.accountingStatus}`);
  say(`  latestObservedAt      ${freshness.latestObservedAt}  (${ageOf(freshness.latestObservedAt)}s ago)`);
  say(`  generatedAt           ${overview.generatedAt}  (${ageOf(overview.generatedAt)}s ago)`);
  const wouldSayStale = freshness.status === "stale";
  say(`  => page renders       ${wouldSayStale ? "STALE NOTICE" : "no freshness notice"}`);
  if (wouldSayStale
      && Number.isFinite(freshness.ageSeconds)
      && Number.isFinite(freshness.staleAfterSeconds)
      && freshness.ageSeconds <= freshness.staleAfterSeconds) {
    say(`  !! observation is INSIDE its threshold yet the verdict is stale.`);
    say(`     Something other than observation age is driving it.`);
  }

  say("");
  say("COVERAGE  (why the numbers may not look real yet)");
  const coverage = overview.coverage?.history ?? overview.historyCoverage ?? {};
  const indexed = coverage.indexedSourceCount ?? coverage.indexed ?? null;
  const total = coverage.sourceCount ?? coverage.discovered ?? null;
  say(`  indexed sources       ${indexed ?? "?"} of ${total ?? "?"}`
    + (indexed && total ? `  (${(indexed / total * 100).toFixed(1)}%)` : ""));
  say(`  indexed bytes         ${coverage.indexedBytes ?? "?"} of ${coverage.sourceBytes ?? "?"}`);

  say("");
  const warnings = Array.isArray(overview.warnings) ? overview.warnings : [];
  say(`WARNINGS  (${warnings.length})`);
  for (const warning of warnings) say(`  - ${String(warning).slice(0, 160)}`);
  if (warnings.length === 0) say("  (none)");

  say("");
  say("HEADLINE FIGURES");
  const periods = Array.isArray(overview.usage) ? overview.usage : [];
  for (const period of periods.slice(0, 6)) {
    say(`  ${String(period.id).padEnd(16)} events=${period.events ?? "?"}`);
  }
} catch (error) {
  say("COMPANION UNREACHABLE");
  say(`  ${error.message}`);
  say("  Start the app, or set TIBOTATTLE_ORIGIN.");
}

say("");
say("INSTALLED BUNDLE vs REPO  (a committed fix in an unbuilt bundle looks broken)");
try { say(`  installed             ${statSync(BUNDLE).mtime.toISOString()}`); } catch {}
for (const row of bundleDrift()) {
  const verdict = !row.present ? "MISSING" : row.matchesRepo ? "current" : "STALE - repo is newer";
  say(`  ${row.file.padEnd(34)} ${verdict}`);
}

process.stdout.write(`${out.join("\n")}\n`);
