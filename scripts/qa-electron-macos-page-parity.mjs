#!/usr/bin/env node

/**
 * Targeted, development-only rendered QA for a frozen arm64 macOS Electron
 * bundle. It deliberately covers only page states left outside the broad smoke
 * and uses a new content-free synthetic profile. It never opens a Codex link,
 * starts hosted sharing, changes host settings, or writes into the bundle.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_NAME = "TiboTattle Dev";
const RECEIPT_SCHEMA_VERSION = "tibotattle-electron-macos-page-parity-qa-v2";
const NATIVE_TRAY_RECEIPT_SCHEMA_VERSION = "tibotattle-electron-macos-native-tray-qa-v1";
const NATIVE_CUA_HANDOFF_SCHEMA_VERSION = "tibotattle-electron-macos-native-cua-handoff-v1";
const TEST_LANE = "macos-electron-local-qa-v1";
const SMOKE_CONTROL = "quit-v1";
const STARTUP_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
// Native CUA interaction is operator-paced; keep its bounded window separate
// from the unchanged startup and app-operation deadlines.
const NATIVE_HANDOFF_TIMEOUT_MS = 5 * 60_000;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const CACHE_LINK_FIXTURE = Object.freeze({
  parent: "10000000-0000-4000-8000-000000000001",
  ordinary: "10000000-0000-4000-8000-000000000002",
  worker: "10000000-0000-4000-8000-000000000003",
  autoReview: "10000000-0000-4000-8000-000000000004",
  unavailableAutoReview: "10000000-0000-4000-8000-000000000005",
  unavailableParent: "10000000-0000-4000-8000-000000000006",
});

export const PAGE_PARITY_STATUSES = Object.freeze(["passed", "failed", "incomplete"]);
export const PAGE_PARITY_FAILURE_STAGES = Object.freeze([
  "contract", "launch", "dashboard", "pages", "cache_links", "settings", "quit",
]);
export const PAGE_PARITY_FAILURE_REASONS = Object.freeze([
  "arguments_invalid", "source_identity_invalid", "artifact_identity_invalid",
  "app_contract_invalid", "launch_failed", "remote_debugging_unavailable",
  "dashboard_target_unavailable", "dashboard_unavailable", "external_request_observed",
  "page_route_invalid", "page_render_invalid", "cache_renderer_unavailable",
  "cache_links_invalid", "settings_target_unavailable", "settings_render_invalid",
  "language_persistence_invalid", "clean_quit_invalid", "runtime_failed",
]);

const FAILURE_BY_STAGE = Object.freeze({
  contract: "app_contract_invalid",
  launch: "launch_failed",
  dashboard: "dashboard_unavailable",
  pages: "page_render_invalid",
  cache_links: "cache_renderer_unavailable",
  settings: "settings_render_invalid",
  quit: "clean_quit_invalid",
});

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asBoolean(value) {
  return value === true;
}

function sourceIdentity(sourceRevision, artifactSha256, artifactIdentityBound) {
  return Object.freeze({
    source: Object.freeze({
      revision: SOURCE_REVISION_PATTERN.test(sourceRevision ?? "") ? sourceRevision : null,
      identified: SOURCE_REVISION_PATTERN.test(sourceRevision ?? ""),
    }),
    artifact: Object.freeze({
      sha256: artifactIdentityBound === true && SHA256_PATTERN.test(artifactSha256 ?? "")
        ? artifactSha256
        : null,
      identityBound: artifactIdentityBound === true && SHA256_PATTERN.test(artifactSha256 ?? ""),
    }),
  });
}

function normalizedScreenshots(value) {
  const result = {};
  for (const key of ["overview", "allowance", "trends", "usage", "cacheLinks", "settingsGeneral", "settingsNotifications", "settingsAbout"]) {
    const digest = value?.[key];
    result[key] = SHA256_PATTERN.test(digest ?? "") ? digest : null;
  }
  return Object.freeze(result);
}

function normalizedPages(value) {
  const page = (key) => Object.freeze({
    route: asBoolean(value?.[key]?.route),
    activeNav: asBoolean(value?.[key]?.activeNav),
    visible: asBoolean(value?.[key]?.visible),
    surface: ["chart", "empty", "data"].includes(value?.[key]?.surface)
      ? value[key].surface
      : "unknown",
    refreshState: ["initial_refresh", "fresh"].includes(value?.[key]?.refreshState)
      ? value[key].refreshState
      : "unknown",
  });
  return Object.freeze({ overview: page("overview"), allowance: page("allowance"), trends: page("trends"), usage: page("usage") });
}

function normalizedCacheLinks(value) {
  return Object.freeze({
    renderedInPackagedDashboard: asBoolean(value?.renderedInPackagedDashboard),
    normalPackagedDataFlow: asBoolean(value?.normalPackagedDataFlow),
    ordinaryLink: asBoolean(value?.ordinaryLink),
    workerParentAndChild: asBoolean(value?.workerParentAndChild),
    autoReviewParentOnly: asBoolean(value?.autoReviewParentOnly),
    unavailableAutoReview: asBoolean(value?.unavailableAutoReview),
    canonicalTargetsOnly: asBoolean(value?.canonicalTargetsOnly),
    linksActivated: false,
  });
}

function normalizedSettings(value) {
  const simple = (key) => Object.freeze({
    panelVisible: asBoolean(value?.[key]?.panelVisible),
    contentPresent: asBoolean(value?.[key]?.contentPresent),
  });
  return Object.freeze({
    language: Object.freeze({
      selected: asBoolean(value?.language?.selected),
      dashboardLocalized: asBoolean(value?.language?.dashboardLocalized),
      restored: asBoolean(value?.language?.restored),
    }),
    general: simple("general"),
    notifications: simple("notifications"),
    about: simple("about"),
  });
}

function normalizedNativeTray(value) {
  const unavailable = value?.status === "unavailable";
  return Object.freeze({
    status: value?.status === "passed" ? "passed" : unavailable ? "unavailable" : "not_run",
    reason: unavailable && value?.reason === "cua_bridge_unavailable"
      ? "cua_bridge_unavailable"
      : null,
  });
}

function normalizedNativeTrayEvidence(value) {
  if (value?.status === "passed") {
    return Object.freeze({
      status: "passed",
      iconVisible: value.iconVisible === true,
      primaryPopupVisible: value.primaryPopupVisible === true,
      secondaryMenuVisible: value.secondaryMenuVisible === true,
      mutuallyExclusive: value.mutuallyExclusive === true,
      dismissedAndReopened: value.dismissedAndReopened === true,
      reason: null,
    });
  }
  const unavailable = value?.status === "unavailable";
  return Object.freeze({
    status: unavailable ? "unavailable" : "not_run",
    iconVisible: false,
    primaryPopupVisible: false,
    secondaryMenuVisible: false,
    mutuallyExclusive: false,
    dismissedAndReopened: false,
    reason: unavailable && ["cua_bridge_unavailable", "native_surface_ambiguous", "native_interaction_incomplete"].includes(value?.reason)
      ? value.reason
      : null,
  });
}

function pagesPassed(pages) {
  return Object.values(pages).every((page) => page.route && page.activeNav && page.visible && page.surface !== "unknown");
}

function settingsPassed(settings) {
  return settings.language.selected && settings.language.dashboardLocalized && settings.language.restored
    && Object.values({ general: settings.general, notifications: settings.notifications, about: settings.about })
      .every((panel) => panel.panelVisible && panel.contentPresent);
}

function cacheLinksPassed(cacheLinks) {
  return cacheLinks.renderedInPackagedDashboard
    && cacheLinks.normalPackagedDataFlow
    && cacheLinks.ordinaryLink
    && cacheLinks.workerParentAndChild
    && cacheLinks.autoReviewParentOnly
    && cacheLinks.unavailableAutoReview
    && cacheLinks.canonicalTargetsOnly
    && cacheLinks.linksActivated === false;
}

/** Build only fixed, content-free evidence; paths, renderer copy and raw errors are omitted. */
export function buildClosedPageParityReceipt({
  requestedStatus = "failed",
  sourceRevision = null,
  artifactSha256 = null,
  artifactIdentityBound = false,
  cleanQuit = false,
  loopbackOnly = false,
  pages = {},
  cacheLinks = {},
  settings = {},
  nativeTray = {},
  screenshots = {},
  failureStage = null,
  failureReason = null,
} = {}) {
  const identity = sourceIdentity(sourceRevision, artifactSha256, artifactIdentityBound);
  const closedPages = normalizedPages(pages);
  const closedCacheLinks = normalizedCacheLinks(cacheLinks);
  const closedSettings = normalizedSettings(settings);
  const closedNativeTray = normalizedNativeTray(nativeTray);
  const browserPassed = identity.source.identified
    && identity.artifact.identityBound
    && cleanQuit === true
    && loopbackOnly === true
    && pagesPassed(closedPages)
    && cacheLinksPassed(closedCacheLinks)
    && settingsPassed(closedSettings);
  const requested = PAGE_PARITY_STATUSES.includes(requestedStatus) ? requestedStatus : "failed";
  const status = requested === "failed" || !browserPassed
    ? "failed"
    : closedNativeTray.status === "passed"
      ? "passed"
      : "incomplete";
  const stage = status === "failed" && PAGE_PARITY_FAILURE_STAGES.includes(failureStage)
    ? failureStage
    : null;
  const reason = status === "failed"
    ? (PAGE_PARITY_FAILURE_REASONS.includes(failureReason)
      ? failureReason
      : FAILURE_BY_STAGE[stage ?? "launch"])
    : null;
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status,
    target: "darwin-arm64-electron-app",
    qualification: "development-only-supplemental",
    ...identity,
    contentFree: true,
    cleanQuit: cleanQuit === true,
    loopbackOnly: loopbackOnly === true,
    pages: closedPages,
    cacheLinks: closedCacheLinks,
    settings: closedSettings,
    nativeTray: closedNativeTray,
    screenshots: normalizedScreenshots(screenshots),
    failureStage: stage,
    failureReason: reason,
  });
}

