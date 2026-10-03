import { describe, expect, it } from "vitest";

import {
  ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  EDGE_CONTRACT_REQUEST_HEADERS,
  EDGE_HEADERS,
  EDGE_LOCAL_ONLY_REQUEST_HEADERS,
  FORWARDED_REQUEST_HEADERS,
} from "../src/edge-origin-contract";

/**
 * Request-header ratchet for the thin edge.
 *
 * In gcp mode the origin sees only the headers the edge forwards
 * (FORWARDED_REQUEST_HEADERS, plus ADMIN_ONLY_FORWARDED_REQUEST_HEADERS on the
 * admin host) and the contract headers. A Worker or origin module that starts
 * reading any other request header would silently see it absent behind the
 * edge. So every header name read in src/**\/*.ts and cloud-run/**\/*.mjs
 * (headers.get/has, headers["x"], req.headers.x) must be classified below, and
 * a new unclassified read fails naming its file.
 */

// Vite's import.meta.glob hands the ratchet the raw text of every module. It
// is untyped on purpose: a program-wide `vite/client` reference would give
// src/** Vite-only ambient types the deployed Worker bundle does not provide.
// @ts-expect-error -- test-only Vite import.meta.glob, checked by sourceTexts below.
const GLOBBED_SOURCES: unknown = import.meta.glob(
  [
    "../src/**/*.ts",
    "../cloud-run/**/*.mjs",
    "!**/*.check.mjs",
    "!**/*.spec.*",
    "!../cloud-run/dist/**",
    "!**/node_modules/**",
    "!**/vendor/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

function sourceTexts(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("expected the import.meta.glob ?raw record");
  }
  const result: Record<string, string> = {};
  for (const [path, text] of Object.entries(value)) {
    if (typeof text !== "string") throw new TypeError(`expected raw text for ${path}`);
    result[path] = text;
  }
  return Object.freeze(result);
}

const SOURCES = sourceTexts(GLOBBED_SOURCES);

// ---------------------------------------------------------------------------
// Classification

/**
 * Read by the origin's transport, never copied from the client by the edge.
 */
const ORIGIN_TRANSPORT_REQUEST_HEADERS = Object.freeze([
  // Cloud Run's IAM front end delivers the verified invoker claims here; the
  // edge sets it from its own ID token (EP-2) and EP-6 consumes it.
  EDGE_HEADERS.invokerToken,
  // The Node host's own authority check (cloud-run/server.mjs and
  // cloud-run/oauth-gateway.mjs); the edge's fetch sets it for the upstream.
  "host",
  // Message framing chosen by the HTTP connection, not a forwarded value:
  // cloud-run/oauth-gateway.mjs refuses a body on a bodyless route with it.
  "transfer-encoding",
]);

/**
 * Header names these files read from a RESPONSE (an upstream API, the
 * metadata server, a served page), never from a client request. Each name is
 * accepted only in the files listed for it, so the same name read anywhere
 * else is still a failure.
 */
const RESPONSE_HEADER_READS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // GitHub REST pagination on the release-inventory response.
  link: ["../src/github-distribution-history.ts"],
  // The GCP metadata server's identity on its token and project responses
  // (Cloud Run jobs only; never a request the edge forwards).
  "metadata-flavor": [
    "../cloud-run/postgres-community-daily-activation.mjs",
    "../cloud-run/postgres-community-daily-publish-test.mjs",
    "../cloud-run/postgres-community-graph-benchmark.mjs",
    "../cloud-run/postgres-community-graph-readback-diagnostic.mjs",
    "../cloud-run/test-activation.mjs",
    "../cloud-run/test-migrations.mjs",
  ],
  // The live smoke checks the headers community/daily served.
  "cache-control": ["../cloud-run/postgres-community-daily-live-smoke.mjs"],
  "referrer-policy": ["../cloud-run/postgres-community-daily-live-smoke.mjs"],
  "x-content-type-options": ["../cloud-run/postgres-community-daily-live-smoke.mjs"],
  // The edge checks the origin marker on the upstream response; the origin's
  // Node adapter (isEdgeOriginBoundaryRefusal, production and edge-test)
  // checks that EP-6's 421 Response carries none.
  [EDGE_HEADERS.originMarker]: [
    "../cloud-run/origin-node-request.mjs",
    "../src/edge-origin-proxy.ts",
  ],
});

