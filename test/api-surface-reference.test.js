import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "..");
const REFERENCE_PATH = join(
  REPOSITORY_ROOT,
  "docs/reference/2026-08-26-api-surface-reference.md",
);
const LIFECYCLE_REVIEW_PATH = join(
  REPOSITORY_ROOT,
  "docs/reviews/2026-08-26-api-lifecycle-review.md",
);
const RETIREMENT_RUNBOOK_PATH = join(
  REPOSITORY_ROOT,
  "docs/runbooks/2026-08-27-hosted-api-retirement-data-gates.md",
);
const WORKER_WRANGLER_PATH = "apps/worker/wrangler.jsonc";
const DOGFOOD_WRANGLER_PATH = "apps/worker/wrangler.dogfood.jsonc";

async function repositoryFile(path) {
  return readFile(join(REPOSITORY_ROOT, path), "utf8");
}

const SECTION_HEADINGS = new Map([
  ["local", "Local route inventory"],
  ["reports", "Fixed report pages"],
  ["central-proxy", "Public central relay"],
  ["participant-relay", "Participant relay"],
  ["worker", "Hosted Worker route inventory"],
  [
    "cloudflare-bindings",
    "4. Cloudflare runtime APIs and non-HTTP entrypoints",
  ],
  [
    "package-accounting",
    "`@app-usagemonitor/accounting` — 27 public symbols",
  ],
  [
    "package-quota-analysis",
    "`@app-usagemonitor/quota-analysis` — 32 public symbols",
  ],
  [
    "package-telemetry-contract",
    "`@app-usagemonitor/telemetry-contract` — 24 public symbols",
  ],
  [
    "package-identity-core",
    "`@app-usagemonitor/identity-core` — 2 public symbols",
  ],
  ["package-i18n", "`@app-usagemonitor/i18n` — 17 public symbols"],
  ["wkwebview-bridge", "WKWebView bridge"],
]);

function headingSection(markdown, name) {
  const expected = SECTION_HEADINGS.get(name);
  assert.ok(expected, `unknown API reference section ${name}`);

  const headings = [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gmu)]
    .map((match) => ({
      index: match.index,
      length: match[0].length,
      level: match[1].length,
      text: match[2],
    }));
  const matches = headings.filter((heading) => heading.text === expected);
  assert.equal(matches.length, 1, `expected one heading for ${name}`);

  const start = matches[0];
  const end = headings.find((heading) => (
    heading.index > start.index && heading.level <= start.level
  ));
  return markdown.slice(start.index + start.length, end?.index);
}

function proseOutsideCode(markdown) {
  return markdown
    .replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gmu, "")
    .replace(/`[^`]*`/gu, "");
}

function mermaidBlocks(markdown) {
  return [...markdown.matchAll(
    /^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu,
  )].map((match) => match[1]);
}

function documentedBridgePolicy(markdown) {
  const rows = [...headingSection(markdown, "wkwebview-bridge").matchAll(
    /^\| (Web → native|Native → web) \| `([^`]+)` \|/gmu,
  )].map((match) => ({ direction: match[1], name: match[2] }));
  return rows.sort((left, right) => (
    left.direction.localeCompare(right.direction)
      || left.name.localeCompare(right.name)
  ));
}

function nativeBridgePolicy(source) {
  const inbound = [...source.matchAll(
    /configuration\.userContentController\.add\(\s*self,\s*name: "([A-Za-z][A-Za-z0-9]+)"\s*\)/gmu,
  )].map((match) => match[1]);
  const outbound = [...source.matchAll(
    /window\.dispatchEvent\(new (?:Custom)?Event\('(tibotattle:[a-z-]+)'/gmu,
  )].map((match) => match[1]);
  return [
    ...sortedUnique(inbound, "native inbound bridge names")
      .map((name) => ({ direction: "Web → native", name })),
    ...sortedUnique(outbound, "native outbound bridge names")
      .map((name) => ({ direction: "Native → web", name })),
  ].sort((left, right) => (
    left.direction.localeCompare(right.direction)
      || left.name.localeCompare(right.name)
  ));
}

function parseJsonc(source, label) {
  let json = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        json += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n") {
        json += character;
      }
      continue;
    }
    if (inString) {
      json += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      json += character;
    } else if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      json += character;
    }
  }

  assert.equal(inString, false, `${label} has an unterminated string`);
  assert.equal(inBlockComment, false, `${label} has an unterminated comment`);
  try {
    return JSON.parse(json);
  } catch (error) {
    assert.fail(`${label} is not parseable JSONC: ${error.message}`);
  }
}

