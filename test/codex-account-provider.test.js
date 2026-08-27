import assert from "node:assert/strict";
import test from "node:test";

import * as accountFacade from "../src/providers/codex/account.js";
import * as accountScope from "../src/providers/codex/account-scope.js";
import * as appServer from "../src/providers/codex/app-server.js";

const EXPECTED_PUBLIC_EXPORTS = [
  "CodexAppServerClient",
  "CodexAppServerError",
  "OPENAI_ACCOUNT_SCOPE_VERSION",
  "codexAppServerChildEnv",
  "deriveOpenAIAccountScope",
  "deriveOpenAIAccountScopeWithSecretLoader",
  "findCodexBinary",
  "inspectCodexBinary",
  "readCodexAccountSnapshot",
  "sanitizeAccountScope",
  "sanitizeCodexAccountSnapshot",
  "sanitizeCodexAccountSnapshotWithSecretLoader",
  "sanitizePlanType",
  "sanitizeRateLimit",
];

test("Codex account facade exposes only reviewed exports with exact identities", () => {
  assert.deepEqual(Object.keys(accountFacade).sort(), EXPECTED_PUBLIC_EXPORTS);
  for (const name of EXPECTED_PUBLIC_EXPORTS) {
    assert.equal(
      accountFacade[name],
      accountScope[name] ?? appServer[name],
      name,
    );
  }
  assert.equal(accountFacade.OPENAI_ACCOUNT_SCOPE_PREFIX, undefined);
});

test("Codex binary diagnostics preserve selection precedence without exposing paths", async () => {
  const privateOverride = "/private/codex-builds/review/codex";
  const diagnostic = await accountFacade.inspectCodexBinary({
    environment: { CODEX_BIN: privateOverride },
    accessFile: async (candidate) => {
      assert.equal(candidate, privateOverride);
    },
    readVersion: async (candidate) => {
      assert.equal(candidate, privateOverride);
      return "codex-cli 0.149.1\n";
    },
  });

  assert.deepEqual(diagnostic, {
    schemaVersion: "codex-binary-diagnostic-v0.1",
    source: "environment_override",
    versionStatus: "available",
    version: "0.149.1",
  });
  assert.equal(JSON.stringify(diagnostic).includes(privateOverride), false);
});

test("Codex binary diagnostics fail closed on malformed or unavailable versions", async () => {
  const diagnostic = await accountFacade.inspectCodexBinary({
    environment: {},
    accessFile: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    readVersion: async (candidate) => {
      assert.equal(candidate, "codex");
      return "private warning with /Users/someone/project";
    },
  });

  assert.deepEqual(diagnostic, {
    schemaVersion: "codex-binary-diagnostic-v0.1",
    source: "path",
    versionStatus: "unavailable",
    version: null,
  });
});

test("rate-limit sanitation retains provider duration and fails closed on plan evidence", () => {
  const sanitized = accountFacade.sanitizeRateLimit({
    limitId: "codex",
    planType: "pro-20x",
    primary: {
      usedPercent: 12,
      windowDurationMins: 43_200,
      resetsAt: 1_788_048_360,
    },
    secondary: {
      usedPercent: 20,
      windowDurationMins: 10_080,
      resetsAt: 1_786_061_160,
    },
  });

  assert.equal(sanitized.planType, "unknown");
  assert.equal(sanitized.primary.windowDurationMins, 43_200);
  assert.equal(sanitized.secondary.windowDurationMins, 10_080);
  assert.equal(
    accountFacade.sanitizeRateLimit({
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 525_601, resetsAt: 1_788_048_360 },
    }).primary,
    null,
  );
});
