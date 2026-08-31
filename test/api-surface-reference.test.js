import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIRECTORY, "..");

async function repositoryFile(path) {
  return readFile(join(ROOT, path), "utf8");
}

function headingSection(markdown, heading) {
  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gmu)]
    .map((match) => ({
      index: match.index,
      length: match[0].length,
      level: match[1].length,
      text: match[2],
    }));
  const matches = headings.filter((candidate) => candidate.text === heading);
  assert.equal(matches.length, 1, `expected one ${heading} heading`);
  const start = matches[0];
  const end = headings.find((candidate) =>
    candidate.index > start.index && candidate.level <= start.level);
  return markdown.slice(start.index + start.length, end?.index);
}

const METHOD_ORDER = new Map([
  ["GET", 0],
  ["POST", 1],
  ["DELETE", 2],
]);

function normalizeMethods(methods, label) {
  if (methods === "all") return "all";
  const unique = [...new Set(methods)];
  assert.equal(unique.length, methods.length, `${label} duplicates a method`);
  assert.ok(unique.length > 0, `${label} has no methods`);
  for (const method of unique) {
    assert.ok(METHOD_ORDER.has(method), `${label} has unknown method ${method}`);
  }
  return unique.sort((left, right) =>
    METHOD_ORDER.get(left) - METHOD_ORDER.get(right));
}

function routePolicy(entries, label) {
  const normalized = entries.map((entry) => ({
    path: entry.path,
    methods: normalizeMethods(entry.methods, `${label} ${entry.path}`),
  })).sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(
    new Set(normalized.map((entry) => entry.path)).size,
    normalized.length,
    `${label} contains duplicate paths`,
  );
  return normalized;
}

function documentedRoutePolicy(markdown, heading) {
  const entries = [];
  for (const row of headingSection(markdown, heading).split("\n")) {
    if (!row.startsWith("|") || !row.endsWith("|")) continue;
    const cells = row.slice(1, -1).split("|").map((cell) => cell.trim());
    const path = /^`(\/[^`]+)`$/u.exec(cells[1] ?? "")?.[1];
    if (!path) continue;
    const methodCell = cells[0] ?? "";
    const methods = methodCell === "all"
      ? "all"
      : [...methodCell.matchAll(/`([A-Z]+)`/gu)].map((match) => match[1]);
    if (methods !== "all") {
      assert.equal(
        methodCell,
        methods.map((method) => `\`${method}\``).join(", "),
        `${heading} ${path} has a malformed method cell`,
      );
    }
    entries.push({ path, methods });
  }
  return routePolicy(entries, `${heading} documentation`);
}

function sourceBlock(source, startPattern, endPattern, label) {
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `missing ${label} source block`);
  const remainder = source.slice(start);
  const end = remainder.search(endPattern);
  assert.notEqual(end, -1, `unterminated ${label} source block`);
  return remainder.slice(0, end);
}

function quotedMethods(source, label) {
  return normalizeMethods(
    [...source.matchAll(/"([A-Z]+)"/gu)].map((match) => match[1]),
    label,
  );
}

function workerRoutePolicy(source) {
  const block = sourceBlock(
    source,
    /const EXACT_WORKER_ROUTE_DEFINITIONS = \[/u,
    /\] as const/u,
    "Worker route registry",
  );
  const entries = [...block.matchAll(
    /pathname:\s*"(\/[^"?]+)",\s*id:\s*"[^"]+",\s*methods:\s*("all"|\[[^\]]*\]),\s*authority:\s*"([a-z_]+)"/gu,
  )].map((match) => ({
    path: match[1],
    methods: match[2] === "\"all\""
      ? "all"
      : quotedMethods(match[2], `Worker ${match[1]}`),
    authority: match[3],
  }));
  const fieldCount = [...block.matchAll(/\bpathname\s*:/gu)].length;
  assert.equal(entries.length, fieldCount, "every Worker route needs method and authority metadata");
  const authorities = new Set([
    "none", "public", "enrollment", "handoff", "recovery", "session",
    "device", "upload", "pairing_code", "admin", "operator",
  ]);
  for (const entry of entries) {
    assert.ok(authorities.has(entry.authority), `unknown Worker authority ${entry.authority}`);
  }
  return routePolicy(entries, "Worker registry");
}

function localRoutePolicy(source) {
  const allowlist = sourceBlock(
    source,
    /const API_ROUTES = new Set\(\[/u,
    /\]\);/u,
    "local API allowlist",
  );
  const allowlistedPaths = [...allowlist.matchAll(
    /"(\/api\/local\/[^"?]+)"/gu,
  )].map((match) => match[1]).sort();
  const dispatcherStart = source.indexOf("const server = createServer");
  assert.notEqual(dispatcherStart, -1, "missing local dispatcher");
  const dispatcher = source.slice(dispatcherStart);
  const reportBoundary = dispatcher.indexOf("const report = REPORT_ROUTES[path]");
  assert.notEqual(reportBoundary, -1, "missing local report boundary");
  const apiDispatcher = dispatcher.slice(0, reportBoundary);
  const handlers = [...apiDispatcher.matchAll(
    /if \((path === "\/api\/local\/[^"]+"(?:\s*\|\|\s*path === "\/api\/local\/[^"]+")*)\) \{/gu,
  )];
  const entries = [];
  for (const [index, handler] of handlers.entries()) {
    const block = apiDispatcher.slice(
      handler.index,
      handlers[index + 1]?.index ?? apiDispatcher.length,
    );
    const paths = [...handler[1].matchAll(/"(\/api\/local\/[^"?]+)"/gu)]
      .map((match) => match[1]);
    const methods = [...block.matchAll(
      /request\.method\s*(?:===|!==)\s*"([A-Z]+)"/gu,
    )].map((match) => match[1]);
    for (const path of paths) entries.push({ path, methods });
  }
  const policy = routePolicy(entries, "local dispatcher");
  assert.deepEqual(
    policy.map((entry) => entry.path),
    allowlistedPaths,
    "local allowlist and dispatcher paths disagree",
  );
  return policy;
}

