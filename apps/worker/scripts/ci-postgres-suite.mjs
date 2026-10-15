#!/usr/bin/env node
/**
 * Run every PostgreSQL 17 spec under apps/worker in exactly one environment
 * profile, and fail on anything that did not run and pass.
 *
 * The specs skip silently when their PG_TEST_* variables are absent, and they
 * do not agree on which variable they read:
 *
 *   SOCKET  PG_TEST_SOCKET=<private socket directory>, PG_TEST_HOST unset.
 *           Every file whose PostgreSQL gate reads PG_TEST_SOCKET, including
 *           the dual-key files (`!PG_TEST_HOST && !PG_TEST_SOCKET`) whose
 *           endpoint helpers reject a non-loopback PG_TEST_HOST, and every file
 *           without a gate.
 *   HOST    PG_TEST_HOST=<the same socket directory>, PG_TEST_SOCKET unset.
 *           Only files whose every PostgreSQL gate reads PG_TEST_HOST alone.
 *
 * Running every file under both profiles fails by construction, so the route
 * is derived per file from its skip expressions. The derivation resolves the
 * identifiers in those expressions to the environment variable they are bound
 * to: two specs bind a local `PG_TEST_HOST` to `process.env.PG_TEST_SOCKET`,
 * so a name-only scan would send them to the HOST pass, where they skip.
 * The derived HOST list is frozen in EXPECTED_HOST_PROFILE_FILES; any change
 * fails PROFILE_ROUTING_DRIFT until it is reviewed here.
 *
 * Registration is read from the places the Worker gate runs PostgreSQL specs
 * from: the `postgres:domain:check` script, the include arrays of
 * vitest.postgres.config.ts and vitest.node.config.ts, and the frozen
 * EXTRA_REGISTRATION_SCRIPTS (`edge:e2e`, `postgres:production-migrations:check`).
 * UNREGISTERED_ALLOWLIST names the specs registered in none of them; it may
 * only shrink.
 *
 * A spec registered by a script in SCRIPT_PROFILES runs in that explicit
 * profile through the script's own steps instead of a SOCKET or HOST pass.
 * EDGE_E2E (`edge:e2e`, postgres-test/edge-origin-e2e.spec.mjs) needs the
 * cloud-run build, workerd and the image runtime (Node 22.16.0, named by
 * EDGE_E2E_NODE), and its S9 stage reads the golden named by EDGE_E2E_GOLDEN.
 * Without them the spec is reported as a named ENVIRONMENT_GAP and the run is
 * "incomplete", never green and never a silent skip.
 *
 * Failure codes (one entry per file and test, never payloads):
 *   FAILED, ENV_PROFILE_CONFLICT, SILENTLY_SKIPPED, EMPTY_SPEC_FILE,
 *   UNREGISTERED_POSTGRES_SPEC, ALLOWLIST_STALE, REGISTERED_SPEC_MISSING,
 *   REGISTRATION_DUPLICATE, REGISTRATION_PARSE_FAILED,
 *   PROFILE_ROUTING_AMBIGUOUS, PROFILE_ROUTING_DRIFT, UNPLANNED_SPEC_RESULT,
 *   SUITE_PROCESS_FAILED, PREREQUISITE_FAILED, TAP_INCOMPLETE,
 *   TAP_PARSE_MISMATCH, TAP_TEST_COUNT_MISMATCH, VITEST_REPORT_INVALID.
 * Environment gaps (reported apart from failures): ENVIRONMENT_GAP.
 *
 * An ENV_PROFILE_CONFLICT belongs to the family that owns the named spec. This
 * runner never edits or weakens a spec to obtain a green result.
 *
 * Usage (the SOCKET profile comes from ci-postgres-container.mjs; the
 * hosted-backend workflow adds the container's loopback TCP pair,
 * ciPostgresTcpProfile()):
 *   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-ci/socket PG_TEST_PORT=5432 \
 *   PG_TEST_TCP_HOST=127.0.0.1 PG_TEST_TCP_PORT=55432 \
 *     node scripts/ci-postgres-suite.mjs
 *   node scripts/ci-postgres-suite.mjs --plan    # static checks only, no database
 *
 * CI may schedule the closed CORE_A, CORE_B and EDGE_E2E partitions on
 * independent clusters with --partition <name> --receipt <new-file>. Each is
 * partial evidence. --aggregate accepts exactly one same-run receipt per
 * partition, recomputes the full plan, binds the provider run/attempt, exact
 * checkout, pinned runtimes and generated build inputs, requires every
 * producer job to succeed, and evaluates every canonical file exactly once.
 * No-flag execution remains the complete serial gate.
 * Suite progress JSON on stderr contains canonical file ownership and elapsed
 * time; the EDGE runner adds only validated closed S9 component/phase progress.
 * Stdout continues to contain one result summary.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  S9_DIAGNOSTIC_BYTES,
  S9_TAP_PROGRESS_PREFIX,
  validateClosedS9Progress,
} from "./s9-rehearsal-diagnostics.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const POSTGRES_TEST_DIRECTORY = "postgres-test";
export const DOMAIN_CHECK_SCRIPT = "postgres:domain:check";
export const VITEST_POSTGRES_CONFIG = "vitest.postgres.config.ts";
export const VITEST_NODE_CONFIG = "vitest.node.config.ts";
export const VITEST_REGISTRATION_CONFIGS = Object.freeze([
  VITEST_POSTGRES_CONFIG,
  VITEST_NODE_CONFIG,
]);
export const PROFILE_SOCKET = "SOCKET";
export const PROFILE_HOST = "HOST";
export const PROFILE_EDGE_E2E = "EDGE_E2E";
export const NODE_RUNNER = "node";
export const EDGE_PARTITION_FILES = Object.freeze([
  "postgres-test/edge-origin-e2e.spec.mjs",
]);
export const CORE_PARTITION_FILES = Object.freeze({
  CORE_A: Object.freeze([
    "postgres-test/v12-domain-roundtrip.spec.mjs",
    "postgres-test/postgres-community-graph-roundtrip.spec.mjs",
    "postgres-test/postgres-community-graph-cohort.spec.mjs",
    "postgres-test/postgres-community-allowance-fits.spec.mjs",
    "postgres-test/postgres-community-daily-roundtrip.spec.mjs",
    "postgres-test/postgres-community-daily-host.spec.mjs",
    "postgres-test/postgres-analytics-event-tuple.spec.mjs",
    "postgres-test/postgres-ingestion-journal-transfer.spec.mjs",
    "postgres-test/d1-analytics-export-oracle.spec.mjs",
    "postgres-test/postgres-identity-authority-transfer.spec.mjs",
    "postgres-test/postgres-legacy-contribution-transfer.spec.mjs",
    "postgres-test/cutover-source-seal-rehearsal.spec.mjs",
    "postgres-test/postgres-production-telemetry-modes.spec.mjs",
    "postgres-test/postgres-production-transfer.spec.mjs",
    "postgres-test/community-allowance-rich-days.spec.mjs",
    "postgres-test/v12-domain-forward.check.mjs",
    "postgres-test/v12-ready-manifest-retention.spec.mjs",
    "postgres-test/typed-legacy-effective-reader.spec.mjs",
    "postgres-test/postgres-device-lifecycle.spec.mjs",
    "postgres-test/postgres-device-sync-reads.spec.mjs",
    "postgres-test/postgres-personal-session.spec.mjs",
    "postgres-test/postgres-telemetry-v12-consent.spec.mjs",
    "postgres-test/postgres-google-enrollment.spec.mjs",
    "postgres-test/postgres-accountless-retention-import.spec.mjs",
    "postgres-test/postgres-owner-journal-emitter-precheck.spec.mjs",
    "postgres-test/postgres-admin-audit.spec.mjs",
    "postgres-test/postgres-admission-isolation.spec.mjs",
    "postgres-test/postgres-lifecycle-state.spec.mjs",
    "postgres-test/postgres-transfer-target.spec.mjs",
    "postgres-test/postgres-transport-floor-parity.spec.mjs",
    "postgres-test/postgres-v12-owner-bridge.spec.mjs",
    "postgres-test/staged-migrations-harness.spec.mjs",
    "postgres-test/typed-telemetry-live-allocators.spec.mjs",
    "postgres-test/typed-v12-domain-unchanged.spec.mjs",
    "postgres-test/postgres-fastpath-identity-copy.spec.mjs",
    "postgres-test/postgres-origin-edge-test.spec.mjs",
    "postgres-test/postgres-test-runtime-grants.spec.mjs",
    "postgres-test/append-only-residue.spec.mjs",
    "postgres-test/online-erasure-absence.spec.mjs",
    "postgres-test/postgres-admin-console.spec.mjs",
    "postgres-test/postgres-admin-reconstruction-progress.spec.mjs",
    "postgres-test/postgres-lifecycle-pass.spec.mjs",
    "postgres-test/ops-runtime-probe.spec.mjs",
    "postgres-test/analytics-v2-interim-public-read.spec.mjs",
    "postgres-test/postgres-production-host.spec.mjs",
    "postgres-test/catalog-manifest-store.spec.mjs",
    "postgres-test/identity-link-rotation-kept-routes.spec.mjs",
    "postgres-test/analytics-v2-reprice.spec.mjs",
    "postgres-test/classification-correction.spec.mjs",
    "postgres-test/postgres-github-distribution-sync.spec.mjs",
    "postgres-test/github-distribution-manifest-visibility.spec.mjs",
    "postgres-test/legacy-typed-telemetry-roundtrip.spec.mjs",
    "postgres-test/telemetry-format-authority-roundtrip.spec.mjs",
    "postgres-test/v12-transport-roundtrip.spec.mjs",
  ]),
  CORE_B: Object.freeze([
    "postgres-test/typed-v12-effective-reader-scope.spec.mjs",
    "postgres-test/usage-correction-transfer.spec.mjs",
    "postgres-test/accountless-renewal.spec.mjs",
    "postgres-test/postgres-maintenance.spec.mjs",
    "postgres-test/postgres-google-handoff.spec.mjs",
    "postgres-test/postgres-owner-journal-authority.spec.mjs",
    "postgres-test/postgres-collection-controls.spec.mjs",
    "postgres-test/postgres-device-bearer-auth.spec.mjs",
    "postgres-test/postgres-host-diagnostics.spec.mjs",
    "postgres-test/postgres-signin-primitives.spec.mjs",
    "postgres-test/postgres-storage-community-authority.spec.mjs",
    "postgres-test/postgres-transport-write-authority.spec.mjs",
    "postgres-test/postgres-upload-path-analytics-retirement.spec.mjs",
    "postgres-test/typed-v12-predecessor-day-count.spec.mjs",
    "postgres-test/typed-v12-storage-constraint.spec.mjs",
    "postgres-test/postgres-origin-fastpath.spec.mjs",
    "postgres-test/analytics-v2-occurrence-source.spec.mjs",
    "postgres-test/read-expansion-real-boundaries.spec.mjs",
    "postgres-test/analytics-v2-read-plan.spec.mjs",
    "postgres-test/analytics-v2-refresh.spec.mjs",
    "postgres-test/analytics-v2-owner-sets.spec.mjs",
    "postgres-test/analytics-v2-price-cards.spec.mjs",
    "postgres-test/analytics-v2-pricing-classes.spec.mjs",
    "postgres-test/analytics-v2-community-daily-route.spec.mjs",
    "postgres-test/postgres-v12-transfer.spec.mjs",
    "postgres-test/postgres-telemetry-v11-live.spec.mjs",
    "postgres-test/postgres-legacy-contribution-admission.spec.mjs",
    "postgres-test/postgres-origin-intake.spec.mjs",
    "postgres-test/postgres-function-search-path.spec.mjs",
    "postgres-test/analytics-v2-revision-floor.spec.mjs",
    "postgres-test/unseen-token-probe.spec.mjs",
    "postgres-test/analytics-v2-historical-spend.spec.mjs",
    "postgres-test/postgres-production-migrations.spec.mjs",
    "postgres-test/device-credential-renewal.spec.mjs",
    "postgres-test/legacy-source-membership-roundtrip.spec.mjs",
    "postgres-test/postgres-device-pairing-claim.spec.mjs",
    "postgres-test/postgres-device-pairing.spec.mjs",
    "postgres-test/postgres-quarantine-reconciliation.spec.mjs",
    "postgres-test/typed-v12-normalized.spec.mjs",
    "postgres-test/upload-authorization-roundtrip.spec.mjs",
  ]),
});
export const CORE_PARTITIONS = Object.freeze(Object.keys(CORE_PARTITION_FILES));
export const PARTITIONS = Object.freeze([...CORE_PARTITIONS, "EDGE_E2E"]);
export const TOOLCHAIN_NODE_VERSION = "v26.2.0";

/**
 * package.json scripts beyond postgres:domain:check whose ./postgres-test/
 * specs count as registered. Frozen: a new entry is a reviewed change here.
 */