function cloudflareBindingInventory(workerConfig, dogfoodConfig) {
  const production = workerConfig.env?.production;
  assert.ok(production, "Worker Wrangler config has no production environment");
  const configuredWorkers = [production, dogfoodConfig];
  const values = (config, property) => config[property] ?? [];
  return {
    d1: configuredWorkers.flatMap((config) => values(config, "d1_databases")),
    r2: configuredWorkers.flatMap((config) => values(config, "r2_buckets")),
    durableObjects: values(production.durable_objects ?? {}, "bindings"),
    rateLimits: values(production, "ratelimits"),
    assets: production.assets?.binding ? [production.assets.binding] : [],
    crons: values(production.triggers ?? {}, "crons"),
  };
}

function quotedPaths(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function sourceBlock(source, startPattern, endPattern, label) {
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `missing ${label} source block`);
  const remainder = source.slice(start);
  const end = remainder.search(endPattern);
  assert.notEqual(end, -1, `unterminated ${label} source block`);
  return remainder.slice(0, end);
}

function sortedUnique(values, label) {
  const unique = [...new Set(values)].sort();
  assert.equal(unique.length, values.length, `${label} contains duplicate paths`);
  return unique;
}

const ROUTE_METHOD_ORDER = new Map([
  ["GET", 0],
  ["POST", 1],
  ["DELETE", 2],
]);

const WORKER_AUTHORITY_LABELS = new Map([
  ["none", "None"],
  ["public", "Public"],
  ["enrollment", "Handoff / reattachment"],
  ["handoff", "Handoff"],
  ["recovery", "Recovery"],
  ["session", "Session"],
  ["device", "Device"],
  ["upload", "Upload"],
  ["pairing_code", "Pairing code"],
  ["admin", "Admin"],
  ["operator", "Operator"],
]);

function normalizedMethods(methods, label) {
  if (methods === "all") return "all";
  assert.ok(methods.length > 0, `${label} declares no methods`);
  for (const method of methods) {
    assert.ok(
      ROUTE_METHOD_ORDER.has(method),
      `${label} declares unsupported method ${method}`,
    );
  }
  const unique = [...new Set(methods)];
  assert.equal(unique.length, methods.length, `${label} duplicates a method`);
  return unique.sort(
    (left, right) => ROUTE_METHOD_ORDER.get(left) - ROUTE_METHOD_ORDER.get(right),
  );
}

function routePolicy(entries, label) {
  const normalized = entries.map((entry) => ({
    path: entry.path,
    methods: normalizedMethods(entry.methods, `${label} ${entry.path}`),
    ...(entry.authority === undefined ? {} : { authority: entry.authority }),
  })).sort((left, right) => left.path.localeCompare(right.path));
  sortedUnique(normalized.map((entry) => entry.path), label);
  return normalized;
}

function quotedMethods(source, label) {
  const methods = [...source.matchAll(/"([A-Z]+)"/gu)]
    .map((match) => match[1]);
  return normalizedMethods(methods, label);
}

