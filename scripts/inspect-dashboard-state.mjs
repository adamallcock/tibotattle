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

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createOwnerAuthorizedLocalReader } from "./lib/owner-authorized-local-read.mjs";

// Standalone inspection uses only the explicitly owner-selected bootstrap.
// Electron access stays in its trusted renderer; port discovery is not authority.
const args = process.argv.slice(2);
let access;
async function authorizedAccess() {
  if (args.length !== 2 || args[0] !== "--authorization-file" || !args[1]) {
    throw new Error("Use --authorization-file with the owner's standalone dashboard access file.");
  }
  access ??= await createOwnerAuthorizedLocalReader(args[1], { expectedOrigin: process.env.TIBOTATTLE_ORIGIN });
  return access;
}
const BUNDLE = process.env.TIBOTATTLE_APP
  ?? "/Applications/TiboTattle.app/Contents/Resources/app";
const REPO = new URL("../", import.meta.url).pathname;

const out = [];
const say = (line = "") => out.push(line);

async function json(path) {
  return (await authorizedAccess()).read(path);
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
  say(`  origin                ${access.origin}`);
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
  say("  Select the unexpired standalone dashboard access file; Electron inspection requires its trusted renderer.");
}

say("");
say("INSTALLED BUNDLE vs REPO  (a committed fix in an unbuilt bundle looks broken)");
try { say(`  installed             ${statSync(BUNDLE).mtime.toISOString()}`); } catch {}
for (const row of bundleDrift()) {
  const verdict = !row.present ? "MISSING" : row.matchesRepo ? "current" : "STALE - repo is newer";
  say(`  ${row.file.padEnd(34)} ${verdict}`);
}

process.stdout.write(`${out.join("\n")}\n`);