export const EXTRA_REGISTRATION_SCRIPTS = Object.freeze([
  "edge:e2e",
  "postgres:production-migrations:check",
]);

/**
 * Registration scripts whose specs run in an explicit profile, through the
 * script's own steps, rather than in the SOCKET or HOST pass.
 */
export const SCRIPT_PROFILES = Object.freeze({
  "edge:e2e": PROFILE_EDGE_E2E,
});

/** The only steps an extra registration script may run before its specs. */
export const EXTRA_SCRIPT_PREREQUISITES = Object.freeze([
  "node ./cloud-run/build.mjs",
]);

/** The EDGE_E2E profile's runtime: the image's Node, named by EDGE_E2E_NODE. */
export const EDGE_E2E_NODE_VERSION = "v22.16.0";
export const EDGE_E2E_NODE_VARIABLE = "EDGE_E2E_NODE";
/**
 * The EDGE_E2E spec imports rollout tooling that reaches .ts sources (for
 * example src/edge-origin-contract.ts), and Node before 22.18 strips types only
 * behind this flag; the origin itself still loads from the bundled dist.
 */
export const EDGE_E2E_NODE_FLAGS = Object.freeze(["--experimental-strip-types"]);
export const EDGE_E2E_GOLDEN_VARIABLE = "EDGE_E2E_GOLDEN";
const EDGE_E2E_S9_MODE_VARIABLE = "EDGE_E2E_S9_COMPARISON_MODE";
const CURRENT_D7_S9_MODE = "current-worker-d1-d7";
const CURRENT_D7_EDGE_E2E_TEST_COUNT = 20;

export function scriptRunner(script) {
  return `script:${script}`;
}

/**
 * PostgreSQL specs registered in none of the three sources. Shrink only: an
 * entry that is registered or deleted fails ALLOWLIST_STALE, and a new
 * unregistered spec fails UNREGISTERED_POSTGRES_SPEC instead of joining this
 * list.
 */
export const UNREGISTERED_ALLOWLIST = Object.freeze([
  "postgres-test/device-credential-renewal.spec.mjs",
  "postgres-test/legacy-source-membership-roundtrip.spec.mjs",
  "postgres-test/legacy-typed-telemetry-roundtrip.spec.mjs",
  "postgres-test/postgres-device-pairing-claim.spec.mjs",
  "postgres-test/postgres-device-pairing.spec.mjs",
  "postgres-test/postgres-quarantine-reconciliation.spec.mjs",
  "postgres-test/telemetry-format-authority-roundtrip.spec.mjs",
  "postgres-test/typed-v12-normalized.spec.mjs",
  "postgres-test/upload-authorization-roundtrip.spec.mjs",
  "postgres-test/v12-transport-roundtrip.spec.mjs",
]);

/**
 * The files whose every PostgreSQL gate reads PG_TEST_HOST alone. The OPS-6
 * brief listed four; legacy-source-membership-roundtrip and
 * legacy-typed-telemetry-roundtrip bind their local PG_TEST_HOST to
 * process.env.PG_TEST_SOCKET and skip in the HOST profile, so they route
 * SOCKET.
 */
export const EXPECTED_HOST_PROFILE_FILES = Object.freeze([
  // ledger-authority.spec.mjs, the other HOST file, was deleted with the
  // deletion ledger (LEAD-SIMP, SIMP-4).
  "postgres-test/typed-v12-normalized.spec.mjs",
]);

const PG_GATE_ENVIRONMENT = new Set(["PG_TEST_HOST", "PG_TEST_SOCKET"]);
const SOCKET_DIRECTORY_PATTERN = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const SPEC_FILE_PATTERN = /^[A-Za-z0-9._-]+\.(?:spec|check)\.mjs$/u;
const DOMAIN_TOKEN_PATTERN = /^\.\/postgres-test\/([A-Za-z0-9._-]+\.mjs)$/u;
// A non-PostgreSQL check an extra registration script may also run.
const EXTRA_CHECK_TOKEN_PATTERN = /^\.\/(?:cloud-run|scripts)\/[A-Za-z0-9._-]+\.check\.mjs$/u;
const GLOB_CHARACTERS = /[*?[\]{}!]/u;
const ENV_FAILURE_PATTERN = new RegExp([
  String.raw`\bPG_TEST_[A-Z_]+\b`,
  String.raw`\bloopback\b`,
  String.raw`\bUnix socket\b`,
  String.raw`tibotattle-pg-`,
  String.raw`\b(?:assertLocalSocket|localEndpoint|localPostgresConnection|localPostgresEndpoint|localSocket)\b`,
].join("|"), "u");

export class CiPostgresSuiteError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CiPostgresSuiteError";
    this.code = code;
  }
}

function failure(code, file, detail = null, extra = {}) {
  return Object.freeze({ code, file, ...(detail === null ? {} : { detail }), ...extra });
}

function toPosix(path) {
  return path.split(sep).join("/");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registration sources
// ---------------------------------------------------------------------------

/**
 * Tokenize the `postgres:domain:check` script. It may contain only two command
 * shapes, joined by `&&`:
 *
 *   node --test [--test-*[=value]]... ./postgres-test/<file>.mjs...
 *   vitest run --config <one of VITEST_REGISTRATION_CONFIGS>
 *
 * Anything else (a file outside ./postgres-test/, another vitest config, a
 * filter, a flag taking a separate value, another command) is a registration
 * this runner would not execute, so it fails REGISTRATION_PARSE_FAILED.
 */
export function parseDomainCheckRegistration(script) {
  if (typeof script !== "string" || script.trim() === "") {
    throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
      `package.json scripts["${DOMAIN_CHECK_SCRIPT}"] is missing`);
  }
  const unsupported = (detail) => new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
    `unsupported ${DOMAIN_CHECK_SCRIPT} ${detail}`);
  const nodeFiles = [];
  const vitestConfigs = [];
  for (const segment of script.split("&&")) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    if (tokens[0] === "node" && tokens[1] === "--test") {
      let files = 0;
      for (const token of tokens.slice(2)) {
        if (/^--test(?:-[a-z]+)+(?:=[^\s=]+)?$/u.test(token)) continue;
        const match = DOMAIN_TOKEN_PATTERN.exec(token);
        if (match === null) throw unsupported(`node --test argument ${JSON.stringify(token)}`);
        nodeFiles.push(`${POSTGRES_TEST_DIRECTORY}/${match[1]}`);
        files += 1;
      }
      if (files === 0) throw unsupported("node --test command without ./postgres-test/ files");
      continue;
    }
    if (tokens[0] === "vitest") {
      const config = tokens.length === 4 && tokens[1] === "run" && tokens[2] === "--config"
        ? tokens[3]
        : tokens.length === 3 && tokens[1] === "run" && tokens[2].startsWith("--config=")
          ? tokens[2].slice("--config=".length)
          : null;
      if (config === null || !VITEST_REGISTRATION_CONFIGS.includes(config)) {
        throw unsupported(`vitest command ${JSON.stringify(tokens.join(" "))}`);
      }
      vitestConfigs.push(config);
      continue;
    }
    throw unsupported(`command ${JSON.stringify(tokens.join(" "))}`);
  }
  return Object.freeze({
    nodeFiles: Object.freeze(nodeFiles),
    vitestConfigs: Object.freeze(vitestConfigs),
  });
}

/**
 * Tokenize one EXTRA_REGISTRATION_SCRIPTS script. Its `&&`-joined segments may
 * only be:
 *
 *   node --test [--test-*[=value]]... <file>...   where each file is
 *       ./postgres-test/<file>.mjs (registered) or
 *       ./cloud-run|scripts/<file>.check.mjs (a non-PostgreSQL check)
 *   one of EXTRA_SCRIPT_PREREQUISITES, exactly
 *
 * and must register at least one ./postgres-test/ spec. Anything else fails
 * REGISTRATION_PARSE_FAILED.
 */