function centralRoutePolicy(source) {
  const block = sourceBlock(
    source,
    /const EXACT_ROUTES = new Map\(\[/u,
    /\]\);/u,
    "central relay",
  );
  return routePolicy(
    [...block.matchAll(
      /\["(\/api\/[^"?]+)",\s*new Set\(\[([^\]]*)\]\)\]/gu,
    )].map((match) => ({
      path: match[1],
      methods: quotedMethods(match[2], `central relay ${match[1]}`),
    })),
    "central relay",
  );
}

function participantRelayPolicy(source) {
  const block = sourceBlock(
    source,
    /export const PARTICIPANT_RELAY_ROUTE_POLICY = Object\.freeze\(\[/u,
    /\]\);/u,
    "participant relay",
  );
  return routePolicy(
    [...block.matchAll(
      /defineParticipantRelayRoute\(\s*"(\/api\/v1\/[^"?]+)"\s*,\s*\[([^\]]*)\]/gu,
    )].map((match) => ({
      path: match[1],
      methods: quotedMethods(match[2], `participant relay ${match[1]}`),
    })),
    "participant relay",
  );
}

function reportRoutePolicy(source) {
  const block = sourceBlock(
    source,
    /export const LOCAL_COMPANION_REPORT_FILES = Object\.freeze\(\{/u,
    /\}\);/u,
    "fixed reports",
  );
  return routePolicy(
    [...block.matchAll(/"(\/reports\/[^"?]+)":\s*"[^"]+"/gu)]
      .map((match) => ({ path: match[1], methods: ["GET"] })),
    "fixed reports",
  );
}

test("both maintained API references cover every registered HTTP boundary", async () => {
  const [markdown, detailedMarkdown, worker, local, central, participant, reports] = await Promise.all([
    repositoryFile("docs/reference/api-surface.md"),
    repositoryFile("docs/reference/2026-08-26-api-surface-reference.md"),
    repositoryFile("apps/worker/src/route-registry.ts"),
    repositoryFile("apps/local/server.js"),
    repositoryFile("src/local-companion-central-proxy.js"),
    repositoryFile("apps/local/transport/participant-relay-routes.js"),
    repositoryFile("src/local-companion-data.js"),
  ]);

  const workerPolicy = workerRoutePolicy(worker);
  const localPolicy = localRoutePolicy(local);
  const reportPolicy = reportRoutePolicy(reports);
  const centralPolicy = centralRoutePolicy(central);
  const participantPolicy = participantRelayPolicy(participant);

  assert.equal(workerPolicy.length, 36, "review Worker route-count changes");
  assert.equal(localPolicy.length, 25, "review local route-count changes");
  assert.equal(reportPolicy.length, 4, "review fixed report-count changes");
  assert.equal(centralPolicy.length, 1, "review central relay-count changes");
  assert.equal(
    participantPolicy.length,
    9,
    "review participant relay-count changes",
  );

  for (const [name, reference] of [
    ["entrypoint", markdown],
    ["detailed", detailedMarkdown],
  ]) {
    for (const [heading, policy] of [
      ["Hosted Worker route inventory", workerPolicy],
      ["Local route inventory", localPolicy],
      ["Fixed report pages", reportPolicy],
      ["Public central relay", centralPolicy],
      ["Participant relay", participantPolicy],
    ]) {
      assert.deepEqual(
        documentedRoutePolicy(reference, heading),
        policy,
        `${name}: ${heading}`,
      );
    }
  }

  const ledger = new Map(headingSection(detailedMarkdown, "Surface ledger")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map((cells) => [cells[1], cells[3]]));
  const operationCount = (policy) => policy.reduce((count, route) =>
    count + (route.methods === "all" ? 0 : route.methods.length), 0);
  const workerApiPolicy = workerPolicy.filter((route) => route.path.startsWith("/api/"));
  assert.equal(
    ledger.get("Local companion API"),
    `${localPolicy.length} paths, ${operationCount(localPolicy)} method/path operations`,
  );
  assert.equal(
    ledger.get("Participant relay"),
    `${participantPolicy.length} paths, ${operationCount(participantPolicy)} method/path operations`,
  );
  assert.ok(
    detailedMarkdown.includes(`health-only central relay + ${participantPolicy.length} participant relays`),
    "the trust-boundary diagram must match the participant relay inventory",
  );
  assert.equal(
    ledger.get("Hosted Worker API"),
    `${workerApiPolicy.length} API paths, ${operationCount(workerApiPolicy)} method/path operations`,
  );
});