/**
 * Reads whose header name is computed at run time. Each is reviewed here; the
 * expression must match the source text exactly, and a stale entry fails.
 */
const DYNAMIC_HEADER_READS: readonly Readonly<{
  file: string;
  expression: string;
  reason: string;
}>[] = Object.freeze([
  {
    file: "../src/edge-origin-proxy.ts",
    expression: "headers.get(name)",
    reason: "copies FORWARDED_REQUEST_HEADERS (plus the admin-only list) to the upstream request",
  },
  {
    file: "../cloud-run/postgres-edge-origin-dispatch.mjs",
    expression: "rawHeaders.get(name)",
    reason: "copies FORWARDED_REQUEST_HEADERS (plus the admin-only list) to the inner request",
  },
  {
    file: "../cloud-run/oauth-gateway.mjs",
    expression: "headers.get(name)",
    reason: "copies an allowlisted set of headers from a provider RESPONSE",
  },
]);

const REQUEST_HEADER_CLASSES: ReadonlySet<string> = new Set<string>([
  ...FORWARDED_REQUEST_HEADERS,
  ...ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  ...EDGE_LOCAL_ONLY_REQUEST_HEADERS,
  ...EDGE_CONTRACT_REQUEST_HEADERS,
  ...ORIGIN_TRANSPORT_REQUEST_HEADERS,
]);

// ---------------------------------------------------------------------------
// Scanner

interface HeaderRead {
  readonly file: string;
  /** Lowercase header name, or null when the name is computed at run time. */
  readonly name: string | null;
  /** The matched source text, used to key reviewed dynamic reads. */
  readonly expression: string;
}

const HEADERS_METHODS: ReadonlySet<string> = new Set([
  "append", "delete", "entries", "forEach", "get", "getAll", "getSetCookie", "has",
  "keys", "set", "values",
]);

const RECEIVER = "([A-Za-z_$][\\w$]*)";
// receiver?.get( / receiver.has( ; the argument runs to the matching paren.
const CALL_READ = new RegExp(`\\b${RECEIVER}(\\?)?\\.(get|has)\\(`, "gu");
// receiver["name"] or receiver?.[expression], never an assignment target
const BRACKET_READ = new RegExp(`\\b${RECEIVER}(\\?\\.)?\\[\\s*([^\\]\\n]+?)\\s*\\](?!\\s*=(?!=))`, "gu");
// .headers.name (Node incoming headers), never an assignment target
const PROPERTY_READ = /\.headers(\?)?\.([A-Za-z_$][\w$]*)\b(?!\s*=(?!=))(?!\s*\()/gu;
const STRING_LITERAL = /^(["'])([^"'\\]+)\1$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const EDGE_HEADERS_MEMBER = /^EDGE_HEADERS\.([A-Za-z_$][\w$]*)$/u;

function isHeadersReceiver(name: string): boolean {
  return /headers$/iu.test(name);
}

/** `const NAME = "literal"` declarations in one module, by name. */
function stringConstants(text: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(["'])([^"'\\]+)\2/gu,
  )) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) constants.set(name, value);
  }
  return constants;
}

function resolvedName(argument: string, constants: ReadonlyMap<string, string>): string | null {
  const literal = STRING_LITERAL.exec(argument);
  if (literal?.[2] !== undefined) return literal[2].toLowerCase();
  const member = EDGE_HEADERS_MEMBER.exec(argument);
  if (member?.[1] !== undefined && Object.hasOwn(EDGE_HEADERS, member[1])) {
    return (EDGE_HEADERS as Readonly<Record<string, string>>)[member[1]]!.toLowerCase();
  }
  if (IDENTIFIER.test(argument)) {
    const value = constants.get(argument);
    if (value !== undefined) return value.toLowerCase();
  }
  return null;
}

/** The text up to the parenthesis closing the one before `start`, or null. */
function callArgument(text: string, start: number): string | null {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index);
    }
  }
  return null;
}