export function parseExtraRegistrationScript(name, script) {
  if (typeof script !== "string" || script.trim() === "") {
    throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED", `package.json scripts["${name}"] is missing`);
  }
  const unsupported = (detail) => new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
    `unsupported ${name} ${detail}`);
  const nodeFiles = [];
  const testFlags = [];
  const prerequisites = [];
  for (const segment of script.split("&&")) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    const command = tokens.join(" ");
    if (EXTRA_SCRIPT_PREREQUISITES.includes(command)) {
      if (nodeFiles.length > 0) throw unsupported(`prerequisite ${JSON.stringify(command)} after its specs`);
      prerequisites.push(command);
      continue;
    }
    if (tokens[0] === "node" && tokens[1] === "--test") {
      let files = 0;
      for (const token of tokens.slice(2)) {
        if (/^--test(?:-[a-z]+)+(?:=[^\s=]+)?$/u.test(token)) {
          testFlags.push(token);
          continue;
        }
        const match = DOMAIN_TOKEN_PATTERN.exec(token);
        if (match !== null) {
          nodeFiles.push(`${POSTGRES_TEST_DIRECTORY}/${match[1]}`);
          files += 1;
          continue;
        }
        if (EXTRA_CHECK_TOKEN_PATTERN.test(token)) {
          files += 1;
          continue;
        }
        throw unsupported(`node --test argument ${JSON.stringify(token)}`);
      }
      if (files === 0) throw unsupported("node --test command without files");
      continue;
    }
    throw unsupported(`command ${JSON.stringify(command)}`);
  }
  if (nodeFiles.length === 0) throw unsupported("registers no ./postgres-test/ spec");
  return Object.freeze({
    nodeFiles: Object.freeze(nodeFiles),
    testFlags: Object.freeze([...new Set(testFlags)]),
    prerequisites: Object.freeze(prerequisites),
  });
}

function matchingBracket(source, openIndex, open, close) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Parse a vitest config's single `include: [...]` array of exact paths. */
export function parseVitestInclude(source, { label = "vitest config" } = {}) {
  const text = String(source);
  const matches = [...text.matchAll(/\binclude\s*:\s*\[/gu)];
  if (matches.length !== 1) {
    throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
      `${label} must declare exactly one include array`);
  }
  const openIndex = matches[0].index + matches[0][0].length - 1;
  const closeIndex = matchingBracket(text, openIndex, "[", "]");
  if (closeIndex < 0) {
    throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
      `${label} include array is not closed`);
  }
  const body = text.slice(openIndex + 1, closeIndex);
  const entries = [];
  const remainder = body.replace(/(["'])((?:\\.|(?!\1).)*)\1/gu, (_, _quote, value) => {
    entries.push(value);
    return "";
  });
  if (remainder.replace(/[\s,]/gu, "") !== "") {
    throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
      `${label} include array must contain only string literals`);
  }
  for (const entry of entries) {
    if (GLOB_CHARACTERS.test(entry) || entry.startsWith("/") || entry.includes("..")) {
      throw new CiPostgresSuiteError("REGISTRATION_PARSE_FAILED",
        `${label} include entry ${JSON.stringify(entry)} must be an exact relative path`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.replace(/^\.\//u, "")));
}

export async function loadRegistration(workerRoot) {
  const packageJson = JSON.parse(await readFile(join(workerRoot, "package.json"), "utf8"));
  const domain = parseDomainCheckRegistration(packageJson?.scripts?.[DOMAIN_CHECK_SCRIPT]);
  const vitest = {};
  for (const config of VITEST_REGISTRATION_CONFIGS) {
    vitest[config] = parseVitestInclude(
      await readFile(join(workerRoot, config), "utf8"),
      { label: config },
    );
  }
  const scripts = {};
  for (const name of EXTRA_REGISTRATION_SCRIPTS) {
    scripts[name] = parseExtraRegistrationScript(name, packageJson?.scripts?.[name]);
  }
  return Object.freeze({
    domainNodeFiles: domain.nodeFiles,
    domainVitestConfigs: domain.vitestConfigs,
    vitest: Object.freeze(vitest),
    scripts: Object.freeze(scripts),
  });
}

export async function listPostgresTestFiles(workerRoot) {
  const entries = await readdir(join(workerRoot, POSTGRES_TEST_DIRECTORY), { withFileTypes: true });
  return Object.freeze(entries
    .filter((entry) => entry.isFile() && SPEC_FILE_PATTERN.test(entry.name))
    .map((entry) => `${POSTGRES_TEST_DIRECTORY}/${entry.name}`)
    .sort());
}

/**
 * The shrink-only ratchet: every on-disk postgres-test spec is registered or
 * allowlisted, and every allowlist entry is still on disk and unregistered.
 */
export function checkRegistrationRatchet({ onDisk, registration, allowlist = UNREGISTERED_ALLOWLIST }) {
  const failures = [];
  const registered = new Map();
  const add = (file, source) => {
    const sources = registered.get(file) ?? [];
    sources.push(source);
    registered.set(file, sources);
  };
  for (const file of registration.domainNodeFiles) add(file, DOMAIN_CHECK_SCRIPT);
  for (const [config, files] of Object.entries(registration.vitest)) {
    for (const file of files) add(file, config);
  }
  for (const [script, { nodeFiles }] of Object.entries(registration.scripts ?? {})) {
    for (const file of nodeFiles) add(file, script);
  }
  for (const [file, sources] of registered) {
    if (sources.length > 1) {
      failures.push(failure("REGISTRATION_DUPLICATE", file, sources.join(", ")));
    }
  }
  const onDiskSet = new Set(onDisk);
  const allowlistSet = new Set(allowlist);
  for (const file of allowlist) {
    if (!onDiskSet.has(file)) {
      failures.push(failure("ALLOWLIST_STALE", file, "allowlisted spec is missing on disk"));
    }
    if (registered.has(file)) {
      failures.push(failure("ALLOWLIST_STALE", file,
        `allowlisted spec is registered in ${registered.get(file).join(", ")}`));
    }
  }
  for (const file of onDisk) {
    if (!registered.has(file) && !allowlistSet.has(file)) {
      failures.push(failure("UNREGISTERED_POSTGRES_SPEC", file));
    }
  }
  return Object.freeze({ registered, failures: Object.freeze(failures) });
}

// ---------------------------------------------------------------------------
// Profile routing
// ---------------------------------------------------------------------------

function environmentBindings(source) {
  const bindings = new Map();
  const direct = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\3\s*\])/gu;
  for (const match of source.matchAll(direct)) {
    bindings.set(match[1], match[2] ?? match[4]);
  }
  const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/gu;
  for (const match of source.matchAll(destructured)) {
    for (const part of match[1].split(",")) {
      const entry = part.replace(/=.*$/su, "").trim();
      if (entry === "") continue;
      const [key, alias] = entry.split(":").map((value) => value.trim());
      if (/^[A-Za-z_$][\w$]*$/u.test(alias ?? key)) bindings.set(alias ?? key, key);
    }
  }
  return bindings;
}

function readExpression(source, start, { untilClosingParenthesis }) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return source.slice(start, index);
      depth -= 1;
    } else if (!untilClosingParenthesis && depth === 0 && (character === "," || character === ";")) {
      return source.slice(start, index);
    }
  }
  return source.slice(start);
}

/** Every `skip:` value and `skipIf(`/`runIf(` argument in a spec source. */
export function extractGateExpressions(source) {
  const text = String(source);
  const expressions = [];
  for (const match of text.matchAll(/\bskip\s*:|\.(?:skipIf|runIf)\s*\(/gu)) {
    const start = match.index + match[0].length;
    const expression = readExpression(text, start, {
      untilClosingParenthesis: match[0].endsWith("("),
    }).trim();
    expressions.push(expression);
  }
  return Object.freeze(expressions);
}

function expressionEnvironment(expression, bindings) {
  const environment = new Set();
  const unresolved = [];
  const withoutDirect = expression.replace(
    /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/gu,
    (_, dotted, _quote, bracketed) => {
      environment.add(dotted ?? bracketed);
      return " ";
    },
  ).replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, " ");
  for (const match of withoutDirect.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/gu)) {
    const identifier = match[1];
    if (bindings.has(identifier)) {
      environment.add(bindings.get(identifier));
    } else if (/^PG_TEST_/u.test(identifier)) {
      unresolved.push(identifier);
    }
  }
  return { environment, unresolved };
}

/**
 * Route one spec source. HOST only when every PostgreSQL gate reads
 * PG_TEST_HOST and not PG_TEST_SOCKET; mixing HOST-only gates with
 * SOCKET-keyed gates, or a PG_TEST_* identifier with no visible
 * process.env binding, is ambiguous.
 */
export function deriveFileProfile(source) {
  const bindings = environmentBindings(String(source));
  const gates = [];
  const reasons = [];
  for (const expression of extractGateExpressions(source)) {
    const { environment, unresolved } = expressionEnvironment(expression, bindings);
    if (unresolved.length > 0) {
      reasons.push(`unresolved ${[...new Set(unresolved)].join(", ")}`);
    }
    const pg = [...environment].filter((name) => PG_GATE_ENVIRONMENT.has(name));
    if (pg.length === 0) continue;
    gates.push(pg.includes("PG_TEST_SOCKET") ? PROFILE_SOCKET : PROFILE_HOST);
  }
  const hostOnly = gates.filter((gate) => gate === PROFILE_HOST).length;
  const socketKeyed = gates.length - hostOnly;
  if (hostOnly > 0 && socketKeyed > 0) {
    reasons.push("mixes PG_TEST_HOST-only gates with PG_TEST_SOCKET gates");
  }
  if (reasons.length > 0) {
    return Object.freeze({ profile: null, ambiguous: true, gates: Object.freeze(gates), reasons: Object.freeze(reasons) });
  }
  return Object.freeze({
    profile: hostOnly > 0 ? PROFILE_HOST : PROFILE_SOCKET,
    ambiguous: false,
    gates: Object.freeze(gates),
    reasons: Object.freeze([]),
  });
}

