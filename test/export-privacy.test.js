import test from "node:test";
import assert from "node:assert/strict";
import { inspectSensitiveExportStrings, verifyPrivacySafeBundle } from "../src/export-privacy.js";

test("sensitive string scanner recognizes common content and credential shapes", () => {
  const findings = inspectSensitiveExportStrings({
    a: "adam@example.com",
    b: "https://private.example/thread",
    c: "/Users/adam/private-repo",
    d: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(new Set(findings.map((finding) => finding.code)), new Set([
    "email_address", "web_url", "absolute_user_path", "bearer_token",
  ]));
});

test("privacy gate fails closed without echoing the sensitive value", () => {
  const sensitive = "canary-private-value";
  const invalidBundle = {
    bundleId: `bundle:v1:${"A".repeat(43)}`,
    participantId: `participant:v1:${"B".repeat(43)}`,
    coveredAt: {},
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    leaked: sensitive,
  };
  assert.throws(
    () => verifyPrivacySafeBundle(invalidBundle, { forbiddenSourceValues: [sensitive] }),
    (error) => error.message.includes("failed closed") && !error.message.includes(sensitive),
  );
});