function documentedRoutePolicy(markdown, section, { authority = false } = {}) {
  const entries = [];
  for (const row of headingSection(markdown, section).split("\n")) {
    if (!row.startsWith("|") || !row.endsWith("|")) continue;
    const cells = row.slice(1, -1).split("|").map((cell) => cell.trim());
    const path = /^`(\/[^`]+)`$/u.exec(cells[1] ?? "")?.[1];
    if (path === undefined) continue;
    const methodCell = cells[0] ?? "";
    let methods;
    if (methodCell === "all") {
      methods = "all";
    } else {
      methods = [...methodCell.matchAll(/`([A-Z]+)`/gu)]
        .map((match) => match[1]);
      assert.equal(
        methodCell,
        methods.map((method) => `\`${method}\``).join(", "),
        `${section} ${path} has a malformed method cell`,
      );
    }
    entries.push({
      path,
      methods,
      ...(authority ? { authority: cells[2] } : {}),
    });
  }
  return routePolicy(entries, `${section} reference`);
}

function localRoutePolicy(localSource) {
  const routeBlock = sourceBlock(
    localSource,
    /const API_ROUTES = new Set\(\[/u,
    /\]\);/u,
    "local API route",
  );
  const allowlistedPaths = sortedUnique(
    quotedPaths(routeBlock, /"(\/api\/local\/[^"?]+)"/gu),
    "local API allowlist",
  );
  const dispatcherStart = localSource.indexOf("const server = createServer");
  assert.notEqual(dispatcherStart, -1, "missing local API dispatcher");
  const dispatcher = localSource.slice(dispatcherStart);
  const reportDispatcherStart = dispatcher.indexOf(
    "const report = REPORT_ROUTES[path]",
  );
  assert.notEqual(
    reportDispatcherStart,
    -1,
    "missing local report dispatcher boundary",
  );
  const apiDispatcher = dispatcher.slice(0, reportDispatcherStart);
  const handlers = [...apiDispatcher.matchAll(
    /if \((path === "\/api\/local\/[^"]+"(?:\s*\|\|\s*path === "\/api\/local\/[^"]+")*)\) \{/gu,
  )];
  const entries = [];
  for (const [index, handler] of handlers.entries()) {
    const block = apiDispatcher.slice(
      handler.index,
      handlers[index + 1]?.index ?? apiDispatcher.length,
    );
    const paths = quotedPaths(handler[1], /"(\/api\/local\/[^"?]+)"/gu);
    const methods = [...block.matchAll(
      /request\.method\s*(?:===|!==)\s*"([A-Z]+)"/gu,
    )].map((match) => match[1]);
    for (const path of paths) entries.push({ path, methods });
  }
  const policy = routePolicy(entries, "local API dispatcher");
  assert.deepEqual(
    policy.map((entry) => entry.path),
    allowlistedPaths,
    "local API allowlist and dispatcher paths disagree",
  );
  return policy;
}