/** A separate, content-free receipt for the physical menu-bar interaction. */
export function buildClosedNativeTrayReceipt({
  requestedStatus = "failed",
  sourceRevision = null,
  artifactSha256 = null,
  artifactIdentityBound = false,
  dashboardReady = false,
  handoffAcknowledged = false,
  cleanQuit = false,
  loopbackOnly = false,
  nativeTray = {},
  failureStage = null,
  failureReason = null,
} = {}) {
  const identity = sourceIdentity(sourceRevision, artifactSha256, artifactIdentityBound);
  const tray = normalizedNativeTrayEvidence(nativeTray);
  const interactionsPassed = tray.status === "passed"
    && tray.iconVisible && tray.primaryPopupVisible && tray.secondaryMenuVisible
    && tray.mutuallyExclusive && tray.dismissedAndReopened;
  const basePassed = identity.source.identified && identity.artifact.identityBound
    && dashboardReady === true && handoffAcknowledged === true
    && cleanQuit === true && loopbackOnly === true;
  const requested = PAGE_PARITY_STATUSES.includes(requestedStatus) ? requestedStatus : "failed";
  const status = requested === "failed" || !basePassed
    ? "failed"
    : interactionsPassed ? "passed" : "incomplete";
  const acceptedStage = failureStage === "native_handoff" ? failureStage : null;
  const acceptedReason = ["native_cua_handoff_timeout", "native_cua_handoff_invalid", "runtime_failed"].includes(failureReason)
    ? failureReason
    : acceptedStage === "native_handoff" ? "native_cua_handoff_invalid" : "runtime_failed";
  return Object.freeze({
    schemaVersion: NATIVE_TRAY_RECEIPT_SCHEMA_VERSION,
    status,
    target: "darwin-arm64-electron-app",
    qualification: "development-only-supplemental-native-ui",
    ...identity,
    contentFree: true,
    dashboardReady: dashboardReady === true,
    handoffAcknowledged: handoffAcknowledged === true,
    cleanQuit: cleanQuit === true,
    loopbackOnly: loopbackOnly === true,
    nativeTray: tray,
    failureStage: status === "failed" ? acceptedStage : null,
    failureReason: status === "failed" ? acceptedReason : null,
  });
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && typeof args[index + 1] === "string" && args[index + 1].length > 0
    ? args[index + 1]
    : null;
}