export async function deriveProfileRouting({ workerRoot, files, expectedHostFiles = EXPECTED_HOST_PROFILE_FILES }) {
  const routing = new Map();
  const failures = [];
  for (const file of files) {
    const derived = deriveFileProfile(await readFile(join(workerRoot, file), "utf8"));
    if (derived.ambiguous) {
      failures.push(failure("PROFILE_ROUTING_AMBIGUOUS", file, derived.reasons.join("; ")));
      continue;
    }
    routing.set(file, derived.profile);
  }
  const hostFiles = [...routing].filter(([, profile]) => profile === PROFILE_HOST)
    .map(([file]) => file).sort();
  const expected = [...expectedHostFiles].sort();
  for (const file of hostFiles.filter((file) => !expected.includes(file))) {
    failures.push(failure("PROFILE_ROUTING_DRIFT", file, "derives HOST but is not in EXPECTED_HOST_PROFILE_FILES"));
  }
  for (const file of expected.filter((file) => !hostFiles.includes(file))) {
    failures.push(failure("PROFILE_ROUTING_DRIFT", file, "is in EXPECTED_HOST_PROFILE_FILES but does not derive HOST"));
  }
  return Object.freeze({
    routing,
    hostFiles: Object.freeze(hostFiles),
    failures: Object.freeze(failures),
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Build the static plan: which file runs in which runner and profile. Nothing
 * here touches a database.
 */
export async function planPostgresSuite({
  workerRoot = WORKER_ROOT,
  allowlist = UNREGISTERED_ALLOWLIST,
  expectedHostFiles = EXPECTED_HOST_PROFILE_FILES,
} = {}) {
  const failures = [];
  let registration;
  try {
    registration = await loadRegistration(workerRoot);
  } catch (error) {
    if (!(error instanceof CiPostgresSuiteError)) throw error;
    return Object.freeze({
      files: Object.freeze([]),
      hostProfileFiles: Object.freeze([]),
      failures: Object.freeze([failure(error.code, null, error.message)]),
    });
  }
  const onDisk = await listPostgresTestFiles(workerRoot);
  const ratchet = checkRegistrationRatchet({ onDisk, registration, allowlist });
  failures.push(...ratchet.failures);

  const candidates = [];
  const seen = new Set();
  const addCandidate = (file, runner, source, extra = {}) => {
    if (seen.has(file)) return;
    seen.add(file);
    candidates.push({ file, runner, source, ...extra });
  };
  for (const config of VITEST_REGISTRATION_CONFIGS) {
    for (const file of registration.vitest[config]) addCandidate(file, `vitest:${config}`, config);
  }
  for (const file of registration.domainNodeFiles) addCandidate(file, NODE_RUNNER, DOMAIN_CHECK_SCRIPT);
  for (const name of EXTRA_REGISTRATION_SCRIPTS) {
    const script = registration.scripts[name];
    const explicitProfile = Object.hasOwn(SCRIPT_PROFILES, name) ? SCRIPT_PROFILES[name] : null;
    for (const file of script.nodeFiles) {
      if (explicitProfile === null) {
        addCandidate(file, NODE_RUNNER, name);
      } else {
        addCandidate(file, scriptRunner(name), name, {
          explicitProfile,
          prerequisites: script.prerequisites,
          testFlags: script.testFlags,
        });
      }
    }
  }
  for (const file of allowlist) addCandidate(file, NODE_RUNNER, "UNREGISTERED_ALLOWLIST");

  const present = [];
  for (const candidate of candidates) {
    if (await exists(join(workerRoot, candidate.file))) {
      present.push(candidate);
    } else if (candidate.source !== "UNREGISTERED_ALLOWLIST") {
      failures.push(failure("REGISTERED_SPEC_MISSING", candidate.file, candidate.source));
    }
  }
  const routedFiles = [...new Set([...onDisk, ...present.map(({ file }) => file)])].sort();
  const routing = await deriveProfileRouting({ workerRoot, files: routedFiles, expectedHostFiles });
  failures.push(...routing.failures);

  const files = [];
  for (const { explicitProfile, ...candidate } of present) {
    const derived = routing.routing.get(candidate.file);
    if (derived === undefined) continue;
    if (derived === PROFILE_HOST && candidate.runner !== NODE_RUNNER) {
      failures.push(failure("PROFILE_ROUTING_DRIFT", candidate.file,
        explicitProfile === undefined
          ? "HOST-routed specs must be node:test files"
          : `explicit ${explicitProfile} specs read the SOCKET profile`));
    }
    files.push(Object.freeze({ ...candidate, profile: explicitProfile ?? derived }));
  }
  return Object.freeze({
    files: Object.freeze(files),
    hostProfileFiles: routing.hostFiles,
    failures: Object.freeze(failures),
  });
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

export function classifyFailureDetail(detail) {
  return ENV_FAILURE_PATTERN.test(String(detail ?? "")) ? "ENV_PROFILE_CONFLICT" : "FAILED";
}

function splitTapDescription(description) {
  let index = 0;
  let name = "";
  while (index < description.length) {
    const character = description[index];
    if (character === "\\" && index + 1 < description.length) {
      const next = description[index + 1];
      name += next === "n" ? "\n" : next;
      index += 2;
      continue;
    }
    if (character === "#" && (index === 0 || description[index - 1] === " ")) {
      const directive = /^#\s*(SKIP|TODO)\b/iu.exec(description.slice(index));
      if (directive !== null) {
        return { name: name.replace(/ $/u, ""), directive: directive[1].toUpperCase() };
      }
    }
    name += character;
    index += 1;
  }
  return { name, directive: null };
}

/**
 * Parse one file's `node --test --test-reporter=tap` output. Leaves become
 * tests keyed by their full name; the synthetic point node emits for a file
 * that produced no test (or failed to load) becomes a file-level result.
 */
export function parseNodeTap(text, { absoluteFile, cwd, expectedTestCount }) {
  const lines = String(text).split(/\r?\n/u);
  const subtests = [];
  const hasChildren = [];
  const points = [];
  const trailer = {};
  let yaml = null;
  let sawVersion = false;
  for (const line of lines) {
    if (yaml !== null) {
      if (line.trim() === "..." && line.length - line.trimStart().length === yaml.indent) {
        yaml.point.detail = yaml.lines.join("\n");
        yaml = null;
      } else {
        yaml.lines.push(line);
      }
      continue;
    }
    if (/^TAP version \d+$/u.test(line)) {
      sawVersion = true;
      continue;
    }
    const subtest = /^( *)# Subtest: (.*)$/u.exec(line);
    if (subtest !== null) {
      const level = subtest[1].length / 4;
      if (!Number.isInteger(level)) continue;
      subtests.length = level;
      subtests[level] = splitTapDescription(subtest[2]).name;
      hasChildren.length = level + 1;
      hasChildren[level] = false;
      if (level > 0) hasChildren[level - 1] = true;
      continue;
    }
    const point = /^( *)(ok|not ok) \d+(?: - (.*))?$/u.exec(line);
    if (point !== null) {
      const level = point[1].length / 4;
      if (!Number.isInteger(level)) continue;
      const { name, directive } = splitTapDescription(point[3] ?? "");
      const entry = {
        level,
        path: [...subtests.slice(0, level), name],
        ok: point[2] === "ok",
        directive,
        leaf: hasChildren[level] !== true,
        detail: "",
      };
      points.push(entry);
      subtests.length = level;
      hasChildren.length = level;
      continue;
    }
    const yamlStart = /^( *)---$/u.exec(line);
    if (yamlStart !== null && points.length > 0) {
      yaml = { indent: yamlStart[1].length, lines: [], point: points.at(-1) };
      continue;
    }
    const count = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (count !== null) trailer[count[1]] = Number(count[2]);
  }

  const tests = [];
  const parseFailures = [];
  let fileFailure = null;
  const failingLeafPaths = [];
  for (const point of points) {
    const synthetic = point.level === 0 && point.leaf
      && resolve(cwd, point.path[0]) === absoluteFile;
    if (synthetic) {
      if (!point.ok) fileFailure = point.detail;
      continue;
    }
    if (!point.leaf && point.directive === null) continue;
    const status = point.directive === "SKIP"
      ? "skipped"
      : point.directive === "TODO" ? "todo" : point.ok ? "passed" : "failed";
    if (status === "failed") failingLeafPaths.push(point.path.join(" > "));
    tests.push({ name: point.path.join(" > "), status, detail: point.detail });
  }
  for (const point of points) {
    if (point.leaf || point.ok || point.directive !== null || point.level === 0 && resolve(cwd, point.path[0]) === absoluteFile) continue;
    const prefix = `${point.path.join(" > ")} > `;
    if (!failingLeafPaths.some((path) => path.startsWith(prefix))) {
      tests.push({ name: point.path.join(" > "), status: "failed", detail: point.detail });
    }
  }
  if (!sawVersion || trailer.tests === undefined) {
    parseFailures.push("TAP_INCOMPLETE");
  } else {
    const parsedSkips = tests.filter(({ status }) => status === "skipped" || status === "todo").length;
    const parsedFailures = tests.filter(({ status }) => status === "failed").length
      + (fileFailure === null ? 0 : 1);
    if (((trailer.skipped ?? 0) + (trailer.todo ?? 0) > 0 && parsedSkips === 0)
        || ((trailer.fail ?? 0) + (trailer.cancelled ?? 0) > 0 && parsedFailures === 0)) {
      parseFailures.push("TAP_PARSE_MISMATCH");
    }
  }
  if (expectedTestCount !== undefined && tests.length !== expectedTestCount) {
    parseFailures.push("TAP_TEST_COUNT_MISMATCH");
  }
  return Object.freeze({
    tests: Object.freeze(tests),
    fileFailure,
    parseFailures: Object.freeze(parseFailures),
    cancelled: trailer.cancelled ?? 0,
  });
}

const VITEST_STATUS = new Map([
  ["passed", "passed"],
  ["failed", "failed"],
  ["skipped", "skipped"],
  ["pending", "skipped"],
  ["disabled", "skipped"],
  ["todo", "todo"],
]);

/** Parse a vitest `--reporter=json` report into per-file results. */
export function parseVitestReport(report, { workerRoot }) {
  const files = new Map();
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) {
    return Object.freeze({ files, parseFailures: Object.freeze(["VITEST_REPORT_INVALID"]) });
  }
  const parseFailures = [];
  for (const result of report.testResults) {
    if (typeof result?.name !== "string" || !Array.isArray(result.assertionResults)) {
      parseFailures.push("VITEST_REPORT_INVALID");
      continue;
    }
    const file = toPosix(relative(workerRoot, result.name));
    const tests = result.assertionResults.map((assertion) => ({
      name: [...(assertion.ancestorTitles ?? []), assertion.title].join(" > "),
      status: VITEST_STATUS.get(assertion.status) ?? "failed",
      detail: (assertion.failureMessages ?? []).join("\n"),
    }));
    const failedAssertion = tests.some(({ status }) => status === "failed");
    const fileFailure = result.status === "failed" && !failedAssertion
      ? String(result.message ?? "")
      : null;
    files.set(file, { tests, fileFailure });
  }
  return Object.freeze({ files, parseFailures: Object.freeze(parseFailures) });
}

// ---------------------------------------------------------------------------
// Evaluation (the union of every pass against the plan)
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {{ files: ReadonlyArray<{ file: string, profile: string }> }} input.plan
 * @param {ReadonlyArray<{ pass: string, runner: string, exitCode: number,
 *   files: Map<string, { tests: Array, fileFailure: string|null }>,
 *   parseFailures: ReadonlyArray<string> }>} input.records
 * @param {ReadonlyArray<{ code: "ENVIRONMENT_GAP", file: string, profile: string,
 *   detail: string }>} [input.environmentGaps] planned files of an explicit
 *   profile that could not run here. They are named, never counted as run,
 *   and leave the status "incomplete" (or "failed"), never "passed".
 */
export function evaluatePostgresSuite({ plan, records, environmentGaps = [] }) {
  const failures = [];
  const skipped = [];
  const passedByPass = { [PROFILE_SOCKET]: 0, [PROFILE_HOST]: 0, [PROFILE_EDGE_E2E]: 0 };
  let tests = 0;
  const planned = new Map(plan.files.map((entry) => [entry.file, entry]));
  const seen = new Map();
  const gaps = [];
  for (const gap of environmentGaps) {
    const entry = planned.get(gap?.file);
    if (gap?.code !== "ENVIRONMENT_GAP" || entry === undefined || entry.profile !== gap.profile
        || entry.profile === PROFILE_SOCKET || entry.profile === PROFILE_HOST) {
      // Only an explicit-profile spec may be reported as an environment gap.
      failures.push(failure("UNPLANNED_SPEC_RESULT", gap?.file ?? null, "environment gap for a routed spec"));
      continue;
    }
    gaps.push(Object.freeze({ code: gap.code, file: gap.file, profile: gap.profile, detail: String(gap.detail) }));
  }
  const gapFiles = new Set(gaps.map(({ file }) => file));
  for (const record of records) {
    const before = failures.length;
    for (const code of record.parseFailures ?? []) {
      failures.push(failure(code, record.file ?? null, null, { pass: record.pass, runner: record.runner }));
    }
    for (const [file, result] of record.files) {
      const entry = planned.get(file);
      if (entry === undefined) {
        failures.push(failure("UNPLANNED_SPEC_RESULT", file, null, { pass: record.pass }));
        continue;
      }
      seen.set(file, [...(seen.get(file) ?? []), record.pass]);
      if (entry.profile !== record.pass) {
        failures.push(failure("PROFILE_ROUTING_DRIFT", file,
          `ran in the ${record.pass} pass but routes ${entry.profile}`, { pass: record.pass }));
      }
      if (result.fileFailure !== null && result.fileFailure !== undefined) {
        failures.push(failure(classifyFailureDetail(result.fileFailure), file, null,
          { pass: record.pass, test: "(file)" }));
      }
      if (result.tests.length === 0) {
        failures.push(failure("EMPTY_SPEC_FILE", file, null, { pass: record.pass }));
      }
      for (const test of result.tests) {
        tests += 1;
        if (test.status === "passed") {
          passedByPass[record.pass] = (passedByPass[record.pass] ?? 0) + 1;
        } else if (test.status === "skipped" || test.status === "todo") {
          skipped.push(Object.freeze({ file, test: test.name, pass: record.pass }));
          failures.push(failure("SILENTLY_SKIPPED", file, null, { pass: record.pass, test: test.name }));
        } else {
          failures.push(failure(classifyFailureDetail(test.detail), file, null,
            { pass: record.pass, test: test.name }));
        }
      }
    }
    if (record.exitCode !== 0 && failures.length === before) {
      failures.push(failure("SUITE_PROCESS_FAILED", record.file ?? null,
        `exit ${record.exitCode}`, { pass: record.pass, runner: record.runner }));
    }
  }
  for (const [file] of planned) {
    const passes = seen.get(file) ?? [];
    if (gapFiles.has(file)) {
      if (passes.length > 0) failures.push(failure("PROFILE_ROUTING_DRIFT", file, "reported as run and as a gap"));
    } else if (passes.length === 0) {
      failures.push(failure("EMPTY_SPEC_FILE", file, "no results were reported"));
    } else if (passes.length > 1) {
      failures.push(failure("PROFILE_ROUTING_DRIFT", file, `reported by ${passes.length} runs`));
    }
  }
  return Object.freeze({
    status: failures.length > 0 ? "failed" : gaps.length > 0 ? "incomplete" : "passed",
    files: planned.size,
    tests,
    passedByPass: Object.freeze(passedByPass),
    skipped: Object.freeze(skipped),
    failures: Object.freeze(failures),
    environmentGaps: Object.freeze(gaps),
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The loopback TCP pair a SOCKET-profile cluster may also offer; both or neither. */
export const TCP_PROFILE_VARIABLES = Object.freeze(["PG_TEST_TCP_HOST", "PG_TEST_TCP_PORT"]);
const LOOPBACK_TCP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TCP_PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;

/**
 * Read the SOCKET profile the caller exported. Only PG_TEST_SOCKET,
 * PG_TEST_PORT and the optional loopback TCP pair (PG_TEST_TCP_HOST and
 * PG_TEST_TCP_PORT, set together: the same cluster's TCP listener, which the
 * fast-path cloud-target specs dial) are accepted: every other PG_TEST_*
 * variable (including PG_TEST_HOST and PG_TEST_PASSWORD) is refused so no pass
 * inherits it. Without the pair, a spec gated on it reports its TCP tests as
 * skipped (SILENTLY_SKIPPED), never as passed.
 */
export function readSocketProfileInput(environment) {
  const extra = Object.keys(environment)
    .filter((key) => key.startsWith("PG_TEST_") && key !== "PG_TEST_SOCKET" && key !== "PG_TEST_PORT"
      && !TCP_PROFILE_VARIABLES.includes(key))
    .sort();
  if (extra.length > 0) {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID",
      `unset ${extra.join(", ")}; the suite derives each pass profile from PG_TEST_SOCKET, PG_TEST_PORT `
        + "and the optional PG_TEST_TCP_HOST and PG_TEST_TCP_PORT pair");
  }
  const tcpHost = environment.PG_TEST_TCP_HOST;
  const tcpPort = environment.PG_TEST_TCP_PORT;
  if ((tcpHost === undefined) !== (tcpPort === undefined)) {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID", "set PG_TEST_TCP_HOST and PG_TEST_TCP_PORT together");
  }
  if (tcpHost !== undefined && (!LOOPBACK_TCP_HOSTS.has(tcpHost) || typeof tcpPort !== "string"
      || !TCP_PORT_PATTERN.test(tcpPort) || Number(tcpPort) > 65_535)) {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID",
      "PG_TEST_TCP_HOST must be a loopback host and PG_TEST_TCP_PORT a TCP port number");
  }
  const socket = environment.PG_TEST_SOCKET;
  if (typeof socket !== "string" || !SOCKET_DIRECTORY_PATTERN.test(socket)) {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID",
      "PG_TEST_SOCKET must name a /private/tmp/tibotattle-pg-*/socket directory");
  }
  const port = environment.PG_TEST_PORT;
  if (typeof port !== "string" || !TCP_PORT_PATTERN.test(port) || Number(port) > 65_535) {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID", "PG_TEST_PORT must be a TCP port number");
  }
  return Object.freeze(tcpHost === undefined ? { socket, port } : { socket, port, tcpHost, tcpPort });
}

/** One pass's PG_TEST_* profile; the loopback TCP pair reaches the SOCKET pass only. */
export function passEnvironment(baseEnvironment, pass, { socket, port, tcpHost, tcpPort }) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!key.startsWith("PG_TEST_") && value !== undefined) environment[key] = value;
  }
  if (pass === PROFILE_SOCKET) {
    environment.PG_TEST_SOCKET = socket;
    if (tcpHost !== undefined) {
      environment.PG_TEST_TCP_HOST = tcpHost;
      environment.PG_TEST_TCP_PORT = tcpPort;
    }
  } else if (pass === PROFILE_EDGE_E2E) {
    environment.PG_TEST_SOCKET = socket;
  } else if (pass === PROFILE_HOST) {
    environment.PG_TEST_HOST = socket;
  } else {
    throw new CiPostgresSuiteError("CI_SUITE_PROFILE_INVALID", `unknown pass ${pass}`);
  }
  environment.PG_TEST_PORT = port;
  return environment;
}