function reportRoutePolicy(reportSource, localSource) {
  const reportBlock = sourceBlock(
    reportSource,
    /export const LOCAL_COMPANION_REPORT_FILES = Object\.freeze\(\{/u,
    /\}\);/u,
    "report route",
  );
  const reportDispatcher = sourceBlock(
    localSource,
    /const report = REPORT_ROUTES\[path\];/u,
    /const staticFile = STATIC_FILES\[path\];/u,
    "report route dispatcher",
  );
  const methods = [...reportDispatcher.matchAll(
    /request\.method\s*!==\s*"([A-Z]+)"/gu,
  )].map((match) => match[1]);
  assert.equal(methods.length, 1, "report dispatcher must have one method gate");
  const entries = [...reportBlock.matchAll(
    /"(\/reports\/[^"?]+)"\s*:\s*"([^"?]+\.html)"/gu,
  )];
  const pathFields = [...reportBlock.matchAll(/"\/reports\/[^"?]+"\s*:/gu)];
  assert.ok(pathFields.length > 0, "report source declares no report paths");
  assert.equal(
    entries.length,
    pathFields.length,
    "report map parser did not capture every declared path/file entry",
  );
  const paths = entries.map((entry) => entry[1]);
  return routePolicy(
    paths.map((path) => ({ path, methods })),
    "report route source",
  );
}

function centralRoutePolicy(centralSource) {
  const block = sourceBlock(
    centralSource,
    /const EXACT_ROUTES = new Map\(\[/u,
    /\]\);/u,
    "central proxy route",
  );
  const entries = [...block.matchAll(
    /\["(\/api\/[^"?]+)",\s*new Set\(\[([^\]]*)\]\)\]/gu,
  )].map((match) => ({
    path: match[1],
    methods: quotedMethods(match[2], `central proxy ${match[1]}`),
  }));
  const mapEntries = [...block.matchAll(/\[\s*"\/[^"?]+"\s*,/gu)];
  const methodSets = [...block.matchAll(/\bnew Set\s*\(/gu)];
  assert.ok(mapEntries.length > 0, "central proxy map declares no route entries");
  assert.equal(
    entries.length,
    mapEntries.length,
    "central proxy parser did not capture every declared map entry",
  );
  assert.equal(
    entries.length,
    methodSets.length,
    "central proxy parser did not capture every declared method set",
  );
  return routePolicy(entries, "central proxy source");
}

function participantRelayRoutePolicy(source) {
  const block = sourceBlock(
    source,
    /export const PARTICIPANT_RELAY_ROUTE_POLICY = Object\.freeze\(\[/u,
    /\]\);/u,
    "participant relay policy",
  );
  const entries = [...block.matchAll(
    /defineParticipantRelayRoute\(\s*"(\/api\/v1\/[^"?]+)"\s*,\s*\[([^\]]*)\]\s*,?\s*\)/gu,
  )].map((match) => ({
    path: match[1],
    methods: quotedMethods(match[2], `participant relay ${match[1]}`),
  }));
  const routeConstructors = [...block.matchAll(
    /\bdefineParticipantRelayRoute\s*\(/gu,
  )];
  assert.ok(
    routeConstructors.length > 0,
    "participant relay policy declares no route constructors",
  );
  assert.equal(
    entries.length,
    routeConstructors.length,
    "participant relay parser did not capture every route constructor",
  );
  return routePolicy(entries, "participant relay source");
}

function workerRoutePolicy(source) {
  const block = sourceBlock(
    source,
    /const EXACT_WORKER_ROUTE_DEFINITIONS = \[/u,
    /\] as const/u,
    "Worker route",
  );
  const entries = [...block.matchAll(
    /pathname:\s*"(\/[^"?]+)",\s*id:\s*"[^"]+",\s*methods:\s*("all"|\[[^\]]*\]),\s*authority:\s*"([a-z_]+)"/gu,
  )].map((match) => {
    const authority = WORKER_AUTHORITY_LABELS.get(match[3]);
    assert.ok(authority, `Worker ${match[1]} has unknown authority ${match[3]}`);
    return {
      path: match[1],
      methods: match[2] === "\"all\""
        ? "all"
        : quotedMethods(match[2], `Worker ${match[1]}`),
      authority,
    };
  });
  const pathnameFields = [...block.matchAll(/\bpathname\s*:/gu)];
  const idFields = [...block.matchAll(/\bid\s*:/gu)];
  const methodFields = [...block.matchAll(/\bmethods\s*:/gu)];
  const authorityFields = [...block.matchAll(/\bauthority\s*:/gu)];
  assert.ok(pathnameFields.length > 0, "Worker registry declares no pathnames");
  for (const [field, count] of [
    ["route objects", entries.length],
    ["id fields", idFields.length],
    ["method fields", methodFields.length],
    ["authority fields", authorityFields.length],
  ]) {
    assert.equal(
      count,
      pathnameFields.length,
      `Worker parser coverage differs for ${field} and pathname fields`,
    );
  }
  return routePolicy(entries, "Worker route source");
}

function operationCount(policy) {
  return policy.reduce(
    (count, route) => count + (route.methods === "all" ? 0 : route.methods.length),
    0,
  );
}

function exportedSymbols(source) {
  const symbols = [];
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}\s*from/gu)) {
    for (const candidate of match[1].split(",")) {
      const normalized = candidate
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/.*$/gmu, "")
        .trim();
      if (normalized.length === 0) continue;
      const exported = normalized.split(/\s+as\s+/u).at(-1);
      assert.match(exported, /^[A-Za-z_$][A-Za-z0-9_$]*$/u);
      symbols.push(exported);
    }
  }
  for (const match of source.matchAll(
    /^export\s+(?:const|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gmu,
  )) {
    symbols.push(match[1]);
  }
  return sortedUnique(symbols, "package source exports");
}