export function parsePageParityArguments(args = process.argv.slice(2)) {
  const appPath = optionValue(args, "--app");
  const sourceRoot = optionValue(args, "--source-root");
  const receiptPath = optionValue(args, "--receipt");
  const screenshotsDirectory = optionValue(args, "--screenshots-dir");
  const sourceRevision = optionValue(args, "--source-revision");
  const artifactSha256 = optionValue(args, "--artifact-sha256");
  const nativeCuaHandoffDirectory = optionValue(args, "--native-cua-handoff-dir");
  if (![appPath, sourceRoot, receiptPath, screenshotsDirectory].every((value) => value !== null)
      || !SOURCE_REVISION_PATTERN.test(sourceRevision ?? "")
      || !SHA256_PATTERN.test(artifactSha256 ?? "")) {
    throw fixedError("arguments_invalid", "contract");
  }
  return Object.freeze({
    appPath: resolve(appPath),
    sourceRoot: resolve(sourceRoot),
    receiptPath: resolve(receiptPath),
    screenshotsDirectory: resolve(screenshotsDirectory),
    sourceRevision,
    artifactSha256,
    nativeCuaHandoffDirectory: nativeCuaHandoffDirectory === null
      ? null
      : resolve(nativeCuaHandoffDirectory),
  });
}

function fixedError(reason, stage) {
  const error = new Error(reason);
  error.reason = PAGE_PARITY_FAILURE_REASONS.includes(reason) ? reason : "runtime_failed";
  error.stage = PAGE_PARITY_FAILURE_STAGES.includes(stage) ? stage : "launch";
  return error;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function withTimeout(promise, timeoutMs, reason, stage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fixedError(reason, stage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, timeoutMs, reason, stage) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.reason) throw error;
    }
    await wait(100);
  }
  throw fixedError(reason, stage);
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address()?.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw fixedError("launch_failed", "launch");
  return port;
}

async function jsonFetch(url, reason, stage) {
  return withTimeout(fetch(url, { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw fixedError(reason, stage);
    return response.json();
  }), OPERATION_TIMEOUT_MS, reason, stage);
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(fixedError("dashboard_unavailable", "dashboard")), { once: true });
  }), OPERATION_TIMEOUT_MS, "dashboard_unavailable", "dashboard");
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!Number.isInteger(message.id)) {
      for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(fixedError("dashboard_unavailable", "dashboard"));
    else entry.resolve(message.result ?? {});
  });
  const request = (method, params = {}) => {
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => pending.set(id, { resolve: resolveRequest, reject: rejectRequest }));
    try { socket.send(JSON.stringify({ id, method, params })); } catch {
      pending.delete(id);
      throw fixedError("dashboard_unavailable", "dashboard");
    }
    return withTimeout(promise, OPERATION_TIMEOUT_MS, "dashboard_unavailable", "dashboard");
  };
  return Object.freeze({
    request,
    async evaluate(expression) {
      const response = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw fixedError("dashboard_unavailable", "dashboard");
      return response.result?.value;
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(method);
      };
    },
    close() {
      try { socket.close(); } catch {}
      for (const entry of pending.values()) entry.reject(fixedError("dashboard_unavailable", "dashboard"));
      pending.clear();
      handlers.clear();
    },
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertArtifact(args) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw fixedError("app_contract_invalid", "contract");
  const executable = join(args.appPath, "Contents", "MacOS", APP_NAME);
  const asar = join(args.appPath, "Contents", "Resources", "app.asar");
  const [appInfo, executableInfo, asarInfo] = await Promise.all([
    stat(args.appPath).catch(() => null), stat(executable).catch(() => null), stat(asar).catch(() => null),
  ]);
  if (!appInfo?.isDirectory() || !executableInfo?.isFile() || !asarInfo?.isFile()) throw fixedError("app_contract_invalid", "contract");
  const sourceHead = String(execFileSync("git", ["-C", args.sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
  if (sourceHead !== args.sourceRevision) throw fixedError("source_identity_invalid", "contract");
  if (await sha256File(asar) !== args.artifactSha256) throw fixedError("artifact_identity_invalid", "contract");
  return executable;
}

async function ensureFreshDestination(args) {
  await mkdir(dirname(args.receiptPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(args.receiptPath), 0o700).catch(() => {});
  if (await stat(args.receiptPath).then(() => true).catch(() => false)) throw fixedError("arguments_invalid", "contract");
  await mkdir(args.screenshotsDirectory, { recursive: true, mode: 0o700 });
  await chmod(args.screenshotsDirectory, 0o700).catch(() => {});
  if ((await readdir(args.screenshotsDirectory)).length !== 0) throw fixedError("arguments_invalid", "contract");
}

/** Publish a complete receipt once; a concurrent final destination is never replaced. */
export async function writeReceipt(destination, receipt) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await stat(destination).then(() => true).catch(() => false)) {
    throw fixedError("arguments_invalid", "contract");
  }
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryWritten = false;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    temporaryWritten = true;
    await chmod(temporary, 0o600).catch(() => {});
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code === "EEXIST") throw fixedError("arguments_invalid", "contract");
      throw error;
    }
  } finally {
    if (temporaryWritten) await unlink(temporary).catch(() => {});
  }
}

