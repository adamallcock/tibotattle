import { isProxy } from "node:util/types";

import { assertLinuxTrayAsset } from "./linux-tray-assets.js";

export const LINUX_DESKTOP_CAPABILITIES_CONTRACT =
  "linux-desktop-capabilities-v1";

const DESKTOP_PROTOCOLS = new Set(["x11", "wayland", "none"]);
const TRAY_HOSTS = new Set(["status-notifier", "legacy", "none", "unprobed"]);
const AUTOSTART_STATUSES = new Set([
  "enabled",
  "disabled",
  "malformed",
  "unsafe",
  "unavailable",
  "error",
]);

function fail(code) {
  const error = new Error("Linux desktop capability is unavailable");
  error.name = "LinuxDesktopCapabilityError";
  error.code = `linux_desktop_capability_${code}`;
  throw error;
}

function plainObject(value) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("configuration_invalid");
  }
  return value;
}

function snapshotConfiguration(value) {
  const source = plainObject(value);
  const allowed = [
    "desktopProtocol",
    "trayHost",
    "trayAsset",
    "sessionBusAvailable",
  ];
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    fail("configuration_invalid");
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail("configuration_invalid");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/**
 * Content-free status adapter for later desktop-lifecycle composition.
 * Merely constructing or inspecting this adapter cannot enable autostart,
 * create a tray, deliver a notification, or claim Linux support.
 */
export function createLinuxDesktopCapabilityAdapter({
  platform = process.platform,
  autostartOwner = null,
} = {}) {
  if (platform !== "linux") fail("platform_invalid");
  if (autostartOwner !== null && typeof autostartOwner?.status !== "function") {
    fail("autostart_owner_invalid");
  }

  async function inspect(configuration = {}) {
    const source = snapshotConfiguration(configuration);
    const desktopProtocol = source.desktopProtocol ?? "none";
    const trayHost = source.trayHost ?? "unprobed";
    if (source.sessionBusAvailable !== undefined
        && typeof source.sessionBusAvailable !== "boolean") {
      fail("probe_invalid");
    }
    const sessionBusAvailable = source.sessionBusAvailable === true;
    if (!DESKTOP_PROTOCOLS.has(desktopProtocol) || !TRAY_HOSTS.has(trayHost)) {
      fail("probe_invalid");
    }
    const trayAssetAvailable = source.trayAsset === undefined
      ? false
      : Boolean(assertLinuxTrayAsset(source.trayAsset));

    let autostart = Object.freeze({ status: "unavailable", canSet: false });
    if (autostartOwner !== null) {
      try {
        const observed = await autostartOwner.status();
        if (!AUTOSTART_STATUSES.has(observed?.status)
            || typeof observed?.canSet !== "boolean") {
          fail("autostart_status_invalid");
        }
        autostart = Object.freeze({
          status: observed.status,
          canSet: observed.canSet,
        });
      } catch (error) {
        if (error?.name === "LinuxDesktopCapabilityError") throw error;
        autostart = Object.freeze({ status: "error", canSet: false });
      }
    }

    const trayObservable = trayAssetAvailable
      && desktopProtocol !== "none"
      && trayHost !== "none"
      && trayHost !== "unprobed";
    return Object.freeze({
      contractVersion: LINUX_DESKTOP_CAPABILITIES_CONTRACT,
      platform: "linux",
      integrationStatus: "dormant",
      developmentOnly: true,
      supportClaim: "closed",
      desktopProtocol,
      tray: Object.freeze({
        host: trayHost,
        assetAvailable: trayAssetAvailable,
        observable: trayObservable,
        qualified: false,
      }),
      autostart,
      sessionBus: Object.freeze({ available: sessionBusAvailable }),
      notifications: Object.freeze({ status: "unavailable", qualified: false }),
    });
  }

  return Object.freeze({ inspect });
}
