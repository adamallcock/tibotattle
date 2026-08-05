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
