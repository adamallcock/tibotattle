import { createLocalContributionPreference } from "../../src/application/index.js";
import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
} from "./desktop-settings-backends.js";

export const DESKTOP_SHARING_FILE_NAME = "accountless-sharing-v1.json";
export const DESKTOP_SHARING_POLICY_VERSION = "accountless-opt-out-v1";
const MAXIMUM_BYTES = 4_096;

function fail() {
  const error = new Error("Sharing preference unavailable");
  error.code = "desktop_sharing_unavailable";
  throw error;
}

// The application controller owns the closed schema. This codec only adapts
// its bounded JSON text to both existing protected desktop storage backends.
function recordText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_BYTES) fail();
  return text;
}

const CODEC = Object.freeze({
  encode(text) {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAXIMUM_BYTES) fail();
    const value = JSON.parse(text);
    const canonical = recordText(value);
    return Object.freeze({ value, bytes: Buffer.from(canonical, "utf8") });
  },
  decodeBytes(bytes) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return recordText(JSON.parse(text));
  },
  decodeValue: recordText,
});

export function createDesktopSharingBackend({
  platform = process.platform,
  rootPath,
  windowsProtectedStateStore,
} = {}) {
  const options = { platform, rootPath, maximumBytes: MAXIMUM_BYTES, codec: CODEC };
  return platform === "win32"
    ? createWindowsDesktopSettingsBackend({ ...options, windowsProtectedStateStore,
      childName: DESKTOP_SHARING_FILE_NAME })
    : createPosixDesktopSettingsBackend({ ...options, filename: DESKTOP_SHARING_FILE_NAME });
}

export function createDesktopSharingCoordinator({
  backend,
  installationState = "unknown",
  destinationOrigin,
  now = () => new Date(),
  onAuthorizationChanged = () => {},
} = {}) {
  if (typeof backend?.load !== "function" || typeof backend?.save !== "function"
      || typeof onAuthorizationChanged !== "function") fail();
  let disposed = false;
  let changing = 0;
  let transportStatus = "unavailable";
  const signalChange = () => {
    try { return Promise.resolve(onAuthorizationChanged()); }
    catch { return Promise.reject(new Error("Sharing cancellation unavailable")); }
  };
  const policy = createLocalContributionPreference({
    settingsFile: DESKTOP_SHARING_FILE_NAME,
    policyVersion: DESKTOP_SHARING_POLICY_VERSION,
    destinationOrigin,
    installationState,
    defaultEnabled: true,
    now,
  }, { storage: {
    readSettingsText: async () => backend.load(),
    writeSettingsText: async ({ text }) => backend.save(text),
  } });

  function project(value) {
    return Object.freeze({
      available: value.available === true,
      current: value.current === true,
      enabled: value.enabled === true,
      state: value.state ?? (value.enabled ? "enabled" : "disabled"),
      basis: value.basis ?? null,
      noticeCount: value.noticeCount ?? 0,
      nextNoticeIndex: value.nextNoticeIndex ?? null,
      noticeDue: value.noticeDue === true,
      nextNoticeAt: value.nextNoticeAt ?? null,
      earliestActivationAt: value.earliestActivationAt ?? null,
      transportStatus: value.enabled === true ? transportStatus : "off",
    });
  }

  function active() { if (disposed) fail(); }
  return Object.freeze({
    async initialize() { active(); return project(await policy.initialize()); },
    async inspect() { active(); return project(await policy.evaluateAutomatic()); },
    async readAuthorization() {
      active();
      if (changing > 0) return { available: false, current: false, enabled: false };
      const value = await policy.evaluateAutomatic();
      return changing > 0 ? { available: false, current: false, enabled: false } : value;
    },
    async setEnabled(enabled) {
      active();
      changing += 1;
      let fence;
      try {
        fence = signalChange();
        fence.catch(() => {});
        const saved = await policy.setEnabled(enabled);
        await fence.catch(() => fail());
        return project(saved);
      } finally {
        changing -= 1;
        signalChange().catch(() => {});
      }
    },
    updateTransport(value) {
      if (["off", "unavailable", "uploading", "pending", "up_to_date", "retry_wait", "paused"].includes(value?.state)) {
        transportStatus = value.state;
      }
    },
    async markNoticePresented(index) {
      active();
      return project(await policy.markNoticePresented(index));
    },
    dispose() { disposed = true; signalChange().catch(() => {}); },
  });
}