/** Forward only the tagged, closed S9 progress comments from the EDGE TAP stream. */
export function createEdgeS9TapProgressForwarder(emit = (value) => {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}) {
  let buffer = "";
  let dropping = false;
  let records = 0;
  let bytes = 0;
  const lastElapsed = new Map();
  const prefix = `# ${S9_TAP_PROGRESS_PREFIX}`;
  const accept = (line) => {
    if (!line.startsWith(prefix) || Buffer.byteLength(line) + 1 > 1_024) return;
    const encoded = line.slice(prefix.length);
    let parsed;
    try { parsed = JSON.parse(encoded); } catch { return; }
    const value = validateClosedS9Progress(parsed);
    if (value === null || JSON.stringify(value) !== encoded
        || value.elapsedMs < (lastElapsed.get(value.component) ?? 0)) return;
    const size = Buffer.byteLength(`${JSON.stringify(value)}\n`);
    if (records >= 1_024 || bytes + size > S9_DIAGNOSTIC_BYTES) return;
    records += 1;
    bytes += size;
    lastElapsed.set(value.component, value.elapsedMs);
    try { emit(value); } catch { /* Visibility cannot change the suite result. */ }
  };
  return (chunk) => {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk)) || Buffer.byteLength(chunk) > 64 * 1024) {
      buffer = "";
      dropping = true;
      return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    for (const part of text.split(/(?<=\n)/u)) {
      if (dropping) {
        if (part.endsWith("\n")) dropping = false;
        continue;
      }
      if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > 1_024) {
        buffer = "";
        dropping = !part.endsWith("\n");
        continue;
      }
      buffer += part;
      if (buffer.endsWith("\n")) {
        accept(buffer.slice(0, -1));
        buffer = "";
      }
    }
  };
}

