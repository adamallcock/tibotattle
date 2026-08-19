import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./platform/index.js";
import { hasExactEnumerableKeys } from "./has-exact-enumerable-keys.js";

export const HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION =
  "local-hosted-signin-handoff-v1";
export const HOSTED_SIGNIN_HANDOFF_VALIDITY_MS = 15 * 60 * 1_000;

const MAXIMUM_HANDOFF_BYTES = 2 * 1_024;
const PROVIDERS = new Set(["google", "apple"]);
const BOUND_VALUE = /^[A-Za-z0-9_-]{43,128}$/u;
const ABSENT_KEYS = Object.freeze(["schemaVersion", "status"]);
const PENDING_KEYS = Object.freeze([
  "provider",
  "schemaVersion",
  "startedAt",
  "state",
  "status",
  "verifier",
]);

export class HostedSignInHandoffError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostedSignInHandoffError";
    this.code = code === "hosted_signin_handoff_invalid"
      ? code
      : "hosted_signin_handoff_unavailable";
  }
}

function absentProjection() {
  return Object.freeze({
    schemaVersion: HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION,
    status: "absent",
  });
}

function validPendingDocument(value) {
  return hasExactEnumerableKeys(value, PENDING_KEYS)
    && value.schemaVersion === HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION
    && value.status === "pending"
    && PROVIDERS.has(value.provider)
    && BOUND_VALUE.test(value.state)
    && BOUND_VALUE.test(value.verifier)
    && Number.isSafeInteger(value.startedAt)
    && value.startedAt >= 0;
}

function validAbsentDocument(value) {
  return hasExactEnumerableKeys(value, ABSENT_KEYS)
    && value.schemaVersion === HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION
    && value.status === "absent";
}

function pendingProjection(document) {
  return Object.freeze({
    ...document,
    expiresAt: document.startedAt + HOSTED_SIGNIN_HANDOFF_VALIDITY_MS,
  });
}

export function createHostedSignInHandoffController({
  handoffFile,
  storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: () => new HostedSignInHandoffError(
      "hosted_signin_handoff_unavailable",
    ),
  }),
  now = () => Date.now(),
} = {}) {
  if (typeof handoffFile !== "string" || handoffFile.length < 1) {
    throw new TypeError("handoffFile must be a non-empty path");
  }
  if (!storage
      || typeof storage.readSettingsText !== "function"
      || typeof storage.writeSettingsText !== "function") {
    throw new TypeError("hosted sign-in handoff storage is invalid");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HostedSignInHandoffError(
        "hosted_signin_handoff_unavailable",
      );
    }
    return value;
  }

  async function writeDocument(document) {
    await storage.writeSettingsText({
      settingsFile: handoffFile,
      text: `${JSON.stringify(document)}\n`,
      maximumBytes: MAXIMUM_HANDOFF_BYTES,
    });
  }

  async function writeAbsent() {
    const document = {
      schemaVersion: HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION,
      status: "absent",
    };
    await writeDocument(document);
    return absentProjection();
  }

  async function readDocument() {
    let text;
    try {
      text = await storage.readSettingsText({
        settingsFile: handoffFile,
        maximumBytes: MAXIMUM_HANDOFF_BYTES,
      });
    } catch (error) {
      if (error instanceof HostedSignInHandoffError) throw error;
      throw new HostedSignInHandoffError(
        "hosted_signin_handoff_unavailable",
      );
    }
    if (text === null) return null;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      await writeAbsent();
      return null;
    }
    if (!validPendingDocument(value) && !validAbsentDocument(value)) {
      // A structurally safe owner-only file with an invalid or future payload
      // cannot be used as an OAuth recovery capability. Replace it with a
      // content-free tombstone so the app does not get stuck retrying it.
      await writeAbsent();
      return null;
    }
    return value;
  }

  return Object.freeze({
    schemaVersion: HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION,
    handoffFile,

    async inspect() {
      const document = await readDocument();
      if (document === null || document.status === "absent") {
        return absentProjection();
      }
      if (currentTime() - document.startedAt
          >= HOSTED_SIGNIN_HANDOFF_VALIDITY_MS) {
        const provider = document.provider;
        await writeAbsent();
        return Object.freeze({
          schemaVersion: HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION,
          status: "expired",
          provider,
        });
      }
      return pendingProjection(document);
    },

    async store({ provider, state, verifier } = {}) {
      if (!PROVIDERS.has(provider)
          || typeof state !== "string"
          || !BOUND_VALUE.test(state)
          || typeof verifier !== "string"
          || !BOUND_VALUE.test(verifier)) {
        throw new HostedSignInHandoffError(
          "hosted_signin_handoff_invalid",
        );
      }
      const document = {
        schemaVersion: HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION,
        status: "pending",
        provider,
        state,
        verifier,
        startedAt: currentTime(),
      };
      await writeDocument(document);
      return pendingProjection(document);
    },

    clear: writeAbsent,
  });
}