function documentedSymbols(markdown, section) {
  return sortedUnique(
    [...headingSection(markdown, section).matchAll(
      /`([A-Za-z_$][A-Za-z0-9_$]*)`/gu,
    )].map((match) => match[1]),
    `${section} documented exports`,
  );
}

async function jsonFilesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFilesBelow(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  }));
  return nested.flat();
}

async function sourceFilesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)
      ? [path]
      : [];
  }));
  return nested.flat();
}

test("API reference methods, paths, and Worker authorities match source", async () => {
  const [
    markdown,
    localSource,
    reportSource,
    participantRelaySource,
    centralProxySource,
    workerRouteSource,
  ] = await Promise.all([
    readFile(REFERENCE_PATH, "utf8"),
    repositoryFile("apps/local/server.js"),
    repositoryFile("src/local-companion-data.js"),
    repositoryFile("apps/local/transport/participant-relay-routes.js"),
    repositoryFile("src/local-companion-central-proxy.js"),
    repositoryFile("apps/worker/src/route-registry.ts"),
  ]);

  const expectedPolicies = new Map([
    ["local", localRoutePolicy(localSource)],
    ["reports", reportRoutePolicy(reportSource, localSource)],
    ["central-proxy", centralRoutePolicy(centralProxySource)],
    [
      "participant-relay",
      participantRelayRoutePolicy(participantRelaySource),
    ],
    ["worker", workerRoutePolicy(workerRouteSource)],
  ]);
  for (const [section, expected] of expectedPolicies) {
    assert.deepEqual(
      documentedRoutePolicy(markdown, section, {
        authority: section === "worker",
      }),
      expected,
      `${section} API reference drifted from its exact source policy`,
    );
  }
});

