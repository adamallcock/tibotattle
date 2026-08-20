import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_ENTRY = join(ROOT, "apps", "local", "server.js");

// Static import specifiers only. A dynamic import built from a variable is
// not resolvable here and is not how this codebase composes the companion;
// the literal form is covered so a lazily loaded module cannot slip the net.
const STATIC_FROM = /(?:^|[\s;}])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function relativeSpecifiers(source) {
  return [
    ...[...source.matchAll(STATIC_FROM)].map((match) => match[1]),
    ...[...source.matchAll(BARE_IMPORT)].map((match) => match[1]),
    ...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]),
  ].filter((specifier) => specifier.startsWith("."));
}

function companionImportGraph() {
  const visited = new Map();
  const pending = [COMPANION_ENTRY];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      // A specifier this walker cannot resolve to a file on disk is reported
      // by the graph-integrity assertion below rather than skipped silently.
      visited.set(file, null);
      continue;
    }
    visited.set(file, source);
    for (const specifier of relativeSpecifiers(source)) {
      pending.push(resolve(dirname(file), specifier));
    }
  }
  return visited;
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/.*$/gm;

function codeLinesTouchingStdin(source) {
  return source
    .replace(BLOCK_COMMENT, "")
    .replace(LINE_COMMENT, "$1")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /process\s*\.\s*stdin/.test(line));
}

// A module the companion loads may name descriptor 0 in exactly one shape:
// handing it to a callee as an explicit argument, from the entry-guarded
// main() of a file that is also a standalone CLI. In that mode the process
// really does own descriptor 0 and no broker exists. Anything else — a
// parameter default, a module-scope read, an `isTTY` probe — is the silent
// breakage this file exists to catch, so it must fail here rather than in a
// user's pairing ceremony.
const PERMITTED_STDIN_LINES = new Map([
  ["src/claude-statusline.js", ["await runClaudeStatusline({ stdin: process.stdin });"]],
]);

/**
 * Descriptor 0 belongs to the Keychain broker, not to standard input.
 *
 * When the signed macOS app spawns the companion it dup2's its end of a
 * private socketpair onto descriptor 0 and announces only that number
 * (apps/macos/Sources/KeychainBroker.swift). Node's `process.stdin` is a lazy
 * getter that constructs a stream over descriptor 0 on first access, so any
 * module the companion loads that so much as evaluates it would start reading
 * the broker's wire — stealing responses, desynchronising the strict in-order
 * protocol, and poisoning the transport permanently. The failure is silent:
 * credential minting simply stops working, with no dialog and no crash.
 *
 * One careless `process.stdin.isTTY` anywhere in these modules is enough, so
 * the reference itself is what this test forbids, not any particular use of
 * it. A process that genuinely owns descriptor 0 — a CLI entry point run
 * directly — may still read it; it just must not do so from a module the
 * companion pulls in.
 */
test("nothing reachable from the companion entry point touches process.stdin", () => {
  const graph = companionImportGraph();
  const unreadable = [...graph]
    .filter(([, source]) => source === null)
    .map(([file]) => relative(ROOT, file));
  assert.deepEqual(unreadable, [], "every relative import must resolve to a file");
  // A collapsed graph would make the assertion below vacuously true.
  assert.equal(graph.size > 100, true, `graph unexpectedly small: ${graph.size}`);
  assert.equal(graph.has(COMPANION_ENTRY), true);

  const found = new Map();
  for (const [file, source] of graph) {
    const lines = codeLinesTouchingStdin(source);
    if (lines.length > 0) found.set(relative(ROOT, file), lines);
  }
  for (const [file, lines] of found) {
    assert.deepEqual(
      lines,
      PERMITTED_STDIN_LINES.get(file) ?? [],
      `${file} is reachable from apps/local/server.js, whose descriptor 0 is `
        + "the app's Keychain broker channel; take stdin as an argument "
        + "instead of reading process.stdin",
    );
  }
  // A permitted entry that no longer applies must be removed, not left to rot
  // into a licence for a future reference in the same file.
  assert.deepEqual(
    [...PERMITTED_STDIN_LINES.keys()].filter((file) => !found.has(file)),
    [],
    "stale permitted-stdin entry",
  );
});

test("the broker announcement never crosses into a spawned child's environment", async () => {
  // The announcement names a descriptor in the companion's own process. A
  // child's descriptor 0 is something else entirely, so an inherited
  // announcement points at an unrelated file: no secret escapes, but anything
  // downstream that trusts the variable would be reading the wrong thing.
  const { codexAppServerChildEnv } = await import(
    "../src/providers/codex/app-server.js"
  );
  const { ccusageChildEnv } = await import("../src/ccusage.js");
  const announced = Object.freeze({
    PATH: "/usr/bin",
    USAGE_MONITOR_KEYCHAIN_BROKER_FD: "0",
    APP_USAGEMONITOR_ACCOUNT_HMAC_KEY: "private-hmac-key",
  });
  for (const build of [codexAppServerChildEnv, ccusageChildEnv]) {
    const childEnvironment = build(announced);
    assert.equal(
      Object.hasOwn(childEnvironment, "USAGE_MONITOR_KEYCHAIN_BROKER_FD"),
      false,
      build.name,
    );
    assert.equal(childEnvironment.PATH, "/usr/bin", build.name);
  }
  // The account HMAC key stays stripped from the Codex child alongside it.
  assert.equal(
    Object.hasOwn(
      codexAppServerChildEnv(announced),
      "APP_USAGEMONITOR_ACCOUNT_HMAC_KEY",
    ),
    false,
  );
});
