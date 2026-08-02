import { describe, expect, it } from "vitest";

import {
  telemetryEnvelopeGolden,
  telemetryV01Golden,
} from "../../../test/fixtures/telemetry-contract-vectors.mjs";
import { ApiError } from "../src/errors";
import {
  validateTelemetryContribution,
  validateTelemetryEnvelope,
} from "../src/telemetry-validation";

/**
 * Additional adversarial coverage for the closed-shape and privacy-canary
 * guarantees `validateTelemetryContribution`/`validateTelemetryEnvelope`
 * enforce end to end.
 *
 * telemetry-contract-parity.spec.ts already proves every vector in the
 * shared adversarial suite maps to the right error code — including a
 * top-of-usageEvent "prompt" field and a v0.2 "accountTrackId" value. This
 * file goes after the specific claim in the product's privacy promise —
 * "no prompt, response, path, URL, or account identifier may pass" — with
 * cases the shared vectors don't exercise: a forbidden key nested inside a
 * sub-object rather than at the top of a record, key-name obfuscation
 * (case/punctuation), and a content-shaped *value* smuggled through a field
 * whose name is entirely unremarkable.
 */

const MARKER = "SENTINEL-4f9c9e6f-do-not-leak";

function firstOf(golden: Record<string, unknown>, key: string): Record<string, unknown> {
  const list = Reflect.get(golden, key) as Record<string, unknown>[];
  return list[0]!;
}

function components(golden: Record<string, unknown>): Record<string, unknown> {
  return Reflect.get(firstOf(golden, "usageEvents"), "components") as Record<string, unknown>;
}

function expectRejected(
  value: unknown,
  label: string,
  expectedCode: "PRIVACY_CANARY_DETECTED" | "TELEMETRY_RECORD_INVALID",
): void {
  try {
    validateTelemetryContribution(value);
    throw new Error(`expected ${label} to be rejected`);
  } catch (error) {
    expect(error, label).toBeInstanceOf(ApiError);
    expect((error as ApiError).code, label).toBe(expectedCode);
    expect((error as ApiError).status, label).toBe(400);
    const serialized = JSON.stringify({
      code: (error as ApiError).code,
      message: (error as Error).message,
      details: (error as ApiError).publicDetails,
    });
    expect(serialized.includes(MARKER), label).toBe(false);
  }
}