function headerReads(file: string, text: string): HeaderRead[] {
  const constants = stringConstants(text);
  const reads: HeaderRead[] = [];
  for (const match of text.matchAll(CALL_READ)) {
    const [opening, receiver] = match;
    if (receiver === undefined || !isHeadersReceiver(receiver)) continue;
    const argumentStart = match.index + opening.length;
    const argument = callArgument(text, argumentStart);
    if (argument === null) {
      reads.push({ file, name: null, expression: opening });
      continue;
    }
    // A nested call or any computed argument stays unresolved (dynamic).
    reads.push({
      file,
      name: resolvedName(argument.trim(), constants),
      expression: `${opening}${argument})`,
    });
  }
  for (const match of text.matchAll(BRACKET_READ)) {
    const [expression, receiver, , argument] = match;
    if (receiver === undefined || argument === undefined || !isHeadersReceiver(receiver)) continue;
    reads.push({ file, name: resolvedName(argument, constants), expression });
  }
  for (const match of text.matchAll(PROPERTY_READ)) {
    const [expression, , property] = match;
    if (property === undefined || HEADERS_METHODS.has(property)) continue;
    reads.push({ file, name: property.toLowerCase(), expression });
  }
  return reads;
}

function allHeaderReads(sources: Readonly<Record<string, string>>): HeaderRead[] {
  return Object.entries(sources).flatMap(([file, text]) => headerReads(file, text));
}

function isReviewedDynamicRead(read: HeaderRead): boolean {
  return DYNAMIC_HEADER_READS.some((entry) =>
    entry.file === read.file && entry.expression === read.expression);
}

function violations(sources: Readonly<Record<string, string>>): string[] {
  const found: string[] = [];
  for (const read of allHeaderReads(sources)) {
    if (read.name === null) {
      if (!isReviewedDynamicRead(read)) {
        found.push(`${read.file}: unreviewed dynamic header read ${read.expression}`);
      }
      continue;
    }
    if (REQUEST_HEADER_CLASSES.has(read.name)) continue;
    const responseFiles = Object.hasOwn(RESPONSE_HEADER_READS, read.name)
      ? RESPONSE_HEADER_READS[read.name]!
      : [];
    if (responseFiles.includes(read.file)) continue;
    found.push(`${read.file}: unclassified header read '${read.name}'`);
  }
  return [...new Set(found)].sort();
}

function withInjected(file: string, snippet: string): Readonly<Record<string, string>> {
  const original = SOURCES[file];
  if (original === undefined) throw new Error(`missing source ${file}`);
  return { ...SOURCES, [file]: `${original}\n${snippet}\n` };
}

// ---------------------------------------------------------------------------