test("API reference preserves high-risk boundary facts", async () => {
  const [
    markdown,
    centralProxySource,
    participantRelaySource,
    workerRouteSource,
    keychainCapabilitySource,
    nativeSource,
    webAppSource,
    webLocalizationSource,
  ] = await Promise.all([
    readFile(REFERENCE_PATH, "utf8"),
    repositoryFile("src/local-companion-central-proxy.js"),
    repositoryFile("apps/local/transport/participant-relay-routes.js"),
    repositoryFile("apps/worker/src/route-registry.ts"),
    repositoryFile("src/platform/keychain-capabilities.js"),
    repositoryFile("apps/macos/UsageMonitorApp.swift"),
    repositoryFile("apps/web/public/app.js"),
    repositoryFile("apps/web/public/localization.js"),
  ]);
  assert.match(markdown, /does \*\*not\*\* call the Anthropic API/u);
  assert.match(markdown, /\*\*not\*\* a call to the OpenAI API/u);
  const diagrams = mermaidBlocks(markdown);
  assert.equal(
    diagrams.length,
    2,
    "reference must retain both the system and sequence diagrams",
  );

  const systemDiagram = diagrams.find((diagram) => (
    diagram.startsWith("flowchart ")
  ));
  const sequenceDiagram = diagrams.find((diagram) => (
    diagram.startsWith("sequenceDiagram")
  ));
  assert.ok(systemDiagram, "reference is missing its system flowchart");
  assert.ok(sequenceDiagram, "reference is missing its identity sequence diagram");
  assert.deepEqual(centralRoutePolicy(centralProxySource), [{
    methods: ["GET"],
    path: "/api/health",
  }]);
  assert.match(
    systemDiagram,
    /Local --> \|health-only central relay \+ nine participant relays\| Worker/u,
    "system diagram must distinguish the health-only central relay",
  );
  assert.equal(
    participantRelayRoutePolicy(participantRelaySource).length,
    9,
    "system diagram's participant-relay count must remain source-backed",
  );

  const keychainBlock = sourceBlock(
    keychainCapabilitySource,
    /export const MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES = Object\.freeze\(\{/u,
    /\}\);/u,
    "macOS Keychain broker capability",
  );
  const keychainCapabilities = sortedUnique(
    [...keychainBlock.matchAll(/:\s*"([a-z_]+)"/gu)]
      .map((match) => match[1]),
    "macOS Keychain broker capabilities",
  );
  assert.equal(keychainCapabilities.length, 4);
  assert.match(
    systemDiagram,
    /Native <--> \|four capabilities; get \/ set \/ delete\| Keychain/u,
  );

  const participantOperations = new Set(
    participantRelayRoutePolicy(participantRelaySource).flatMap((route) => (
      route.methods.map((method) => `${method} ${route.path}`)
    )),
  );
  const workerOperations = new Set(
    workerRoutePolicy(workerRouteSource).flatMap((route) => (
      route.methods === "all"
        ? []
        : route.methods.map((method) => `${method} ${route.path}`)
    )),
  );
  const sequenceOperations = [
    "POST /api/v1/identity/google/start",
    "POST /api/v1/identity/apple/start",
    "POST /api/v1/identity/google/result",
    "POST /api/v1/identity/apple/result",
    "POST /api/v1/enroll",
    "POST /api/v1/me/device-pairings",
    "POST /api/v1/device-pairings/claim",
    "POST /api/v1/device/upload-authorizations",
    "POST /api/v1/contributions",
  ];
  for (const operation of sequenceOperations) {
    assert.ok(
      participantOperations.has(operation) || workerOperations.has(operation),
      `identity sequence operation is absent from source policy: ${operation}`,
    );
    assert.ok(
      sequenceDiagram.includes(operation),
      `identity sequence diagram is missing retained operation: ${operation}`,
    );
  }

  const bridgePolicy = nativeBridgePolicy(nativeSource);
  assert.equal(
    bridgePolicy.filter((entry) => entry.direction === "Web → native").length,
    3,
    "native source must retain exactly three web-to-native handlers",
  );
  assert.equal(
    bridgePolicy.filter((entry) => entry.direction === "Native → web").length,
    4,
    "native source must retain exactly four native-to-web events",
  );
  assert.deepEqual(
    documentedBridgePolicy(markdown),
    bridgePolicy,
    "WKWebView bridge table drifted from native source",
  );
  const webBridgeSource = `${webAppSource}\n${webLocalizationSource}`;
  for (const { name } of bridgePolicy) {
    assert.ok(
      webBridgeSource.includes(name),
      `native bridge name has no shipped web consumer: ${name}`,
    );
  }
  assert.doesNotMatch(
    diagrams.join("\n"),
    /\bCloud[ -]Run\b|\bGCS\b|Google Cloud Storage/iu,
    "retired Cloud Run/GCS architecture must not reappear in a diagram",
  );
});

test("API reference uses renderer-portable Markdown", async () => {
  for (const path of [
    REFERENCE_PATH,
    LIFECYCLE_REVIEW_PATH,
    RETIREMENT_RUNBOOK_PATH,
  ]) {
    const markdown = await readFile(path, "utf8");
    const prose = proseOutsideCode(markdown);

    assert.doesNotMatch(
      prose,
      /<!--|-->/u,
      `${path} contains an HTML comment that can render as an artifact`,
    );
    assert.doesNotMatch(
      prose,
      /<\/?(?:details|summary)(?:\s[^>]*)?>/iu,
      `${path} contains non-portable raw details/summary markup`,
    );
    assert.doesNotMatch(
      prose,
      /<\/?[A-Za-z][^>\n]*>/u,
      `${path} contains raw HTML outside a code fence`,
    );
  }
});