function spawnProcess(command, args, { cwd, env, captureStdout, onStdoutChunk }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      // Child diagnostics go to stderr so stdout carries only the summary.
      stdio: ["ignore", captureStdout ? "pipe" : 2, 2],
    });
    const chunks = [];
    child.stdout?.on("data", (chunk) => {
      chunks.push(chunk);
      if (typeof onStdoutChunk === "function") {
        try { onStdoutChunk(chunk); } catch { /* Streaming diagnostics cannot change the child outcome. */ }
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

function reportFailingOutput({ file, text, result }) {
  const failing = result.tests.some(({ status }) => status !== "passed") || result.fileFailure;
  if (failing) process.stderr.write(`\n--- ${file} ---\n${text}\n`);
}

/**
 * The EDGE_E2E runtime, or the named reasons it is unavailable here: the
 * image's Node (EDGE_E2E_NODE, an absolute path reporting v22.16.0), workerd
 * installed for this Worker, and the golden the S9 stage reads
 * (EDGE_E2E_GOLDEN, an absolute path). Probing runs only `<node> --version`.
 */
export async function probeEdgeE2eEnvironment({ workerRoot, environment, run }) {
  const reasons = [];
  const node = environment[EDGE_E2E_NODE_VARIABLE];
  if (typeof node !== "string" || !node.startsWith("/")) {
    reasons.push(`${EDGE_E2E_NODE_VARIABLE} must name the Node ${EDGE_E2E_NODE_VERSION} binary (the image runtime)`);
  } else {
    let version = null;
    try {
      const probe = await run(node, ["--version"], { cwd: workerRoot, env: {}, captureStdout: true });
      version = probe.exitCode === 0 ? probe.stdout.trim() : null;
    } catch {
      version = null;
    }
    if (version !== EDGE_E2E_NODE_VERSION) {
      reasons.push(`${EDGE_E2E_NODE_VARIABLE} does not report ${EDGE_E2E_NODE_VERSION}`);
    }
  }
  if (!await exists(join(workerRoot, "node_modules", "workerd", "package.json"))) {
    reasons.push("workerd is not installed in the Worker's node_modules");
  }
  const golden = environment[EDGE_E2E_GOLDEN_VARIABLE];
  if (typeof golden !== "string" || !golden.startsWith("/")) {
    reasons.push(`${EDGE_E2E_GOLDEN_VARIABLE} is unset, so the S9 golden read would skip`);
  }
  return reasons.length === 0
    ? Object.freeze({ available: true, node })
    : Object.freeze({ available: false, reasons: Object.freeze(reasons) });
}

export async function runPostgresSuite({
  workerRoot = WORKER_ROOT,
  environment = process.env,
  run = spawnProcess,
  onOutput = reportFailingOutput,
  plan: suppliedPlan = null,
  probeEdgeE2e = probeEdgeE2eEnvironment,
  partition = null,
  onRecords = () => {},
  onExecutionInputs = async () => {},
  onProgress = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  onS9Progress = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  now = () => Date.now(),
} = {}) {
  const profile = readSocketProfileInput(environment);
  const canonicalPlan = suppliedPlan ?? await planPostgresSuite({ workerRoot });
  const plan = partition === null ? canonicalPlan : partitionPostgresPlan(canonicalPlan, partition);
  if (plan.failures.length > 0) {
    onRecords({ plan, records: [], environmentGaps: [] });
    return Object.freeze({
      status: "failed",
      files: plan.files.length,
      tests: 0,
      passedByPass: Object.freeze({ [PROFILE_SOCKET]: 0, [PROFILE_HOST]: 0, [PROFILE_EDGE_E2E]: 0 }),
      skipped: Object.freeze([]),
      failures: plan.failures,
      environmentGaps: Object.freeze([]),
    });
  }
  const records = [];
  const environmentGaps = [];
  const started = now();
  const progress = (phase, pass, runner, files) => onProgress(Object.freeze({
    event: "postgres-suite-progress", phase, profile: pass, runner,
    files: Object.freeze(files), elapsedMs: Math.max(0, now() - started),
  }));
  const reportDirectory = await mkdtemp(join(tmpdir(), "tibotattle-pg-suite-"));
  try {
    const socketEnvironment = passEnvironment(environment, PROFILE_SOCKET, profile);
    for (const config of VITEST_REGISTRATION_CONFIGS) {
      const planned = plan.files.filter(({ runner }) => runner === `vitest:${config}`);
      if (planned.length === 0) continue;
      const outputFile = join(reportDirectory, `${config}.json`);
      await onExecutionInputs();
      progress("started", PROFILE_SOCKET, `vitest:${config}`, planned.map(({ file }) => file));
      const { exitCode } = await run(process.execPath, [
        join(workerRoot, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        config,
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ], { cwd: workerRoot, env: socketEnvironment, captureStdout: false });
      let report = null;
      try {
        report = JSON.parse(await readFile(outputFile, "utf8"));
      } catch {
        report = null;
      }
      const parsed = parseVitestReport(report, { workerRoot });
      progress("completed", PROFILE_SOCKET, `vitest:${config}`, planned.map(({ file }) => file));
      for (const [file, result] of parsed.files) {
        if (result.tests.some(({ status }) => status !== "passed") || result.fileFailure) {
          const details = result.tests.filter(({ status }) => status === "failed")
            .map(({ name, detail }) => `${name}\n${detail}`);
          if (result.fileFailure) details.push(result.fileFailure);
          onOutput({ file, text: details.join("\n"), result });
        }
      }
      records.push({
        pass: PROFILE_SOCKET,
        runner: `vitest:${config}`,
        file: null,
        exitCode,
        files: parsed.files,
        parseFailures: parsed.parseFailures,
      });
    }
    for (const pass of [PROFILE_SOCKET, PROFILE_HOST]) {
      const passEnv = passEnvironment(environment, pass, profile);
      for (const entry of plan.files) {
        if (entry.runner !== NODE_RUNNER || entry.profile !== pass) continue;
        const absoluteFile = join(workerRoot, entry.file);
        await onExecutionInputs();
        progress("started", pass, NODE_RUNNER, [entry.file]);
        const { exitCode, stdout } = await run(process.execPath, [
          "--test",
          "--test-concurrency=1",
          "--test-reporter=tap",
          `./${entry.file}`,
        ], { cwd: workerRoot, env: passEnv, captureStdout: true });
        const parsed = parseNodeTap(stdout, { absoluteFile, cwd: workerRoot });
        progress("completed", pass, NODE_RUNNER, [entry.file]);
        onOutput({ file: entry.file, text: stdout, result: parsed });
        records.push({
          pass,
          runner: NODE_RUNNER,
          file: entry.file,
          exitCode,
          files: new Map([[entry.file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
          parseFailures: parsed.parseFailures,
          cancelled: parsed.cancelled,
        });
      }
    }
    // Explicit profiles run last, through their registration script's steps.
    const explicit = plan.files.filter(({ profile: pass }) => pass === PROFILE_EDGE_E2E);
    const runtime = explicit.length === 0 ? null
      : await probeEdgeE2e({ workerRoot, environment, run });
    const prepared = new Set();
    for (const entry of explicit) {
      if (!runtime.available) {
        environmentGaps.push({
          code: "ENVIRONMENT_GAP",
          file: entry.file,
          profile: entry.profile,
          detail: runtime.reasons.join("; "),
        });
        continue;
      }
      const passEnv = passEnvironment(environment, PROFILE_EDGE_E2E, profile);
      let prerequisiteFailed = false;
      for (const command of entry.prerequisites ?? []) {
        if (prepared.has(command)) continue;
        const { exitCode } = await run(runtime.node, command.split(" ").slice(1),
          { cwd: workerRoot, env: passEnv, captureStdout: false });
        if (exitCode !== 0) {
          prerequisiteFailed = true;
          records.push({
            pass: PROFILE_EDGE_E2E,
            runner: entry.runner,
            file: entry.file,
            exitCode,
            files: new Map(),
            parseFailures: ["PREREQUISITE_FAILED"],
          });
          break;
        }
        prepared.add(command);
      }
      if (prerequisiteFailed) continue;
      const absoluteFile = join(workerRoot, entry.file);
      await onExecutionInputs();
      progress("started", PROFILE_EDGE_E2E, entry.runner, [entry.file]);
      const registeredD7EdgeSpec = entry.file === EDGE_PARTITION_FILES[0]
        && entry.profile === PROFILE_EDGE_E2E
        && entry.source === "edge:e2e"
        && entry.runner === scriptRunner("edge:e2e")
        && SCRIPT_PROFILES[entry.source] === entry.profile;
      const { exitCode, stdout } = await run(runtime.node, [
        ...EDGE_E2E_NODE_FLAGS,
        "--test",
        ...(entry.testFlags ?? []).filter((flag) => !flag.startsWith("--test-reporter")),
        "--test-reporter=tap",
        `./${entry.file}`,
      ], { cwd: workerRoot, env: passEnv, captureStdout: true,
        ...(registeredD7EdgeSpec
          ? { onStdoutChunk: createEdgeS9TapProgressForwarder(onS9Progress) }
          : {}) });
      const expectedTestCount = registeredD7EdgeSpec
        && environment[EDGE_E2E_S9_MODE_VARIABLE] === CURRENT_D7_S9_MODE
        ? CURRENT_D7_EDGE_E2E_TEST_COUNT
        : undefined;
      const parsed = parseNodeTap(stdout, { absoluteFile, cwd: workerRoot, expectedTestCount });
      progress("completed", PROFILE_EDGE_E2E, entry.runner, [entry.file]);
      onOutput({ file: entry.file, text: stdout, result: parsed });
      records.push({
        pass: PROFILE_EDGE_E2E,
        runner: entry.runner,
        file: entry.file,
        exitCode,
        files: new Map([[entry.file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
        parseFailures: parsed.parseFailures,
        cancelled: parsed.cancelled,
      });
    }
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
  onRecords({ plan, records, environmentGaps });
  return evaluatePostgresSuite({ plan, records, environmentGaps });
}

// Closed scheduling partitions; the default runner still executes the whole plan.
export function partitionPostgresPlan(plan, partition) {
  if (!PARTITIONS.includes(partition)) throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "unknown partition");
  const invalid = plan.files.some(({ profile, runner, source }) =>
    ![PROFILE_SOCKET, PROFILE_HOST, PROFILE_EDGE_E2E].includes(profile)
    || profile === PROFILE_EDGE_E2E && (SCRIPT_PROFILES[source] !== profile || runner !== scriptRunner(source)));
  if (invalid) throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "canonical profile ownership drift");
  const edgeFiles = plan.files.filter(({ profile }) => profile === PROFILE_EDGE_E2E);
  if (partition === "EDGE_E2E") {
    if (edgeFiles.length === 0) throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "empty partition");
    if (JSON.stringify(edgeFiles.map(({ file }) => file).sort())
        !== JSON.stringify([...EDGE_PARTITION_FILES].sort())) {
      throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "canonical EDGE partition ownership drift");
    }
    return Object.freeze({ ...plan, files: Object.freeze(edgeFiles) });
  }

  const coreFiles = plan.files.filter(({ profile }) => profile === PROFILE_SOCKET || profile === PROFILE_HOST);
  const assignedFiles = CORE_PARTITIONS.flatMap((name) => CORE_PARTITION_FILES[name]);
  const assigned = new Set(assignedFiles);
  if (assigned.size !== assignedFiles.length
      || JSON.stringify([...assigned].sort()) !== JSON.stringify(coreFiles.map(({ file }) => file).sort())) {
    throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "canonical CORE shard ownership drift");
  }
  const owners = new Map(CORE_PARTITIONS.flatMap((name) => CORE_PARTITION_FILES[name].map((file) => [file, name])));
  for (const config of VITEST_REGISTRATION_CONFIGS) {
    const groupOwners = new Set(coreFiles.filter(({ runner }) => runner === `vitest:${config}`)
      .map(({ file }) => owners.get(file)));
    if (groupOwners.size > 1) {
      throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "Vitest config group split across CORE shards");
    }
  }
  const ownedFiles = new Set(CORE_PARTITION_FILES[partition]);
  const files = coreFiles.filter(({ file }) => ownedFiles.has(file));
  if (files.length === 0) throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "empty partition");
  if (files.length !== ownedFiles.size) throw new CiPostgresSuiteError("CI_SUITE_PARTITION_INVALID", "CORE shard manifest has missing files");
  return Object.freeze({ ...plan, files: Object.freeze(files) });
}

export function parseSuiteArguments(argv) {
  const options = { plan: false, partition: null, receipt: null, aggregate: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" && !options.plan) options.plan = true;
    else if (argument === "--partition" && options.partition === null && PARTITIONS.includes(argv[index + 1])) {
      options.partition = argv[++index];
    } else if (argument === "--receipt" && options.receipt === null && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options.receipt = argv[++index];
    } else if (argument === "--aggregate" && options.aggregate === null && argv.length === index + 1 + PARTITIONS.length
        && argv.slice(index + 1).every((value) => value && !value.startsWith("--"))) {
      options.aggregate = argv.slice(index + 1); index += PARTITIONS.length;
    } else throw new CiPostgresSuiteError("CI_SUITE_USAGE", "unsupported or duplicate argument");
  }
  if (options.aggregate !== null && (options.plan || options.partition !== null || options.receipt !== null)
      || options.receipt !== null && (options.partition === null || options.plan)) {
    throw new CiPostgresSuiteError("CI_SUITE_USAGE", "incompatible modes");
  }
  return Object.freeze(options);
}

const RECEIPT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_HEAD = /^[a-f0-9]{40}$/u;
const PROVIDER_NUMBER = /^[1-9][0-9]{0,19}$/u;
const MAX_TESTS_PER_FILE = 100_000;
const RECEIPT_PARSE_FAILURES = new Set(["TAP_INCOMPLETE", "TAP_PARSE_MISMATCH", "TAP_TEST_COUNT_MISMATCH", "VITEST_REPORT_INVALID", "PREREQUISITE_FAILED"]);
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Bind the canonical plan and execution-owning inputs, without recording file contents. */
export async function postgresPlanDigest(plan, { workerRoot = WORKER_ROOT } = {}) {
  const sources = [...new Set(["package.json", ...VITEST_REGISTRATION_CONFIGS,
    "scripts/ci-postgres-suite.mjs", ...plan.files.map(({ file }) => file)])].sort();
  const sourceDigests = [];
  for (const file of sources) sourceDigests.push([file, sha256(await readFile(join(workerRoot, file)))]);
  return sha256(JSON.stringify({ files: plan.files, hostProfileFiles: plan.hostProfileFiles,
    failures: plan.failures, sourceDigests }));
}

function validContext(context) {
  return exactKeys(context, ["sourceHead", "planDigest", "runId", "runAttempt", "toolchainNode", "imageNode"])
    && Object.values(context).every((value) => typeof value === "string")
    && GIT_HEAD.test(context.sourceHead) && SHA256.test(context.planDigest)
    && PROVIDER_NUMBER.test(context.runId) && PROVIDER_NUMBER.test(context.runAttempt)
    && context.toolchainNode === TOOLCHAIN_NODE_VERSION && context.imageNode === EDGE_E2E_NODE_VERSION;
}

/** Derive generated output ownership from the existing build's declared outputs. */
export async function postgresBuildOwnership({ workerRoot = WORKER_ROOT } = {}) {
  const source = await readFile(join(workerRoot, "cloud-run", "build.mjs"));
  const declarations = [...source.toString("utf8").matchAll(/\boutputs:\s*(\[[^\]]+\])/gu)];
  let paths;
  try { paths = declarations.length === 1 ? JSON.parse(declarations[0][1]) : null; } catch { paths = null; }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100
      || paths.some((path) => typeof path !== "string" || !/^dist\/[a-z0-9-]+\.mjs$/u.test(path))
      || new Set(paths).size !== paths.length) {
    throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "canonical build output declaration is invalid");
  }
  return Object.freeze({ buildSourceSha256: sha256(source), paths: Object.freeze(paths.sort()) });
}

export async function postgresExecutionInputs({ workerRoot = WORKER_ROOT, builderNode } = {}) {
  if (![TOOLCHAIN_NODE_VERSION, EDGE_E2E_NODE_VERSION].includes(builderNode)) {
    throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "unknown builder runtime");
  }
  const ownership = await postgresBuildOwnership({ workerRoot });
  const directory = join(workerRoot, "cloud-run", "dist");
  const names = (await readdir(directory)).map((name) => `dist/${name}`).sort();
  if (JSON.stringify(names) !== JSON.stringify(ownership.paths)) {
    throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "generated output inventory differs from the canonical build");
  }
  const bundles = [];
  for (const path of ownership.paths) {
    const file = join(workerRoot, "cloud-run", path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024 || stat.size === 0) {
      throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "generated bundle is unsafe or empty");
    }
    const bytes = await readFile(file);
    if (bytes.length !== stat.size) throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "generated bundle changed during binding");
    bundles.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  return Object.freeze({ buildSourceSha256: ownership.buildSourceSha256, builderNode, bundles });
}