describe("edge request-header ratchet", () => {
  it("reads every src/**/*.ts and cloud-run/**/*.mjs module, recursively, and nothing excluded", () => {
    const files = Object.keys(SOURCES);
    for (const required of [
      "../src/admission.ts",
      "../src/admin-access.ts",
      "../src/edge-origin-proxy.ts",
      "../src/index.ts",
      "../src/session.ts",
      "../cloud-run/server.mjs",
      "../cloud-run/oauth-gateway.mjs",
      "../cloud-run/postgres-edge-origin-dispatch.mjs",
      "../cloud-run/routes/v11-day-manifests.mjs",
      "../cloud-run/routes/upload-authorizations.mjs",
      "../cloud-run/envelopes/v11.mjs",
    ]) {
      expect(files, required).toContain(required);
    }
    expect(files.some((file) => /^\.\.\/src\/[^/]+\/.+\.ts$/u.test(file)),
      "a nested src/**/ module").toBe(true);
    for (const file of files) {
      expect(file).toMatch(/^\.\.\/(?:src\/.+\.ts|cloud-run\/.+\.mjs)$/u);
      expect(file).not.toMatch(/node_modules|\/dist\/|\/vendor\/|\.check\.mjs$|\.spec\./u);
    }
  });

  it("finds the known request-header reads, so the scan is not vacuous", () => {
    const reads = allHeaderReads(SOURCES);
    const has = (file: string, name: string) =>
      reads.some((read) => read.file === file && read.name === name);
    expect(has("../src/admission.ts", "cf-connecting-ip")).toBe(true);
    expect(has("../src/session.ts", "x-usage-monitor-admin")).toBe(true);
    // Resolved through `const ACCESS_JWT_HEADER = "cf-access-jwt-assertion"`.
    expect(has("../src/admin-access.ts", "cf-access-jwt-assertion")).toBe(true);
    // Node property and bracket forms.
    expect(has("../cloud-run/server.mjs", "host")).toBe(true);
    expect(has("../cloud-run/server.mjs", "x-tibotattle-google-callback-query")).toBe(true);
    expect(has("../cloud-run/oauth-gateway.mjs", "transfer-encoding")).toBe(true);
    // Resolved through EDGE_HEADERS members.
    expect(has("../cloud-run/postgres-edge-origin-dispatch.mjs", "x-serverless-authorization"))
      .toBe(true);
    expect(has("../cloud-run/postgres-edge-origin-dispatch.mjs", "x-tibotattle-edge-admission"))
      .toBe(true);
    // An assignment is a write, not a read.
    expect(reads.some((read) => read.file === "../cloud-run/server.mjs"
      && read.name === "set-cookie")).toBe(false);
  });

  it("classifies every request-header name read in src and cloud-run", () => {
    expect(violations(SOURCES)).toStrictEqual([]);
  });

  it("keeps no stale reviewed entry", () => {
    const reads = allHeaderReads(SOURCES);
    for (const entry of DYNAMIC_HEADER_READS) {
      expect(reads.some((read) => read.name === null && read.file === entry.file
        && read.expression === entry.expression), `${entry.file} ${entry.expression}`).toBe(true);
    }
    for (const [name, files] of Object.entries(RESPONSE_HEADER_READS)) {
      expect(REQUEST_HEADER_CLASSES.has(name), `${name} is already a request class`).toBe(false);
      for (const file of files) {
        expect(reads.some((read) => read.file === file && read.name === name), `${file} ${name}`)
          .toBe(true);
      }
    }
  });

  it("fails an injected unclassified read in a src module, naming the file and header", () => {
    expect(violations(withInjected(
      "../src/index.ts",
      "const probe = request.headers.get(\"x-unclassified-probe\");",
    ))).toStrictEqual(["../src/index.ts: unclassified header read 'x-unclassified-probe'"]);
  });

  it("fails an injected unclassified read in a cloud-run/*.mjs module", () => {
    expect(violations(withInjected(
      "../cloud-run/server.mjs",
      "const probe = req.headers[\"x-unclassified-probe\"];",
    ))).toStrictEqual(["../cloud-run/server.mjs: unclassified header read 'x-unclassified-probe'"]);
    expect(violations(withInjected(
      "../cloud-run/postgres-test-dispatch.mjs",
      "const probe = req.headers.via;",
    ))).toStrictEqual(["../cloud-run/postgres-test-dispatch.mjs: unclassified header read 'via'"]);
  });

  it("fails an injected unclassified read in a cloud-run/routes/*.mjs module", () => {
    expect(violations(withInjected(
      "../cloud-run/routes/v11-day-manifests.mjs",
      "const probe = request.headers.has('X-Unclassified-Probe');",
    ))).toStrictEqual([
      "../cloud-run/routes/v11-day-manifests.mjs: unclassified header read 'x-unclassified-probe'",
    ]);
  });

  it("fails an unreviewed dynamic read, a constant-named read and a misplaced response-only name", () => {
    expect(violations(withInjected(
      "../src/session.ts",
      "const probe = request.headers.get(headerName);",
    ))).toStrictEqual([
      "../src/session.ts: unreviewed dynamic header read headers.get(headerName)",
    ]);
    expect(violations(withInjected(
      "../src/session.ts",
      "const PROBE_HEADER = \"x-forwarded-for\";\nconst probe = request.headers.get(PROBE_HEADER);",
    ))).toStrictEqual(["../src/session.ts: unclassified header read 'x-forwarded-for'"]);
    // 'link' is accepted only where it is a response read.
    expect(violations(withInjected(
      "../src/index.ts",
      "const probe = request.headers.get(\"link\");",
    ))).toStrictEqual(["../src/index.ts: unclassified header read 'link'"]);
  });

  it("ignores header writes", () => {
    expect(violations(withInjected(
      "../cloud-run/server.mjs",
      "headers[\"x-unclassified-probe\"] = \"1\";\nreq.headers.via = \"1\";",
    ))).toStrictEqual([]);
  });
});
