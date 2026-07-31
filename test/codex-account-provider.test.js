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