function validExecutionInputs(inputs, { partition, ownership }) {
  return exactKeys(inputs, ["buildSourceSha256", "builderNode", "bundles"])
    && inputs.buildSourceSha256 === ownership.buildSourceSha256
    && inputs.builderNode === (partition === "EDGE_E2E" ? EDGE_E2E_NODE_VERSION : TOOLCHAIN_NODE_VERSION)
    && Array.isArray(inputs.bundles)
    && JSON.stringify(inputs.bundles.map((entry) => entry?.path)) === JSON.stringify(ownership.paths)
    && inputs.bundles.every((entry) => exactKeys(entry, ["path", "sha256", "bytes"])
      && SHA256.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 32 * 1024 * 1024);
}

function sameExecutionInputs(left, right) {
  return left.buildSourceSha256 === right.buildSourceSha256
    && left.builderNode === right.builderNode
    && left.bundles.length === right.bundles.length
    && left.bundles.every((bundle, index) => bundle.path === right.bundles[index].path
      && bundle.sha256 === right.bundles[index].sha256
      && bundle.bytes === right.bundles[index].bytes);
}

export function assertCleanPostgresCheckout({ workerRoot = WORKER_ROOT, git = execFileSync, environment = process.env } = {}) {
  const root = git("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"],
    { cwd: workerRoot, encoding: "utf8", env: { ...environment, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } }).trim();
  const options = { cwd: root, stdio: "ignore", env: { ...environment, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } };
  try {
    git("git", ["--no-optional-locks", "diff", "--quiet", "HEAD", "--"], options);
    git("git", ["--no-optional-locks", "diff", "--cached", "--quiet", "--"], options);
  } catch {
    throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_CONTEXT_INVALID", "tracked source or index differs from the selected revision");
  }
}

export async function receiptContext({ plan, workerRoot = WORKER_ROOT, environment = process.env, probeImage = false, probe = spawnProcess }) {
  assertCleanPostgresCheckout({ workerRoot, environment });
  const sourceHead = execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"],
    { cwd: workerRoot, encoding: "utf8", env: { ...environment, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } }).trim();
  const expected = environment.CI_POSTGRES_EXPECTED_HEAD;
  const context = { sourceHead, planDigest: await postgresPlanDigest(plan, { workerRoot }),
    runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT,
    toolchainNode: process.version, imageNode: EDGE_E2E_NODE_VERSION };
  if (!validContext(context) || !GIT_HEAD.test(expected ?? "") || expected !== sourceHead) {
    throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_CONTEXT_INVALID", "checkout, expected revision, provider run or toolchain binding is invalid");
  }
  if (probeImage) {
    const node = environment[EDGE_E2E_NODE_VARIABLE];
    if (typeof node !== "string" || !node.startsWith("/")) {
      throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_CONTEXT_INVALID", "image runtime is unnamed");
    }
    const result = await probe(node, ["--version"], { cwd: workerRoot, env: {}, captureStdout: true });
    if (result.exitCode !== 0 || result.stdout.trim() !== EDGE_E2E_NODE_VERSION) {
      throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_CONTEXT_INVALID", "image runtime version differs");
    }
  }
  return Object.freeze(context);
}

/** Content-free records preserve every evaluator input that can refuse a pass. */
export function createPostgresReceipt({ plan, context, partition, execution, executionInputs }) {
  if (!validContext(context) || execution === null) throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_INVALID", "missing execution binding");
  const selected = partitionPostgresPlan(plan, partition);
  const records = execution.records.map((record) => ({
    profile: record.pass, runner: record.runner, file: record.file,
    exitCode: record.exitCode, cancelled: record.cancelled ?? 0,
    parseFailures: [...record.parseFailures],
    files: [...record.files].map(([file, result]) => ({ file,
      fileFailed: result.fileFailure !== null && result.fileFailure !== undefined,
      fileEnvironmentFailure: result.fileFailure != null && classifyFailureDetail(result.fileFailure) === "ENV_PROFILE_CONFLICT",
      passed: result.tests.filter(({ status }) => status === "passed").length,
      failed: result.tests.filter(({ status }) => !["passed", "skipped", "todo"].includes(status)).length,
      environmentFailed: result.tests.filter(({ status, detail }) => !["passed", "skipped", "todo"].includes(status)
        && classifyFailureDetail(detail) === "ENV_PROFILE_CONFLICT").length,
      skipped: result.tests.filter(({ status }) => status === "skipped").length,
      todo: result.tests.filter(({ status }) => status === "todo").length,
    })),
  }));
  return Object.freeze({ version: RECEIPT_VERSION, scope: "partition", partition, ...context,
    executionInputs,
    inventory: selected.files.map(({ file, profile, runner }) => ({ file, profile, runner })), records,
    environmentGaps: execution.environmentGaps.map(({ code, file, profile }) => ({ code, file, profile })),
    planFailureCodes: plan.failures.map(({ code }) => code),
  });
}