test("surface ledger summaries and reviewed internal APIs match source", async () => {
  const [
    markdown,
    architectureSource,
    workerWranglerSource,
    dogfoodWranglerSource,
  ] = await Promise.all([
    readFile(REFERENCE_PATH, "utf8"),
    repositoryFile("scripts/check-architecture-boundaries.mjs"),
    repositoryFile(WORKER_WRANGLER_PATH),
    repositoryFile(DOGFOOD_WRANGLER_PATH),
  ]);

  const localRoutes = documentedRoutePolicy(markdown, "local");
  const reportRoutes = documentedRoutePolicy(markdown, "reports");
  const centralRoutes = documentedRoutePolicy(markdown, "central-proxy");
  const participantRoutes = documentedRoutePolicy(markdown, "participant-relay");
  const workerRoutes = documentedRoutePolicy(markdown, "worker", {
    authority: true,
  });
  const workerApiRoutes = workerRoutes.filter((route) => (
    route.path.startsWith("/api/")
  ));
  const workerNegativeRoutes = workerRoutes.filter((route) => (
    !route.path.startsWith("/api/")
  ));
  assert.match(
    markdown,
    new RegExp(
      `\\| Local companion API \\|[^\\n]+\\| ${localRoutes.length} paths, ${operationCount(localRoutes)} method/path operations \\|`,
      "u",
    ),
  );
  assert.ok(
    reportRoutes.every((route) => (
      Array.isArray(route.methods) && route.methods.join() === "GET"
    )),
    "report inventory must remain GET-only",
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Local report pages \\|[^\\n]+\\| ${reportRoutes.length} \\x60GET\\x60 paths \\|`,
      "u",
    ),
  );
  assert.ok(
    centralRoutes.every((route) => (
      Array.isArray(route.methods) && route.methods.join() === "GET"
    )),
    "central public relay must remain GET-only",
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Central public relay \\|[^\\n]+\\| ${centralRoutes.length} fixed \\x60GET\\x60 ${centralRoutes.length === 1 ? "path" : "paths"} \\|`,
      "u",
    ),
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Participant relay \\|[^\\n]+\\| ${participantRoutes.length} paths, ${operationCount(participantRoutes)} method/path operations \\|`,
      "u",
    ),
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Hosted Worker API \\|[^\\n]+\\| ${workerApiRoutes.length} API paths, ${operationCount(workerApiRoutes)} method/path operations \\|`,
      "u",
    ),
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Deliberate negative Worker route \\|[^\\n]+\\| ${workerNegativeRoutes.length} always-\\x60404\\x60 path \\|`,
      "u",
    ),
  );

  const reviewedBlock = sourceBlock(
    architectureSource,
    /const REVIEWED_SOURCE_OWNER_PUBLIC_ENTRYPOINTS = new Set\(\[/u,
    /\]\);/u,
    "reviewed source-owner public entrypoint",
  );
  const reviewedEntrypoints = sortedUnique(
    quotedPaths(reviewedBlock, /"(src\/[^"?]+)"/gu),
    "reviewed source-owner entrypoints",
  );
  assert.equal(reviewedEntrypoints.length, 24);
  for (const entrypoint of reviewedEntrypoints) {
    assert.ok(
      markdown.includes(`../../${entrypoint}`),
      `API reference is missing reviewed entrypoint ${entrypoint}`,
    );
  }

  const schemaFiles = (
    await Promise.all([
      jsonFilesBelow(join(REPOSITORY_ROOT, "contracts")),
      jsonFilesBelow(join(REPOSITORY_ROOT, "schemas")),
      jsonFilesBelow(join(
        REPOSITORY_ROOT,
        "packages/telemetry-contract/schemas",
      )),
    ])
  ).flat();
  assert.equal(schemaFiles.length, 37);
  assert.match(markdown, /37 JSON contract\/schema files/u);
  const bindingInventory = cloudflareBindingInventory(
    parseJsonc(workerWranglerSource, WORKER_WRANGLER_PATH),
    parseJsonc(dogfoodWranglerSource, DOGFOOD_WRANGLER_PATH),
  );
  assert.match(
    markdown,
    new RegExp(
      `\\| Cloudflare service bindings \\|[^\\n]+\\| ${bindingInventory.d1.length} D1 bindings, ${bindingInventory.r2.length} production R2 bindings, ${bindingInventory.durableObjects.length} Durable Object, ${bindingInventory.rateLimits.length} rate limiters, ${bindingInventory.assets.length} assets binding, ${bindingInventory.crons.length} cron schedule \\|`,
      "u",
    ),
    "Cloudflare binding summary must be derived from production Wrangler configs",
  );
  const bindingSection = headingSection(markdown, "cloudflare-bindings");
  const namedBindings = sortedUnique([...new Set([
    ...bindingInventory.d1.map(({ binding }) => binding),
    ...bindingInventory.r2.map(({ binding }) => binding),
    ...bindingInventory.durableObjects.map(({ name }) => name),
    ...bindingInventory.rateLimits.map(({ name }) => name),
    ...bindingInventory.assets,
  ])], "configured Cloudflare binding names");
  for (const binding of namedBindings) {
    assert.ok(
      bindingSection.includes(`\`${binding}\``),
      `API reference is missing Cloudflare binding ${binding}`,
    );
  }

  const sqlMigrationRoots = new Map([
    ["apps/worker/migrations", 40],
    ["apps/worker/deletion-ledger-migrations", 2],
    ["apps/worker/dogfood-update-guard-migrations", 1],
  ]);
  for (const [directory, expected] of sqlMigrationRoots) {
    const migrations = (await readdir(join(REPOSITORY_ROOT, directory)))
      .filter((name) => name.endsWith(".sql"));
    assert.equal(migrations.length, expected, `${directory} migration count drifted`);
    assert.ok(markdown.includes(`../../${directory}`));
  }

  const sqliteOwners = [];
  for (const path of await sourceFilesBelow(join(REPOSITORY_ROOT, "src"))) {
    if (/\bCREATE\s+TABLE\b/iu.test(await readFile(path, "utf8"))) {
      sqliteOwners.push(path.slice(REPOSITORY_ROOT.length + 1));
    }
  }
  assert.equal(sqliteOwners.length, 12);
  for (const owner of sqliteOwners) {
    assert.ok(
      markdown.includes(`../../${owner}`),
      `API reference is missing SQLite storage owner ${owner}`,
    );
  }

  const packageSections = new Map([
    ["accounting", "package-accounting"],
    ["quota-analysis", "package-quota-analysis"],
    ["telemetry-contract", "package-telemetry-contract"],
    ["identity-core", "package-identity-core"],
    ["i18n", "package-i18n"],
  ]);
  const packageDirectories = (await readdir(
    join(REPOSITORY_ROOT, "packages"),
    { withFileTypes: true },
  )).filter((entry) => entry.isDirectory() && packageSections.has(entry.name));
  assert.equal(packageDirectories.length, 5);
  for (const entry of packageDirectories) {
    const source = await repositoryFile(`packages/${entry.name}/index.js`);
    assert.deepEqual(
      documentedSymbols(markdown, packageSections.get(entry.name)),
      exportedSymbols(source),
      `${entry.name} symbol inventory drifted from its package root`,
    );
  }
});

test("primary documentation entrypoints link to the canonical API reference", async () => {
  const [
    rootReadme,
    docsIndex,
    localReadme,
    workerReadme,
    macosReadme,
  ] = await Promise.all([
    repositoryFile("README.md"),
    repositoryFile("docs/README.md"),
    repositoryFile("apps/local/README.md"),
    repositoryFile("apps/worker/README.md"),
    repositoryFile("apps/macos/README.md"),
  ]);
  assert.match(rootReadme, /docs\/reference\/2026-08-26-api-surface-reference\.md/u);
  assert.match(docsIndex, /reference\/2026-08-26-api-surface-reference\.md/u);
  assert.match(localReadme, /2026-08-26-api-surface-reference\.md/u);
  assert.match(workerReadme, /2026-08-26-api-surface-reference\.md/u);
  assert.match(macosReadme, /2026-08-26-api-surface-reference\.md/u);
});