async function captureScreenshot(cdp, outputDirectory, key) {
  const capture = await cdp.request("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const png = Buffer.from(capture.data, "base64");
  await writeFile(join(outputDirectory, `${key}.png`), png, { mode: 0o600, flag: "wx" });
  return createHash("sha256").update(png).digest("hex");
}

function syntheticUsage(inputTokens, cachedInputTokens, outputTokens) {
  return Object.freeze({
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: inputTokens + outputTokens,
  });
}

function rolloutFileName(atMs, id) {
  const stamp = new Date(atMs).toISOString()
    .replace(/:/gu, "-")
    .replace(/\.\d{3}Z$/u, "");
  return `rollout-${stamp}-${id}.jsonl`;
}

function syntheticCacheRollout({ id, parentId = null, autoReview = false, index, nowMs }) {
  const firstAt = nowMs - (180_000 + index * 20_000);
  const secondAt = firstAt + 60_000;
  const first = syntheticUsage(1_000, 1_000, 1);
  const secondLast = syntheticUsage(1_200, 0, 1);
  const secondTotal = syntheticUsage(2_200, 1_000, 2);
  const sessionSource = autoReview
    ? { subagent: { other: "guardian" } }
    : undefined;
  const metadata = {
    id,
    session_id: id,
    thread_source: autoReview ? "guardian_review" : "user",
    ...(parentId === null ? {} : { parent_thread_id: parentId }),
    ...(sessionSource === undefined ? {} : { source: sessionSource }),
  };
  const count = (timestamp, total, last) => ({
    timestamp: new Date(timestamp).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  });
  return Object.freeze({
    fileName: rolloutFileName(firstAt - 1_000, id),
    lines: Object.freeze([
      { timestamp: new Date(firstAt - 1_000).toISOString(), type: "session_meta", payload: metadata },
      { timestamp: new Date(firstAt).toISOString(), type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "low" } },
      count(firstAt + 1_000, first, first),
      { timestamp: new Date(secondAt).toISOString(), type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
      count(secondAt + 1_000, secondTotal, secondLast),
    ]),
  });
}

/**
 * Seed only the disposable smoke profile.  The packaged app still discovers
 * these ordinary rollout files, rebuilds its own index, serves its own
 * loopback lookup, and renders the real cache table; this helper never
 * changes a dashboard response or the renderer DOM.
 */
export async function seedSyntheticCacheLinkSources(fixture, { nowMs = Date.now() } = {}) {
  if (!isPlainRecord(fixture)
      || typeof fixture.codexHome !== "string"
      || !Number.isSafeInteger(nowMs)) {
    throw fixedError("arguments_invalid", "contract");
  }
  const sessions = join(fixture.codexHome, "sessions");
  const rollouts = [
    syntheticCacheRollout({ id: CACHE_LINK_FIXTURE.ordinary, index: 0, nowMs }),
    syntheticCacheRollout({ id: CACHE_LINK_FIXTURE.worker, index: 1, nowMs }),
    syntheticCacheRollout({
      id: CACHE_LINK_FIXTURE.autoReview,
      parentId: CACHE_LINK_FIXTURE.parent,
      autoReview: true,
      index: 2,
      nowMs,
    }),
    syntheticCacheRollout({
      id: CACHE_LINK_FIXTURE.unavailableAutoReview,
      parentId: CACHE_LINK_FIXTURE.unavailableParent,
      autoReview: true,
      index: 3,
      nowMs,
    }),
  ];
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const rolloutPaths = new Map(rollouts.map((rollout) => [
    rollout.fileName,
    join(sessions, rollout.fileName),
  ]));
  await Promise.all(rollouts.map(async (rollout) => {
    const file = rolloutPaths.get(rollout.fileName);
    await writeFile(file, `${rollout.lines.map((line) => JSON.stringify(line)).join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(file, 0o600);
  }));

  const databaseFile = join(fixture.codexHome, "state_5.sqlite");
  let database;
  try {
    database = new DatabaseSync(databaseFile);
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      source TEXT,
      thread_source TEXT,
      agent_nickname TEXT,
      rollout_path TEXT
    ) STRICT;`);
    const insert = database.prepare(`INSERT INTO threads(
      id, name, source, thread_source, agent_nickname, rollout_path
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(CACHE_LINK_FIXTURE.parent, "Synthetic parent", '"cli"', "user", null, null);
    insert.run(CACHE_LINK_FIXTURE.ordinary, "Synthetic ordinary", '"cli"', "user", null, null);
    insert.run(
      CACHE_LINK_FIXTURE.worker,
      null,
      JSON.stringify({ subagent: { thread_spawn: {
        parent_thread_id: CACHE_LINK_FIXTURE.parent,
        agent_nickname: "Synthetic worker",
      } } }),
      "subagent",
      "Synthetic worker",
      null,
    );
    for (const id of [CACHE_LINK_FIXTURE.autoReview, CACHE_LINK_FIXTURE.unavailableAutoReview]) {
      const rollout = rollouts.find((candidate) => candidate.lines[0].payload.id === id);
      insert.run(
        id,
        null,
        JSON.stringify({ subagent: { other: "guardian" } }),
        "guardian_review",
        null,
        rolloutPaths.get(rollout.fileName),
      );
    }
  } finally {
    database?.close();
  }
  await chmod(databaseFile, 0o600);
  const names = [
    { id: CACHE_LINK_FIXTURE.parent, thread_name: "Synthetic parent", updated_at: "2026-09-08T00:00:00.000Z" },
    { id: CACHE_LINK_FIXTURE.ordinary, thread_name: "Synthetic ordinary", updated_at: "2026-09-08T00:00:00.000Z" },
  ];
  const namesFile = join(fixture.codexHome, "session_index.jsonl");
  await writeFile(namesFile, `${names.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(namesFile, 0o600);
  return Object.freeze({ status: "seeded", caseCount: rollouts.length });
}

function pageExpression({ nav, page, heading, primary, secondary, surface }) {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const nav = document.querySelector(${JSON.stringify(`[data-nav="${nav}"]`)});
    nav?.click();
    const page = document.querySelector(${JSON.stringify(page)});
    const primary = document.querySelector(${JSON.stringify(primary)});
    const secondary = document.querySelector(${JSON.stringify(secondary)});
    const heading = document.querySelector(${JSON.stringify(heading)});
    return {
      route: location.hash === ${JSON.stringify(`#${page.slice(1)}`)},
      activeNav: nav?.classList.contains("active") === true && nav?.getAttribute("aria-current") === "page",
      visible: visible(page) && page?.inert !== true,
      heading: visible(heading) && (heading?.textContent?.trim().length ?? 0) > 0,
      surface: visible(primary) ? ${JSON.stringify(surface.chart)} : visible(secondary) ? ${JSON.stringify(surface.empty)} : "unknown",
    };
  })()`;
}

async function inspectPage(cdp, spec, screenshots, outputDirectory, refreshState) {
  const snapshot = await waitFor(async () => {
    const value = await cdp.evaluate(pageExpression(spec));
    return value?.route && value.activeNav && value.visible && value.heading && value.surface !== "unknown" ? value : null;
  }, OPERATION_TIMEOUT_MS, "page_route_invalid", "pages");
  screenshots[spec.key] = await captureScreenshot(cdp, outputDirectory, spec.key);
  return Object.freeze({
    route: true,
    activeNav: true,
    visible: true,
    surface: snapshot.surface,
    refreshState,
  });
}

async function refreshPresentationState(origin) {
  const status = await jsonFetch(new URL("/api/local/refresh", origin), "page_render_invalid", "pages");
  const value = status?.refresh?.status;
  if (value === "succeeded") return "fresh";
  if (value === "running" || value === "cancelling") return "initial_refresh";
  return "unknown";
}

function packagedCacheLinksExpression() {
  const ids = JSON.stringify(CACHE_LINK_FIXTURE);
  return `(() => {
    const ids = ${ids};
    const details = document.querySelector("#cache-switch-details");
    const body = document.querySelector("#cache-switch-rows");
    if (!details || !body || details.hidden) return null;
    details.open = true;
    details.scrollIntoView({ block: "start" });
    const rows = [...body.querySelectorAll("tr")];
    const links = [...body.querySelectorAll("a.cache-drop-thread-link")];
    const href = (id) => "codex://threads/" + id;
    const rowFor = (id) => rows.find((row) => [...row.querySelectorAll("a.cache-drop-thread-link")]
      .some((link) => link.getAttribute("href") === href(id))) ?? null;
    const ordinary = rowFor(ids.ordinary);
    const worker = rowFor(ids.worker);
    const review = rows.find((row) => row.textContent.includes("Auto review")
      && [...row.querySelectorAll("a.cache-drop-thread-link")]
        .some((link) => link.getAttribute("href") === href(ids.parent))) ?? null;
    const unavailable = rows.find((row) => row.textContent.includes("Auto review")
      && row.querySelectorAll("a.cache-drop-thread-link").length === 0
      && row.querySelector(".cache-drop-thread-unavailable") !== null) ?? null;
    const canonical = links.length === 4 && links.every((link) =>
      /^codex:\\/\\/threads\\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(link.getAttribute("href") ?? ""));
    return {
      renderedInPackagedDashboard: document.body.contains(details) && details.open,
      normalPackagedDataFlow: rows.length >= 4,
      ordinaryLink: ordinary?.querySelectorAll("a.cache-drop-thread-link").length === 1,
      workerParentAndChild: worker?.querySelectorAll("a.cache-drop-thread-link").length === 2
        && worker?.querySelector(".cache-drop-subworker") !== null
        && [...worker.querySelectorAll("a.cache-drop-thread-link")]
          .some((link) => link.getAttribute("href") === href(ids.parent)),
      autoReviewParentOnly: review?.querySelectorAll("a.cache-drop-thread-link").length === 1
        && review?.querySelector(".cache-drop-subworker") !== null,
      unavailableAutoReview: unavailable !== null,
      canonicalTargetsOnly: canonical,
    };
  })()`;
}

async function inspectPackagedCacheLinks(cdp) {
  const result = await waitFor(async () => {
    const value = await cdp.evaluate(packagedCacheLinksExpression());
    return isPlainRecord(value) && cacheLinksPassed(normalizedCacheLinks(value))
      ? value
      : null;
  }, STARTUP_TIMEOUT_MS, "cache_links_invalid", "cache_links");
  return result;
}

async function openSettings(cdp, port, origin, smoke) {
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector("#electron-settings-button");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw fixedError("settings_target_unavailable", "settings");
  const target = await waitFor(async () => {
    const targets = await jsonFetch(`http://127.0.0.1:${port}/json`, "settings_target_unavailable", "settings");
    return smoke.selectMacSettingsTarget(targets, origin, port);
  }, STARTUP_TIMEOUT_MS, "settings_target_unavailable", "settings");
  const settings = await connectCdp(target);
  await settings.request("Page.enable");
  await waitFor(async () => {
    const value = await settings.evaluate(`(() => document.title === "TiboTattle Settings"
      && document.querySelector("#settings-bridge-status")?.classList.contains("is-ready") === true)()`);
    return value === true;
  }, STARTUP_TIMEOUT_MS, "settings_render_invalid", "settings");
  return settings;
}

function settingsPanelExpression(tab, panel, extraSelectors) {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    document.querySelector(${JSON.stringify(`[data-settings-tab="${tab}"]`)})?.click();
    const panel = document.querySelector(${JSON.stringify(`[data-settings-panel="${panel}"]`)});
    const heading = panel?.querySelector("h2");
    const required = ${JSON.stringify(extraSelectors)}.every((selector) => panel?.querySelector(selector) !== null);
    return visible(panel) && (heading?.textContent?.trim().length ?? 0) > 0 && required;
  })()`;
}

async function runSettingsJourney({ cdp, port, origin, smoke, screenshots, outputDirectory }) {
  const settings = await openSettings(cdp, port, origin, smoke);
  try {
    const general = await waitFor(async () => {
      const value = await settings.evaluate(settingsPanelExpression("general", "general", ["#settings-language", "#settings-appearance", "#settings-start-at-login"]));
      return value === true;
    }, OPERATION_TIMEOUT_MS, "settings_render_invalid", "settings");
    if (general !== true) throw fixedError("settings_render_invalid", "settings");
    const selected = await settings.evaluate(`(() => {
      const select = document.querySelector("#settings-language");
      if (!select || select.disabled) return false;
      select.value = "es";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value === "es";
    })()`);
    if (selected !== true) throw fixedError("language_persistence_invalid", "settings");
    await waitFor(async () => settings.evaluate(`(async () => {
      const value = await globalThis.tibotattleDesktop?.getSettings?.();
      return value?.settings?.language === "es" && document.documentElement.lang.toLowerCase().startsWith("es");
    })()`), OPERATION_TIMEOUT_MS, "language_persistence_invalid", "settings");
    await waitFor(async () => cdp.evaluate(`(() => document.documentElement.lang.toLowerCase().startsWith("es"))()`), OPERATION_TIMEOUT_MS, "language_persistence_invalid", "settings");
    screenshots.settingsGeneral = await captureScreenshot(settings, outputDirectory, "settings-general-es");

    const notifications = await waitFor(async () => settings.evaluate(settingsPanelExpression("notifications", "notifications", ["#settings-notifications-enabled", "#settings-open-notification-settings", "#settings-notification-status"])), OPERATION_TIMEOUT_MS, "settings_render_invalid", "settings");
    if (notifications !== true) throw fixedError("settings_render_invalid", "settings");
    screenshots.settingsNotifications = await captureScreenshot(settings, outputDirectory, "settings-notifications");

    const about = await waitFor(async () => settings.evaluate(settingsPanelExpression("about", "about", ["#settings-version", "#settings-build", "#settings-updates-status"])), OPERATION_TIMEOUT_MS, "settings_render_invalid", "settings");
    if (about !== true) throw fixedError("settings_render_invalid", "settings");
    screenshots.settingsAbout = await captureScreenshot(settings, outputDirectory, "settings-about");

    const restored = await settings.evaluate(`(() => {
      const select = document.querySelector("#settings-language");
      if (!select || select.disabled) return false;
      select.value = "system";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value === "system";
    })()`);
    if (restored !== true) throw fixedError("language_persistence_invalid", "settings");
    await waitFor(async () => settings.evaluate(`(async () => {
      const value = await globalThis.tibotattleDesktop?.getSettings?.();
      return value?.settings?.language === "system" && !document.documentElement.lang.toLowerCase().startsWith("es");
    })()`), OPERATION_TIMEOUT_MS, "language_persistence_invalid", "settings");
    await waitFor(async () => cdp.evaluate(`(() => !document.documentElement.lang.toLowerCase().startsWith("es"))()`), OPERATION_TIMEOUT_MS, "language_persistence_invalid", "settings");
    return Object.freeze({
      language: { selected: true, dashboardLocalized: true, restored: true },
      general: { panelVisible: true, contentPresent: true },
      notifications: { panelVisible: true, contentPresent: true },
      about: { panelVisible: true, contentPresent: true },
    });
  } finally {
    try { await settings.evaluate("window.close(); true"); } catch {}
    settings.close();
  }
}

function descendantsOf(parentPid) {
  try {
    const rows = String(execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const children = new Map();
    for (const line of rows.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const pid = Number(match[1]); const ppid = Number(match[2]);
      const list = children.get(ppid) ?? []; list.push(pid); children.set(ppid, list);
    }
    const result = []; const pending = [...(children.get(parentPid) ?? [])];
    while (pending.length > 0) { const pid = pending.shift(); result.push(pid); pending.push(...(children.get(pid) ?? [])); }
    return result;
  } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

async function cleanQuit(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) throw fixedError("clean_quit_invalid", "quit");
  const descendants = descendantsOf(child.pid);
  if (!Array.isArray(descendants) || descendants.length === 0) throw fixedError("clean_quit_invalid", "quit");
  const exit = once(child, "exit");
  if (!child.kill("SIGUSR2")) throw fixedError("clean_quit_invalid", "quit");
  await withTimeout(exit, SHUTDOWN_TIMEOUT_MS, "clean_quit_invalid", "quit");
  if (child.exitCode !== 0 || child.signalCode !== null) throw fixedError("clean_quit_invalid", "quit");
  await waitFor(() => descendants.every((pid) => !processAlive(pid)), SHUTDOWN_TIMEOUT_MS, "clean_quit_invalid", "quit");
  return true;
}

function childHasExited(child) {
  return (child?.exitCode !== null && child?.exitCode !== undefined)
    || (child?.signalCode !== null && child?.signalCode !== undefined);
}

function prepareChildExitWaiter(child) {
  let resolveExit;
  const exit = new Promise((resolveExitEvent) => { resolveExit = resolveExitEvent; });
  const onExit = () => resolveExit(true);
  try { child.once("exit", onExit); } catch { return async () => childHasExited(child); }
  return async (timeoutMs) => {
    let timer;
    try {
      const exited = await Promise.race([
        exit,
        new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); }),
      ]);
      return exited === true || childHasExited(child);
    } finally {
      clearTimeout(timer);
      try { child.removeListener("exit", onExit); } catch {}
    }
  };
}

/**
 * The normal clean-quit path clears `child` only after it has verified every
 * captured descendant has exited. On an error path, preserve the disposable
 * fixture unless this fallback can make the same process-tree claim.
 */
export async function finalizeSyntheticFixture({
  child,
  fixture,
  captureDescendants = descendantsOf,
  isAlive = processAlive,
  createExitWaiter = prepareChildExitWaiter,
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  shutdownTimeoutMs = 2_000,
} = {}) {
  if (child !== null) {
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0 || childHasExited(child)) {
      return Object.freeze({ shutdownConfirmed: false, fixtureRemoved: false });
    }
    const descendants = captureDescendants(child.pid);
    if (!Array.isArray(descendants)) return Object.freeze({ shutdownConfirmed: false, fixtureRemoved: false });
    const waitForExit = createExitWaiter(child);
    let signaled = false;
    try { signaled = child.kill("SIGTERM") === true; } catch {}
    if (!signaled || await waitForExit(shutdownTimeoutMs) !== true
        || isAlive(child.pid) || descendants.some((pid) => isAlive(pid))) {
      return Object.freeze({ shutdownConfirmed: false, fixtureRemoved: false });
    }
  }
  if (fixture === null) return Object.freeze({ shutdownConfirmed: true, fixtureRemoved: false });
  try {
    await removeDirectory(fixture.root);
    return Object.freeze({ shutdownConfirmed: true, fixtureRemoved: true });
  } catch {
    return Object.freeze({ shutdownConfirmed: true, fixtureRemoved: false });
  }
}

function nativeHandoffError(reason) {
  const error = new Error(reason);
  error.reason = ["native_cua_handoff_timeout", "native_cua_handoff_invalid"].includes(reason)
    ? reason
    : "runtime_failed";
  error.stage = "native_handoff";
  return error;
}

async function ensureFreshNativeCuaHandoffDirectory(directory) {
  if (typeof directory !== "string" || directory.length < 1) {
    throw fixedError("arguments_invalid", "contract");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  if ((await readdir(directory)).length !== 0) throw fixedError("arguments_invalid", "contract");
}

async function writeNativeCuaHandoffReady(directory, value) {
  const destination = join(directory, "ready.json");
  const temporary = join(directory, ".ready.json.tmp");
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, destination);
}

function readNativeCuaHandoffAcknowledgement(value, expectedPid) {
  if (!isPlainRecord(value)
      || Object.keys(value).length !== 4
      || value.schemaVersion !== NATIVE_CUA_HANDOFF_SCHEMA_VERSION
      || value.status !== "acknowledged"
      || value.pid !== expectedPid
      || !isPlainRecord(value.nativeTray)) return null;
  const tray = normalizedNativeTrayEvidence(value.nativeTray);
  if (tray.status === "not_run") return null;
  return tray;
}

async function waitForNativeCuaHandoffAcknowledgement({ directory, child }) {
  const started = Date.now();
  const acknowledgement = join(directory, "acknowledgement.json");
  while (Date.now() - started < NATIVE_HANDOFF_TIMEOUT_MS) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      throw nativeHandoffError("native_cua_handoff_invalid");
    }
    try {
      const parsed = JSON.parse(await readFile(acknowledgement, "utf8"));
      const accepted = readNativeCuaHandoffAcknowledgement(parsed, child.pid);
      if (accepted !== null) return accepted;
    } catch {}
    await wait(100);
  }
  throw nativeHandoffError("native_cua_handoff_timeout");
}

async function runNativeCuaHandoff(args) {
  const progress = {
    artifactIdentityBound: false,
    dashboardReady: false,
    handoffAcknowledged: false,
    cleanQuit: false,
    loopbackOnly: true,
    nativeTray: {},
  };
  let fixture = null;
  let child = null;
  let cdp = null;
  let loopbackOnly = true;
  const handoffDirectory = args.nativeCuaHandoffDirectory;
  try {
    const executable = await assertArtifact(args);
    progress.artifactIdentityBound = true;
    const smoke = await import(pathToFileURL(join(args.sourceRoot, "scripts", "smoke-electron-macos.mjs")).href);
    if (typeof smoke.createSyntheticFixture !== "function" || typeof smoke.selectMacDashboardTarget !== "function") {
      throw fixedError("source_identity_invalid", "contract");
    }
    fixture = await smoke.createSyntheticFixture();
    const port = await freeLoopbackPort();
    const environment = {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      HOME: process.env.HOME,
      TMPDIR: fixture.root,
      CODEX_HOME: fixture.codexHome,
      CLAUDE_CONFIG_DIR: fixture.claudeHome,
      XDG_CONFIG_HOME: fixture.configHome,
      XDG_DATA_HOME: fixture.dataHome,
      XDG_CACHE_HOME: fixture.cacheHome,
      XDG_RUNTIME_DIR: fixture.runtimeDirectory,
      USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: SMOKE_CONTROL,
      USAGE_MONITOR_TEST_LANE: TEST_LANE,
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: fixture.identityFile,
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    };
    child = spawn(executable, [
      `--user-data-dir=${fixture.userData}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ], {
      cwd: join(args.appPath, "Contents", "Resources"),
      env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("error", () => {});
    if (!child.pid) throw fixedError("launch_failed", "launch");
    await waitFor(() => jsonFetch(`http://127.0.0.1:${port}/json/version`, "remote_debugging_unavailable", "launch"), STARTUP_TIMEOUT_MS, "remote_debugging_unavailable", "launch");
    const target = await waitFor(async () => smoke.selectMacDashboardTarget(
      await jsonFetch(`http://127.0.0.1:${port}/json`, "dashboard_target_unavailable", "dashboard"), port,
    ), STARTUP_TIMEOUT_MS, "dashboard_target_unavailable", "dashboard");
    const origin = new URL(target.url).origin;
    cdp = await connectCdp(target);
    await cdp.request("Page.enable");
    await cdp.request("Network.enable");
    cdp.on("Network.requestWillBeSent", ({ request } = {}) => {
      try {
        const url = new URL(request?.url ?? "");
        if ((url.protocol === "http:" || url.protocol === "https:") && (url.protocol !== "http:" || url.hostname !== "127.0.0.1")) loopbackOnly = false;
      } catch { loopbackOnly = false; }
    });
    const released = await cdp.evaluate(`(() => {
      const bridge = globalThis.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__;
      try { return bridge?.version === "v1" && bridge.releaseStartupRefresh?.() === true; } catch { return false; }
    })()`);
    if (released !== true) throw fixedError("dashboard_unavailable", "dashboard");
    await waitFor(async () => cdp.evaluate(`(() => document.documentElement?.dataset?.localDashboardReady === "true"
      && document.title === "TiboTattle" && (document.querySelector("#overview-title")?.textContent?.trim().length ?? 0) > 0)()`), STARTUP_TIMEOUT_MS, "dashboard_unavailable", "dashboard");
    progress.dashboardReady = true;
    await writeNativeCuaHandoffReady(handoffDirectory, {
      schemaVersion: NATIVE_CUA_HANDOFF_SCHEMA_VERSION,
      status: "ready",
      pid: child.pid,
      sourceRevision: args.sourceRevision,
      artifactSha256: args.artifactSha256,
    });
    progress.nativeTray = await waitForNativeCuaHandoffAcknowledgement({ directory: handoffDirectory, child });
    progress.handoffAcknowledged = true;
    cdp.close(); cdp = null;
    progress.cleanQuit = await cleanQuit(child);
    child = null;
    progress.loopbackOnly = loopbackOnly;
    return buildClosedNativeTrayReceipt({
      requestedStatus: "passed",
      sourceRevision: args.sourceRevision,
      artifactSha256: args.artifactSha256,
      ...progress,
    });
  } catch (error) {
    progress.loopbackOnly = loopbackOnly;
    if (error !== null && typeof error === "object") error.nativeProgress = progress;
    throw error;
  } finally {
    cdp?.close();
    const cleanup = await finalizeSyntheticFixture({ child, fixture });
    if (cleanup.shutdownConfirmed) await Promise.all([
      rm(join(handoffDirectory, "ready.json"), { force: true }).catch(() => {}),
      rm(join(handoffDirectory, "acknowledgement.json"), { force: true }).catch(() => {}),
    ]);
  }
}