describe("telemetry content-privacy adversarial coverage", () => {
  it("accepts the unmodified golden contribution (sanity control for every mutation below)", () => {
    const golden = telemetryV01Golden();
    expect(validateTelemetryContribution(golden)).toBe(golden);
  });

  it("rejects a forbidden content key no matter how deeply it is nested", () => {
    const topLevel = telemetryV01Golden();
    Reflect.set(topLevel, "email", MARKER);
    expectRejected(topLevel, "top-level email", "PRIVACY_CANARY_DETECTED");

    const inUsageEvent = telemetryV01Golden();
    Reflect.set(firstOf(inUsageEvent, "usageEvents"), "response", MARKER);
    expectRejected(inUsageEvent, "usageEvents[0].response", "PRIVACY_CANARY_DETECTED");

    // Two levels deep: contribution -> usageEvents[0] -> components -> path.
    // The shared "content_field" vector only ever plants a forbidden key at
    // the top of a record, so this is the one thing that actually pins
    // recursive (not just shallow) scanning.
    const inComponents = telemetryV01Golden();
    Reflect.set(components(inComponents), "path", MARKER);
    expectRejected(inComponents, "usageEvents[0].components.path", "PRIVACY_CANARY_DETECTED");

    const inQuota = telemetryV01Golden();
    Reflect.set(firstOf(inQuota, "quotaSnapshots"), "url", MARKER);
    expectRejected(inQuota, "quotaSnapshots[0].url", "PRIVACY_CANARY_DETECTED");

    const inActivity = telemetryV01Golden();
    Reflect.set(firstOf(inActivity, "activityMarkers"), "cwd", MARKER);
    expectRejected(inActivity, "activityMarkers[0].cwd", "PRIVACY_CANARY_DETECTED");
  });

  it("normalizes the forbidden-key match across case and punctuation obfuscation", () => {
    const casedKey = telemetryV01Golden();
    Reflect.set(firstOf(casedKey, "usageEvents"), "Response", MARKER);
    expectRejected(casedKey, "Response (capitalized)", "PRIVACY_CANARY_DETECTED");

    const hyphenated = telemetryV01Golden();
    Reflect.set(firstOf(hyphenated, "quotaSnapshots"), "File-Path", MARKER);
    expectRejected(hyphenated, "File-Path (hyphenated)", "PRIVACY_CANARY_DETECTED");

    const spaced = telemetryV01Golden();
    Reflect.set(spaced, "Working Directory", MARKER);
    expectRejected(spaced, "Working Directory (spaced)", "PRIVACY_CANARY_DETECTED");
  });

  it("rejects a content-shaped value even when the field name holding it is unremarkable", () => {
    const urlValue = telemetryV01Golden();
    Reflect.set(firstOf(urlValue, "usageEvents"), "eventId", "https://exfiltrate.example/x");
    expectRejected(urlValue, "eventId holding a URL", "PRIVACY_CANARY_DETECTED");

    const posixPath = telemetryV01Golden();
    Reflect.set(firstOf(posixPath, "quotaSnapshots"), "snapshotId", "/Users/adam/secret-notes.txt");
    expectRejected(posixPath, "snapshotId holding a POSIX path", "PRIVACY_CANARY_DETECTED");

    const windowsPath = telemetryV01Golden();
    Reflect.set(firstOf(windowsPath, "activityMarkers"), "markerId", "C:\\Users\\adam\\secret.txt");
    expectRejected(windowsPath, "markerId holding a Windows path", "PRIVACY_CANARY_DETECTED");

    const emailValue = telemetryV01Golden();
    Reflect.set(emailValue, "providerPolicyEpoch", "person@example.com");
    expectRejected(emailValue, "providerPolicyEpoch holding an email address", "PRIVACY_CANARY_DETECTED");

    const participantIdentity = telemetryV01Golden();
    Reflect.set(
      firstOf(participantIdentity, "usageEvents"),
      "eventId",
      "participant:12345678-1234-1234-1234-123456789012",
    );
    expectRejected(
      participantIdentity,
      "eventId holding a participant identity string",
      "PRIVACY_CANARY_DETECTED",
    );

    const fileUri = telemetryV01Golden();
    Reflect.set(firstOf(fileUri, "usageEvents"), "modelFingerprint", "file:///etc/passwd");
    expectRejected(fileUri, "modelFingerprint holding a file URI", "PRIVACY_CANARY_DETECTED");
  });

  it("distinguishes an unrecognized-but-harmless field from a privacy canary", () => {
    // Same "extra field" shape as the forbidden-key cases above, but the key
    // itself carries no privacy signal. This must still be rejected — the
    // schema is closed — but as a generic shape violation, not the more
    // specific canary classification, proving the canary scan isn't simply
    // flagging every unrecognized key.
    const harmless = telemetryV01Golden();
    Reflect.set(harmless, "debugNotes", "not a forbidden key");
    expectRejected(harmless, "unrecognized top-level field", "TELEMETRY_RECORD_INVALID");
  });

  it("rejects an unrecognized envelope field without a privacy-specific classification, and never echoes it", () => {
    const envelope = telemetryEnvelopeGolden();
    Reflect.set(envelope, "path", MARKER);
    try {
      validateTelemetryEnvelope(envelope);
      throw new Error("expected the mutated envelope to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("ENVELOPE_INVALID");
      const serialized = JSON.stringify({
        code: (error as ApiError).code,
        message: (error as Error).message,
      });
      expect(serialized.includes(MARKER)).toBe(false);
    }
  });
});
