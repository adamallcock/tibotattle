import { posix } from "node:path";

export const LINUX_TRAY_ASSET_CONTRACT = "linux-tray-asset-v1";
export const LINUX_TRAY_ICON_RELATIVE_PATH =
  "apps/web/public/tibotattle-icon.png";

const ASSETS = new WeakSet();

function fail() {
  const error = new Error("Linux tray asset is unavailable");
  error.name = "LinuxTrayAssetError";
  error.code = "linux_tray_asset_invalid";
  throw error;
}

/**
 * Resolve only the reviewed application artwork. Callers cannot supply an
 * asset path, icon name, desktop identity, or size and therefore cannot turn
 * this dormant seam into arbitrary filesystem access.
 */
export function resolveLinuxTrayAsset({
  platform = process.platform,
  resourceRoot,
} = {}) {
  if (platform !== "linux"
      || typeof resourceRoot !== "string"
      || resourceRoot.length === 0
      || resourceRoot.includes("\0")
      || !posix.isAbsolute(resourceRoot)
      || posix.resolve(resourceRoot) !== resourceRoot
      || resourceRoot === posix.parse(resourceRoot).root) {
    fail();
  }
  const value = Object.freeze({
    contractVersion: LINUX_TRAY_ASSET_CONTRACT,
    platform: "linux",
    relativePath: LINUX_TRAY_ICON_RELATIVE_PATH,
    absolutePath: posix.join(resourceRoot, LINUX_TRAY_ICON_RELATIVE_PATH),
    desktopIconName: "tibotattle",
    colorMode: "full-color",
    nominalSizes: Object.freeze([16, 22, 24, 32]),
    integrationStatus: "dormant",
    developmentOnly: true,
  });
  ASSETS.add(value);
  return value;
}

export function assertLinuxTrayAsset(value) {
  if (!ASSETS.has(value)) fail();
  return value;
}