async function runPageParity(args) {
  const progress = {
    artifactIdentityBound: false,
    cleanQuit: false,
    loopbackOnly: true,
    pages: {},
    cacheLinks: {},
    settings: {},
    screenshots: {},
  };
  let fixture = null;
  let child = null;
  let cdp = null;
  let loopbackOnly = true;
  try {
    const executable = await assertArtifact(args);
    progress.artifactIdentityBound = true;
    const smoke = await import(pathToFileURL(join(args.sourceRoot, "scripts", "smoke-electron-macos.mjs")).href);
    if (typeof smoke.createSyntheticFixture !== "function" || typeof smoke.selectMacDashboardTarget !== "function" || typeof smoke.selectMacSettingsTarget !== "function") {
      throw fixedError("source_identity_invalid", "contract");
    }
    fixture = await smoke.createSyntheticFixture();
    await seedSyntheticCacheLinkSources(fixture);
    const port = await freeLoopbackPort();
    const environment = {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      HOME: process.env.HOME,
      TMPDIR: fixture.root,
      CODEX_HOME: fixture.codexHome,
      CLAUDE_CONFIG_DIR: fixture.claudeHome,
      XDG_CONFIG_HOME: fixture.configHome,
      XDG_DATA_HOME: fixture.dataHome,
      XDG_CACHE_HOME: fixture.cacheHome,
      XDG_RUNTIME_DIR: fixture.runtimeDirectory,
      USAGE_MONITOR_STATE_ROOT: fixture.stateRoot,
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: SMOKE_CONTROL,
      USAGE_MONITOR_TEST_LANE: TEST_LANE,
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: fixture.identityFile,
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    };
    child = spawn(executable, [
      `--user-data-dir=${fixture.userData}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ], {
      cwd: join(args.appPath, "Contents", "Resources"),
      env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("error", () => {});
    if (!child.pid) throw fixedError("launch_failed", "launch");
    await waitFor(() => jsonFetch(`http://127.0.0.1:${port}/json/version`, "remote_debugging_unavailable", "launch"), STARTUP_TIMEOUT_MS, "remote_debugging_unavailable", "launch");
    const target = await waitFor(async () => smoke.selectMacDashboardTarget(
      await jsonFetch(`http://127.0.0.1:${port}/json`, "dashboard_target_unavailable", "dashboard"), port,
    ), STARTUP_TIMEOUT_MS, "dashboard_target_unavailable", "dashboard");
    const origin = new URL(target.url).origin;
    cdp = await connectCdp(target);
    await cdp.request("Page.enable");
    await cdp.request("Network.enable");
    cdp.on("Network.requestWillBeSent", ({ request } = {}) => {
      try {
        const url = new URL(request?.url ?? "");
        if ((url.protocol === "http:" || url.protocol === "https:") && (url.protocol !== "http:" || url.hostname !== "127.0.0.1")) loopbackOnly = false;
      } catch { loopbackOnly = false; }
    });
    const released = await cdp.evaluate(`(() => {
      const bridge = globalThis.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__;
      try { return bridge?.version === "v1" && bridge.releaseStartupRefresh?.() === true; } catch { return false; }
    })()`);
    if (released !== true) throw fixedError("dashboard_unavailable", "dashboard");
    await waitFor(async () => cdp.evaluate(`(() => document.documentElement?.dataset?.localDashboardReady === "true"
      && document.title === "TiboTattle" && (document.querySelector("#overview-title")?.textContent?.trim().length ?? 0) > 0)()`), STARTUP_TIMEOUT_MS, "dashboard_unavailable", "dashboard");

    const { pages, screenshots } = progress;
    pages.overview = await inspectPage(cdp, { key: "overview", nav: "overview", page: "#overview", heading: "#overview-title", primary: "#quota-cards", secondary: "#setup-card", surface: { chart: "data", empty: "empty" } }, screenshots, args.screenshotsDirectory, await refreshPresentationState(origin));
    pages.allowance = await inspectPage(cdp, { key: "allowance", nav: "weekly", page: "#weekly", heading: "#weekly-title", primary: "#weekly-chart", secondary: "#weekly-empty", surface: { chart: "chart", empty: "empty" } }, screenshots, args.screenshotsDirectory, await refreshPresentationState(origin));
    pages.trends = await inspectPage(cdp, { key: "trends", nav: "trends", page: "#timeline", heading: "#timeline-title", primary: "#timeline-chart", secondary: "#timeline-empty", surface: { chart: "chart", empty: "empty" } }, screenshots, args.screenshotsDirectory, await refreshPresentationState(origin));
    await waitFor(async () => (await refreshPresentationState(origin)) === "fresh", STARTUP_TIMEOUT_MS, "page_render_invalid", "pages");
    pages.usage = await inspectPage(cdp, { key: "usage", nav: "method", page: "#accounting", heading: "#accounting-title", primary: "#cache-reuse-outcome", secondary: "#cache-switch-details", surface: { chart: "data", empty: "empty" } }, screenshots, args.screenshotsDirectory, "fresh");

    progress.cacheLinks = await inspectPackagedCacheLinks(cdp);
    screenshots.cacheLinks = await captureScreenshot(cdp, args.screenshotsDirectory, "cache-links");

    progress.settings = await runSettingsJourney({ cdp, port, origin, smoke, screenshots, outputDirectory: args.screenshotsDirectory });
    cdp.close(); cdp = null;
    progress.cleanQuit = await cleanQuit(child);
    child = null;
    progress.loopbackOnly = loopbackOnly;
    return buildClosedPageParityReceipt({
      requestedStatus: "passed", sourceRevision: args.sourceRevision, artifactSha256: args.artifactSha256,
      artifactIdentityBound: progress.artifactIdentityBound,
      cleanQuit: progress.cleanQuit,
      loopbackOnly: progress.loopbackOnly,
      pages: progress.pages,
      cacheLinks: progress.cacheLinks,
      settings: progress.settings,
      nativeTray: { status: "unavailable", reason: "cua_bridge_unavailable" }, screenshots,
    });
  } catch (error) {
    progress.loopbackOnly = loopbackOnly;
    if (error !== null && typeof error === "object") error.progress = progress;
    throw error;
  } finally {
    cdp?.close();
    await finalizeSyntheticFixture({ child, fixture });
  }
}

async function main() {
  let args = null;
  let destinationPrepared = false;
  let receipt = null;
  try {
    args = parsePageParityArguments();
    await ensureFreshDestination(args);
    destinationPrepared = true;
    if (args.nativeCuaHandoffDirectory !== null) {
      await ensureFreshNativeCuaHandoffDirectory(args.nativeCuaHandoffDirectory);
      receipt = await runNativeCuaHandoff(args);
    } else {
      receipt = await runPageParity(args);
    }
  } catch (error) {
    const sourceRevision = args?.sourceRevision ?? null;
    const artifactSha256 = args?.artifactSha256 ?? null;
    if (args?.nativeCuaHandoffDirectory !== null && args !== null) {
      const progress = isPlainRecord(error?.nativeProgress) ? error.nativeProgress : {};
      receipt = buildClosedNativeTrayReceipt({
        requestedStatus: "failed", sourceRevision, artifactSha256,
        artifactIdentityBound: progress.artifactIdentityBound === true,
        dashboardReady: progress.dashboardReady === true,
        handoffAcknowledged: progress.handoffAcknowledged === true,
        cleanQuit: progress.cleanQuit === true,
        loopbackOnly: progress.loopbackOnly === true,
        nativeTray: progress.nativeTray,
        failureStage: error?.stage,
        failureReason: error?.reason,
      });
    } else {
      const progress = isPlainRecord(error?.progress) ? error.progress : {};
      receipt = buildClosedPageParityReceipt({
        requestedStatus: "failed", sourceRevision, artifactSha256,
        artifactIdentityBound: progress.artifactIdentityBound === true,
        cleanQuit: progress.cleanQuit === true,
        loopbackOnly: progress.loopbackOnly === true,
        pages: progress.pages,
        cacheLinks: progress.cacheLinks,
        settings: progress.settings,
        screenshots: progress.screenshots,
        failureStage: error?.stage ?? "launch", failureReason: error?.reason ?? "runtime_failed",
        nativeTray: { status: "unavailable", reason: "cua_bridge_unavailable" },
      });
    }
  }
  if (args !== null && destinationPrepared) {
    try {
      await writeReceipt(args.receiptPath, receipt);
    } catch {
      process.stdout.write("failed\n");
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`${receipt.status}\n`);
  process.exitCode = receipt.status === "failed" ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
