import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { deriveOpenAIAccountScope, sanitizeAccountScope } from "./account-scope.js";
import { normalizeProviderPlanType } from "./plan-normalization.js";
import { normalizeProviderQuotaWindow } from "./quota-normalization.js";
import { RELEASE_VERSION } from "../../../config/release-manifest.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const ACCOUNT_HMAC_ENV = "APP_USAGEMONITOR_ACCOUNT_HMAC_KEY";
// The app's Keychain broker announcement names a descriptor in *this*
// process, and this child's descriptor 0 is a different file entirely. No
// secret leaks — the child cannot reach the socketpair — but an announcement
// that resolves to an unrelated descriptor is a trap for anything downstream
// that trusts it, so the key never crosses the spawn.
const KEYCHAIN_BROKER_FD_ENV = "USAGE_MONITOR_KEYCHAIN_BROKER_FD";

export function codexAppServerChildEnv(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment[ACCOUNT_HMAC_ENV];
  delete childEnvironment[KEYCHAIN_BROKER_FD_ENV];
  return childEnvironment;
}

async function isExecutable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return "codex";
}

export class CodexAppServerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function classifyAppServerFailure(error, stderr = "") {
  const detail = `${error?.message ?? ""} ${stderr}`.toLowerCase();
  if (error?.code === "ENOENT") return "app_server_unavailable";
  if (detail.includes("auth") || detail.includes("login") || detail.includes("token")) return "authentication_failure";
  if (detail.includes("json") || detail.includes("malformed") || detail.includes("parse")) return "malformed_output";
  return "temporary_disconnect";
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stderr = "";
    this.closed = false;
    this.malformedMessages = 0;
  }

  async start() {
    if (this.child) return this;
    const binary = await findCodexBinary();
    try {
      this.child = this.spawnProcess(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: codexAppServerChildEnv(),
      });
    } catch (error) {
      throw new CodexAppServerError(classifyAppServerFailure(error), "Unable to start the Codex app-server", { cause: error });
    }
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2_000);
    });
    this.lines.on("line", (line) => this.#handleLine(line));
    this.child.once("error", (error) => this.#handleDisconnect(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.#handleDisconnect(new Error(`Codex app-server exited (${code ?? signal})`));
    });
    await this.request("initialize", {
      clientInfo: {
        name: "app_usagemonitor",
        title: "TiboTattle",
        version: RELEASE_VERSION,
      },
      capabilities: {
        optOutNotificationMethods: ["remoteControl/status/changed"],
      },
    }, { requestId: 0 });
    this.notify("initialized", {});
    return this;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.malformedMessages += 1;
      this.emit("protocolWarning", { code: "malformed_output" });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexAppServerError("request_failed", message.error.message ?? "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      this.emit("rateLimitsUpdated", message.params ?? null);
    }
  }

  #handleDisconnect(error) {
    if (this.closed) return;
    const code = classifyAppServerFailure(error, this.stderr);
    const wrapped = new CodexAppServerError(code, "Codex app-server disconnected", { cause: error });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.pending.clear();
    this.emit("disconnect", { code });
  }

  request(method, params = {}, { requestId = null } = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new CodexAppServerError("temporary_disconnect", "Codex app-server is not writable"));
    }
    const id = requestId ?? this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError("request_timeout", `Codex app-server request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    return true;
  }

  readRateLimits() {
    return this.request("account/rateLimits/read", {});
  }

  readAccount() {
    return this.request("account/read", {});
  }

  readAccountUsage() {
    return this.request("account/usage/read", {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerError("temporary_disconnect", "Codex app-server client closed"));
    }
    this.pending.clear();
    this.lines?.close();
    this.child?.kill("SIGTERM");
  }
}

export async function readCodexAccountSnapshot({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const binary = await findCodexBinary();
  const client = new CodexAppServerClient({ timeoutMs });
  try {
    await client.start();
    const [account, rateLimits, accountUsage] = await Promise.all([
      client.readAccount(),
      client.readRateLimits(),
      client.readAccountUsage(),
    ]);
    return { account, rateLimits, accountUsage, binary };
  } finally {
    client.close();
  }
}

function sanitizeLimitWindow(window) {
  if (!window) return null;
  return normalizeProviderQuotaWindow(window);
}

export function sanitizeRateLimit(limit) {
  if (!limit) return null;
  return {
    limitId: limit.limitId,
    limitName: limit.limitName ?? null,
    primary: sanitizeLimitWindow(limit.primary),
    secondary: sanitizeLimitWindow(limit.secondary),
    planType: normalizeProviderPlanType(limit.planType),
    rateLimitReachedType: limit.rateLimitReachedType ?? null,
    spendControlReached: limit.spendControlReached ?? null,
    credits: limit.credits
      ? {
          hasCredits: limit.credits.hasCredits ?? null,
          unlimited: limit.credits.unlimited ?? null,
        }
      : null,
  };
}

function sanitizeUsageSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const result = {};
  for (const field of ["currentStreakDays", "lifetimeTokens", "longestRunningTurnSec", "longestStreakDays", "peakDailyTokens"]) {
    const value = summary[field];
    result[field] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return result;
}

export function sanitizeCodexAccountSnapshot(snapshot, capturedAt, {
  accountHmacKey = null,
  accountCredentialUnavailableReason = null,
} = {}) {
  const raw = snapshot.rateLimits;
  if (!raw?.rateLimits) {
    throw new Error(raw?.error?.message ?? "Codex did not return a canonical rate-limit snapshot");
  }
  const canonical = sanitizeRateLimit(raw.rateLimits);
  const byLimitId = Object.fromEntries(
    Object.entries(raw.rateLimitsByLimitId ?? {}).map(([id, limit]) => [id, sanitizeRateLimit(limit)]),
  );
  if (!byLimitId[canonical.limitId]) byLimitId[canonical.limitId] = canonical;

  const usage = snapshot.accountUsage;
  const dailyUsageBuckets = Array.isArray(usage?.dailyUsageBuckets)
    ? usage.dailyUsageBuckets
        .filter((bucket) => typeof bucket?.startDate === "string" && Number.isFinite(bucket?.tokens))
        .map((bucket) => ({ date: bucket.startDate, tokens: bucket.tokens }))
    : [];
  const providerPlanType = normalizeProviderPlanType(
    snapshot.account?.account?.planType ?? canonical.planType,
  );
  const accountScope = sanitizeAccountScope(deriveOpenAIAccountScope(snapshot.account, {
    secret: accountHmacKey,
    planType: providerPlanType,
    unavailableSecretReason: accountCredentialUnavailableReason,
  }));

  return {
    capturedAt,
    accountScope,
    canonical,
    byLimitId,
    officialDailyTokens: dailyUsageBuckets,
    officialUsageSummary: sanitizeUsageSummary(usage?.summary),
  };
}

async function loadAccountObservationSecretSafely(loadAccountObservationSecret) {
  if (typeof loadAccountObservationSecret !== "function") {
    return { secret: null, unavailableReason: "credential_unavailable" };
  }
  try {
    const secret = await loadAccountObservationSecret();
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
      if (Buffer.isBuffer(secret)) secret.fill(0);
      return { secret: null, unavailableReason: "credential_unavailable" };
    }
    return { secret, unavailableReason: null };
  } catch (error) {
    return {
      secret: null,
      unavailableReason: error?.code === "account_observation_credential_locked"
        ? "credential_locked"
        : "credential_unavailable",
    };
  }
}

export async function deriveOpenAIAccountScopeWithSecretLoader(accountRead, {
  loadAccountObservationSecret,
  planType = null,
} = {}) {
  const loaded = await loadAccountObservationSecretSafely(loadAccountObservationSecret);
  try {
    return sanitizeAccountScope(deriveOpenAIAccountScope(accountRead, {
      secret: loaded.secret,
      planType,
      unavailableSecretReason: loaded.unavailableReason,
    }));
  } finally {
    loaded.secret?.fill(0);
  }
}

export async function sanitizeCodexAccountSnapshotWithSecretLoader(snapshot, capturedAt, {
  loadAccountObservationSecret,
} = {}) {
  const loaded = await loadAccountObservationSecretSafely(loadAccountObservationSecret);
  try {
    return sanitizeCodexAccountSnapshot(snapshot, capturedAt, {
      accountHmacKey: loaded.secret,
      accountCredentialUnavailableReason: loaded.unavailableReason,
    });
  } finally {
    loaded.secret?.fill(0);
  }
}
