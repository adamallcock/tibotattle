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
 * EXTRA_REGISTRATION_SCRIPTS (`edge:e2e`, `postgres:production-migrations:check`,
 * `gcp:load-test:local`).
 * UNREGISTERED_ALLOWLIST names the specs registered in none of them; it may
 * only shrink.
 *
 * A spec registered by a script in SCRIPT_PROFILES runs in that explicit
 * profile through the script's own steps instead of a SOCKET or HOST pass.
 * EDGE_E2E (`edge:e2e`, postgres-test/edge-origin-e2e.spec.mjs, and
 * `gcp:load-test:local`, postgres-test/gcp-load-test.spec.mjs, which drives the
 * OPS-11 load generator through the same local edge and origin) needs the
 * cloud-run build, workerd and the image runtime (Node 22.16.0, named by
 * EDGE_E2E_NODE), and the edge spec's S9 stage reads the golden named by
 * EDGE_E2E_GOLDEN. Without them each spec is reported as a named
 * ENVIRONMENT_GAP and the run is "incomplete", never green and never a silent
 * skip. The shared build prerequisite runs once per suite run.
 *
 * Failure codes (one entry per file and test, never payloads):
 *   FAILED, ENV_PROFILE_CONFLICT, SILENTLY_SKIPPED, EMPTY_SPEC_FILE,
 *   UNREGISTERED_POSTGRES_SPEC, ALLOWLIST_STALE, REGISTERED_SPEC_MISSING,
 *   REGISTRATION_DUPLICATE, REGISTRATION_PARSE_FAILED,
 *   PROFILE_ROUTING_AMBIGUOUS, PROFILE_ROUTING_DRIFT, UNPLANNED_SPEC_RESULT,
 *   SUITE_PROCESS_FAILED, PREREQUISITE_FAILED, TAP_INCOMPLETE,
 *   TAP_PARSE_MISMATCH, VITEST_REPORT_INVALID.
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
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * package.json scripts beyond postgres:domain:check whose ./postgres-test/
 * specs count as registered. Frozen: a new entry is a reviewed change here.
 */
export const EXTRA_REGISTRATION_SCRIPTS = Object.freeze([
  "edge:e2e",
  "postgres:production-migrations:check",
  "gcp:load-test:local",
]);

/**
 * Registration scripts whose specs run in an explicit profile, through the
 * script's own steps, rather than in the SOCKET or HOST pass.
 */
export const SCRIPT_PROFILES = Object.freeze({
  "edge:e2e": PROFILE_EDGE_E2E,
  "gcp:load-test:local": PROFILE_EDGE_E2E,
});

/** The only steps an extra registration script may run before its specs. */
export const EXTRA_SCRIPT_PREREQUISITES = Object.freeze([
  "node ./cloud-run/build.mjs",
]);

/** The EDGE_E2E profile's runtime: the image's Node, named by EDGE_E2E_NODE. */
export const EDGE_E2E_NODE_VERSION = "v22.16.0";
export const EDGE_E2E_NODE_VARIABLE = "EDGE_E2E_NODE";
export const EDGE_E2E_GOLDEN_VARIABLE = "EDGE_E2E_GOLDEN";

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
export function parseNodeTap(text, { absoluteFile, cwd }) {
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
  return Object.freeze({
    tests: Object.freeze(tests),
    fileFailure,
    parseFailures: Object.freeze(parseFailures),
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

function spawnProcess(command, args, { cwd, env, captureStdout }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      // Child diagnostics go to stderr so stdout carries only the summary.
      stdio: ["ignore", captureStdout ? "pipe" : 2, 2],
    });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
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
} = {}) {
  const profile = readSocketProfileInput(environment);
  const plan = suppliedPlan ?? await planPostgresSuite({ workerRoot });
  if (plan.failures.length > 0) {
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
  const reportDirectory = await mkdtemp(join(tmpdir(), "tibotattle-pg-suite-"));
  try {
    const socketEnvironment = passEnvironment(environment, PROFILE_SOCKET, profile);
    for (const config of VITEST_REGISTRATION_CONFIGS) {
      const planned = plan.files.filter(({ runner }) => runner === `vitest:${config}`);
      if (planned.length === 0) continue;
      const outputFile = join(reportDirectory, `${config}.json`);
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
        const { exitCode, stdout } = await run(process.execPath, [
          "--test",
          "--test-concurrency=1",
          "--test-reporter=tap",
          `./${entry.file}`,
        ], { cwd: workerRoot, env: passEnv, captureStdout: true });
        const parsed = parseNodeTap(stdout, { absoluteFile, cwd: workerRoot });
        onOutput({ file: entry.file, text: stdout, result: parsed });
        records.push({
          pass,
          runner: NODE_RUNNER,
          file: entry.file,
          exitCode,
          files: new Map([[entry.file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
          parseFailures: parsed.parseFailures,
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
      const { exitCode, stdout } = await run(runtime.node, [
        "--test",
        ...(entry.testFlags ?? []).filter((flag) => !flag.startsWith("--test-reporter")),
        "--test-reporter=tap",
        `./${entry.file}`,
      ], { cwd: workerRoot, env: passEnv, captureStdout: true });
      const parsed = parseNodeTap(stdout, { absoluteFile, cwd: workerRoot });
      onOutput({ file: entry.file, text: stdout, result: parsed });
      records.push({
        pass: PROFILE_EDGE_E2E,
        runner: entry.runner,
        file: entry.file,
        exitCode,
        files: new Map([[entry.file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
        parseFailures: parsed.parseFailures,
      });
    }
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
  return evaluatePostgresSuite({ plan, records, environmentGaps });
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

async function main(argv) {
  const known = new Set(["--plan"]);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new CiPostgresSuiteError("CI_SUITE_USAGE", `unknown argument ${unknown[0]}`);
  }
  if (argv.includes("--plan")) {
    const plan = await planPostgresSuite();
    process.stdout.write(`${JSON.stringify({
      status: plan.failures.length === 0 ? "planned" : "failed",
      files: plan.files.map(({ file, runner, profile }) => ({ file, runner, profile })),
      hostProfileFiles: plan.hostProfileFiles,
      explicitProfileFiles: plan.files.filter(({ profile }) => profile === PROFILE_EDGE_E2E)
        .map(({ file, runner, profile }) => ({ file, runner, profile })),
      unregisteredAllowlist: UNREGISTERED_ALLOWLIST,
      failures: plan.failures,
    }, null, 2)}\n`);
    if (plan.failures.length > 0) {
      printFailures(plan.failures);
      process.exitCode = 1;
    }
    return;
  }
  const summary = await runPostgresSuite();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "passed") {
    printFailures(summary.failures);
    printFailures(summary.environmentGaps);
    process.exitCode = 1;
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