/** Recompute the full plan, refuse incomplete producers, then reuse the canonical evaluator. */
export function aggregatePostgresReceipts({ plan, context, receipts, jobResults, ownership }) {
  const refuse = (code) => Object.freeze({ status: "failed", scope: "complete", files: plan.files.length,
    tests: 0, passedByPass: { SOCKET: 0, HOST: 0, EDGE_E2E: 0 }, skipped: [], environmentGaps: [],
    failures: [{ code, file: null }] });
  if (!validContext(context) || plan.failures.length > 0) return refuse("AGGREGATE_CONTEXT_INVALID");
  if (!exactKeys(jobResults, PARTITIONS) || PARTITIONS.some((name) => jobResults[name] !== "success")) return refuse("PARTITION_JOB_FAILED");
  if (!Array.isArray(receipts) || receipts.length !== PARTITIONS.length) return refuse("PARTITION_SET_INVALID");
  const records = [];
  const seenPartitions = new Set();
  const planned = new Map(plan.files.map((entry) => [entry.file, entry]));
  const seenFiles = new Set();
  const seenGroups = new Set();
  let coreExecutionInputs = null;
  for (const receipt of receipts) {
    if (!exactKeys(receipt, ["version", "scope", "partition", ...Object.keys(context), "inventory", "records", "environmentGaps", "planFailureCodes", "executionInputs"])
        || receipt.version !== RECEIPT_VERSION || receipt.scope !== "partition" || !PARTITIONS.includes(receipt.partition)
        || seenPartitions.has(receipt.partition) || Object.keys(context).some((key) => receipt[key] !== context[key])) {
      return refuse("PARTITION_PROVENANCE_INVALID");
    }
    if (!validExecutionInputs(receipt.executionInputs, { partition: receipt.partition, ownership })) return refuse("PARTITION_BUILD_INPUT_INVALID");
    if (receipt.partition !== "EDGE_E2E") {
      if (coreExecutionInputs === null) coreExecutionInputs = receipt.executionInputs;
      else if (!sameExecutionInputs(coreExecutionInputs, receipt.executionInputs)) return refuse("CORE_BUILD_INPUT_MISMATCH");
    }
    seenPartitions.add(receipt.partition);
    const selected = partitionPostgresPlan(plan, receipt.partition).files.map(({ file, profile, runner }) => ({ file, profile, runner }));
    if (JSON.stringify(receipt.inventory) !== JSON.stringify(selected)
        || !Array.isArray(receipt.records) || receipt.records.length > selected.length + VITEST_REGISTRATION_CONFIGS.length
        || !Array.isArray(receipt.environmentGaps) || receipt.environmentGaps.length !== 0
        || !Array.isArray(receipt.planFailureCodes) || receipt.planFailureCodes.length !== 0) return refuse("PARTITION_COVERAGE_INVALID");
    const owned = new Set(selected.map(({ file }) => file));
    for (const record of receipt.records) {
      if (!exactKeys(record, ["profile", "runner", "file", "exitCode", "cancelled", "parseFailures", "files"])
          || !Number.isInteger(record.exitCode) || record.exitCode < 0 || record.exitCode > 255
          || !Number.isSafeInteger(record.cancelled) || record.cancelled !== 0
          || !Array.isArray(record.parseFailures) || record.parseFailures.some((code) => !RECEIPT_PARSE_FAILURES.has(code))
          || typeof record.profile !== "string" || typeof record.runner !== "string"
          || record.file !== null && typeof record.file !== "string"
          || (record.file === null) !== record.runner.startsWith("vitest:")
          || !Array.isArray(record.files) || record.files.length > selected.length
          || record.file !== null && !owned.has(record.file)) return refuse("PARTITION_RECORD_INVALID");
      const group = `${record.profile}\0${record.runner}\0${record.file ?? ""}`;
      const expectedFiles = selected.filter((entry) => entry.profile === record.profile && entry.runner === record.runner
        && (record.file === null ? record.runner.startsWith("vitest:") : entry.file === record.file))
        .map(({ file }) => file).sort();
      if (seenGroups.has(group) || expectedFiles.length === 0
          || JSON.stringify(record.files.map(({ file }) => file).sort()) !== JSON.stringify(expectedFiles)) {
        return refuse("PARTITION_RECORD_INVALID");
      }
      seenGroups.add(group);
      const files = new Map();
      for (const result of record.files) {
        const entry = planned.get(result?.file);
        if (!exactKeys(result, ["file", "fileFailed", "fileEnvironmentFailure", "passed", "failed", "environmentFailed", "skipped", "todo"])
            || !owned.has(result.file) || seenFiles.has(result.file) || entry.profile !== record.profile || entry.runner !== record.runner
            || typeof result.fileFailed !== "boolean" || typeof result.fileEnvironmentFailure !== "boolean"
            || result.fileEnvironmentFailure && !result.fileFailed
            || ["passed", "failed", "environmentFailed", "skipped", "todo"].some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > MAX_TESTS_PER_FILE)
            || result.environmentFailed > result.failed
            || result.passed + result.failed + result.skipped + result.todo > MAX_TESTS_PER_FILE) return refuse("PARTITION_RECORD_INVALID");
        seenFiles.add(result.file);
        const tests = [];
        for (const status of ["passed", "failed", "skipped", "todo"]) {
          for (let index = 0; index < result[status]; index += 1) tests.push({ name: `${status}-${index + 1}`, status,
            detail: status === "failed" && index < result.environmentFailed ? "PG_TEST_SOCKET" : "" });
        }
        files.set(result.file, { tests, fileFailure: result.fileFailed ? result.fileEnvironmentFailure ? "PG_TEST_SOCKET" : "failed" : null });
      }
      records.push({ pass: record.profile, runner: record.runner, file: record.file,
        exitCode: record.exitCode, parseFailures: record.parseFailures, files });
    }
  }
  if (seenPartitions.size !== PARTITIONS.length || seenFiles.size !== planned.size) return refuse("PARTITION_COVERAGE_INVALID");
  return Object.freeze({ ...evaluatePostgresSuite({ plan, records }), scope: "complete", sourceHead: context.sourceHead,
    planDigest: context.planDigest, runId: context.runId, runAttempt: context.runAttempt });
}

function printFailures(failures) {
  for (const entry of failures) {
    const parts = [entry.code, entry.file ?? "-"];
    if (entry.pass) parts.push(`[${entry.pass}]`);
    if (entry.test) parts.push(JSON.stringify(entry.test));
    if (entry.detail) parts.push(`(${entry.detail})`);
    process.stderr.write(`${parts.join(" ")}\n`);
  }
}

export async function main(argv, {
  loadPlan = planPostgresSuite, readContext = receiptContext, execute = runPostgresSuite,
  loadOwnership = postgresBuildOwnership, bindInputs = postgresExecutionInputs,
  writeSummary = (summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`),
  setExitCode = (code) => { process.exitCode = code; }, environment = process.env,
} = {}) {
  const options = parseSuiteArguments(argv);
  if (options.aggregate !== null) {
    const plan = await loadPlan();
    const context = await readContext({ plan, environment });
    const receipts = await Promise.all(options.aggregate.map(async (path) => {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) {
        throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_INVALID", "receipt must be a bounded regular file");
      }
      return JSON.parse(await readFile(path, "utf8"));
    }));
    const summary = aggregatePostgresReceipts({ plan, context, receipts,
      jobResults: Object.fromEntries(PARTITIONS.map((partition) => [partition, environment[`CI_POSTGRES_${partition}_RESULT`]])),
      ownership: await loadOwnership() });
    writeSummary(summary);
    if (summary.status !== "passed") setExitCode(1);
    return;
  }
  if (options.plan) {
    const canonical = await loadPlan();
    const plan = options.partition === null ? canonical : partitionPostgresPlan(canonical, options.partition);
    writeSummary({
      status: plan.failures.length === 0 ? "planned" : "failed",
      ...(options.partition === null ? {} : { scope: "partition", partition: options.partition }),
      files: plan.files.map(({ file, runner, profile }) => ({ file, runner, profile })),
      hostProfileFiles: plan.hostProfileFiles,
      explicitProfileFiles: plan.files.filter(({ profile }) => profile === PROFILE_EDGE_E2E)
        .map(({ file, runner, profile }) => ({ file, runner, profile })),
      unregisteredAllowlist: UNREGISTERED_ALLOWLIST,
      failures: plan.failures,
    });
    if (plan.failures.length > 0) { printFailures(plan.failures); setExitCode(1); }
    return;
  }
  const plan = await loadPlan();
  const context = options.receipt === null ? null : await readContext({ plan, environment, probeImage: true });
  let execution = null;
  let executionInputs = null;
  const builderNode = options.partition === "EDGE_E2E" ? EDGE_E2E_NODE_VERSION : TOOLCHAIN_NODE_VERSION;
  const summary = await execute({ plan, partition: options.partition, environment,
    onRecords: (value) => { execution = value; },
    onExecutionInputs: async () => {
      if (options.receipt !== null && executionInputs === null) executionInputs = await bindInputs({ builderNode });
    } });
  if (options.receipt !== null) {
    const finalPlan = await loadPlan();
    const finalContext = await readContext({ plan: finalPlan, environment, probeImage: true });
    if (JSON.stringify(finalContext) !== JSON.stringify(context)) {
      throw new CiPostgresSuiteError("CI_SUITE_RECEIPT_CONTEXT_INVALID", "source or runtime changed during execution");
    }
    if (executionInputs === null || JSON.stringify(await bindInputs({ builderNode })) !== JSON.stringify(executionInputs)) {
      throw new CiPostgresSuiteError("CI_SUITE_BUILD_INPUT_INVALID", "generated execution inputs are absent or changed");
    }
    const receipt = createPostgresReceipt({ plan, context, partition: options.partition, execution, executionInputs });
    await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  writeSummary(options.partition === null ? summary : { ...summary, scope: "partition", partition: options.partition });
  if (summary.status !== "passed") {
    printFailures(summary.failures); printFailures(summary.environmentGaps); setExitCode(1);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof CiPostgresSuiteError ? error.code : "CI_SUITE_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code, message: error instanceof CiPostgresSuiteError ? error.message : String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
