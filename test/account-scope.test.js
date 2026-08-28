import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_ACCOUNT_SCOPE_VERSION,
  deriveOpenAIAccountScope,
  sanitizeAccountScope,
  sanitizePlanType,
} from "../src/providers/codex/account.js";

const SECRET = "test-only-local-account-scope-secret";

test("account scope is deterministic for one email and separates distinct emails", () => {
  const first = deriveOpenAIAccountScope({ account: { email: "Owner@Example.test" } }, {
    secret: SECRET,
    planType: " Pro ",
  });
  const same = deriveOpenAIAccountScope({ result: { user: { email: "owner@example.test" } } }, {
    secret: SECRET,
    planType: "pro",
  });
  const other = deriveOpenAIAccountScope({ email: "other@example.test" }, {
    secret: SECRET,
    planType: "pro",
  });

  assert.equal(first.status, "available");
  assert.equal(first.version, OPENAI_ACCOUNT_SCOPE_VERSION);
  assert.equal(first.planType, "pro");
  assert.equal(first.scopeId, same.scopeId);
  assert.notEqual(first.scopeId, other.scopeId);
  assert.match(first.scopeId, /^openai-account:v1:[A-Za-z0-9_-]{43}$/);
});

test("account scope never serializes raw email or malformed plan input", () => {
  const rawEmail = "private.owner@example.test";
  const scope = deriveOpenAIAccountScope({ account: { email: rawEmail } }, {
    secret: SECRET,
    planType: `${rawEmail} should-not-be-a-plan`,
  });
  const serialized = JSON.stringify(scope);

  assert.equal(scope.planType, null);
  assert.equal(serialized.includes(rawEmail), false);
  assert.equal(serialized.includes("should-not-be-a-plan"), false);

  const sanitized = sanitizeAccountScope({
    ...scope,
    email: rawEmail,
    rawSubject: rawEmail,
    secret: SECRET,
  });
  assert.equal(JSON.stringify(sanitized).includes(rawEmail), false);
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test("account scope exposes non-sensitive unavailable states", () => {
  const missingAccount = deriveOpenAIAccountScope(null, { secret: SECRET, planType: "pro" });
  const malformedSubject = deriveOpenAIAccountScope({ account: { email: "not-an-email" } }, { secret: SECRET });
  const missingSecret = deriveOpenAIAccountScope({ account: { email: "private.owner@example.test" } }, { secret: "" });

  assert.deepEqual(missingAccount, {
    status: "unavailable",
    reason: "missing_account",
    version: OPENAI_ACCOUNT_SCOPE_VERSION,
    scopeId: null,
    planType: "pro",
  });
  assert.equal(malformedSubject.status, "unavailable");
  assert.equal(malformedSubject.reason, "malformed_subject");
  assert.equal(missingSecret.status, "unavailable");
  assert.equal(missingSecret.reason, "missing_secret");
  const unavailableCredential = deriveOpenAIAccountScope(
    { account: { email: "private.owner@example.test" } },
    { secret: null, unavailableSecretReason: "credential_unavailable", planType: "pro" },
  );
  assert.equal(unavailableCredential.reason, "credential_unavailable");
  assert.deepEqual(sanitizeAccountScope(unavailableCredential), unavailableCredential);
  const lockedCredential = deriveOpenAIAccountScope(
    { account: { email: "private.owner@example.test" } },
    { secret: null, unavailableSecretReason: "credential_locked", planType: "pro" },
  );
  assert.equal(lockedCredential.reason, "credential_locked");
  assert.deepEqual(sanitizeAccountScope(lockedCredential), lockedCredential);
  const migrationRequired = deriveOpenAIAccountScope(
    { account: { email: "private.owner@example.test" } },
    {
      secret: null,
      unavailableSecretReason: "credential_migration_required",
      planType: "pro",
    },
  );
  assert.equal(migrationRequired.reason, "credential_migration_required");
  assert.deepEqual(sanitizeAccountScope(migrationRequired), migrationRequired);
  assert.equal(JSON.stringify(missingSecret).includes("private.owner@example.test"), false);
});

test("scope sanitizer permits only the versioned public shape", () => {
  const available = deriveOpenAIAccountScope({ account: { email: "owner@example.test" } }, { secret: SECRET, planType: "team" });
  assert.deepEqual(sanitizeAccountScope({ ...available, accountId: "private-id" }), available);
  assert.deepEqual(sanitizeAccountScope({ status: "available", version: "old", scopeId: "private-owner@example.test", planType: "Pro" }), {
    status: "unavailable",
    reason: "missing_account",
    version: OPENAI_ACCOUNT_SCOPE_VERSION,
    scopeId: null,
    planType: "pro",
  });
  assert.equal(sanitizePlanType("business-preview"), "business-preview");
  assert.equal(sanitizePlanType("private owner@example.test"), null);
});
