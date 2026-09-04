import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinuxDesktopCapabilityAdapter,
} from "../linux-desktop-capabilities.js";
import {
  LINUX_TRAY_ICON_RELATIVE_PATH,
  resolveLinuxTrayAsset,
} from "../linux-tray-assets.js";

test("Linux tray asset resolver owns one fixed dormant asset", () => {
  const asset = resolveLinuxTrayAsset({
    platform: "linux",
    resourceRoot: "/opt/TiboTattle/resources",
  });
  assert.equal(asset.relativePath, LINUX_TRAY_ICON_RELATIVE_PATH);
  assert.equal(
    asset.absolutePath,
    "/opt/TiboTattle/resources/apps/web/public/tibotattle-icon.png",
  );
  assert.equal(asset.integrationStatus, "dormant");
  assert.equal(asset.developmentOnly, true);
  assert.throws(
    () => resolveLinuxTrayAsset({ platform: "linux", resourceRoot: "relative" }),
    (error) => error?.code === "linux_tray_asset_invalid",
  );
});

test("Linux desktop capability status remains closed even with an observable tray", async () => {
  const asset = resolveLinuxTrayAsset({
    platform: "linux",
    resourceRoot: "/opt/TiboTattle/resources",
  });
  const adapter = createLinuxDesktopCapabilityAdapter({
    platform: "linux",
    autostartOwner: {
      status: async () => ({ status: "enabled", canSet: true, privatePath: "/home/ada" }),
    },
  });
  const status = await adapter.inspect({
    desktopProtocol: "wayland",
    trayHost: "status-notifier",
    trayAsset: asset,
    sessionBusAvailable: true,
  });
  assert.deepEqual(status, {
    contractVersion: "linux-desktop-capabilities-v1",
    platform: "linux",
    integrationStatus: "dormant",
    developmentOnly: true,
    supportClaim: "closed",
    desktopProtocol: "wayland",
    tray: {
      host: "status-notifier",
      assetAvailable: true,
      observable: true,
      qualified: false,
    },
    autostart: { status: "enabled", canSet: true },
    sessionBus: { available: true },
    notifications: { status: "unavailable", qualified: false },
  });
  assert.equal(JSON.stringify(status).includes("/home/ada"), false);
});

test("Linux desktop capability rejects ambiguous probes, forged assets, and accessors", async () => {
  const adapter = createLinuxDesktopCapabilityAdapter({ platform: "linux" });
  await assert.rejects(
    adapter.inspect({ sessionBusAvailable: "yes" }),
    (error) => error?.code === "linux_desktop_capability_probe_invalid",
  );
  await assert.rejects(
    adapter.inspect({
      trayAsset: {
        relativePath: LINUX_TRAY_ICON_RELATIVE_PATH,
        absolutePath: "/tmp/forged.png",
      },
    }),
    (error) => error?.code === "linux_tray_asset_invalid",
  );
  let getterCalls = 0;
  const configuration = {};
  Object.defineProperty(configuration, "desktopProtocol", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "x11";
    },
  });
  await assert.rejects(
    adapter.inspect(configuration),
    (error) => error?.code === "linux_desktop_capability_configuration_invalid",
  );
  assert.equal(getterCalls, 0);
});

test("Linux desktop capability maps an owner failure to a fixed content-free status", async () => {
  const adapter = createLinuxDesktopCapabilityAdapter({
    platform: "linux",
    autostartOwner: {
      status: async () => {
        throw new Error("/home/ada/.config/autostart private detail");
      },
    },
  });
  const status = await adapter.inspect();
  assert.deepEqual(status.autostart, { status: "error", canSet: false });
  assert.equal(JSON.stringify(status).includes("/home/ada"), false);
});
