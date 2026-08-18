import { shellError } from "./errors.js";

export const ELECTRON_LOOPBACK_HOST = "127.0.0.1";

function exactLoopbackOrigin(value) {
  if (typeof value !== "string") throw shellError("invalid_loopback_origin");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw shellError("invalid_loopback_origin");
  }
  if (parsed.protocol !== "http:"
      || parsed.hostname !== ELECTRON_LOOPBACK_HOST
      || !parsed.port
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin !== value) {
    throw shellError("invalid_loopback_origin");
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw shellError("invalid_loopback_origin");
  }
  return parsed.origin;
}

export function isExactLoopbackOrigin(value) {
  try {
    exactLoopbackOrigin(value);
    return true;
  } catch {
    return false;
  }
}

export function isAllowedCompanionURL(url, allowedOrigin) {
  let selectedOrigin;
  try {
    selectedOrigin = exactLoopbackOrigin(allowedOrigin);
  } catch {
    return false;
  }
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === selectedOrigin
    && parsed.protocol === "http:"
    && parsed.hostname === ELECTRON_LOOPBACK_HOST
    && parsed.username === ""
    && parsed.password === "";
}

/**
 * Electron event handlers for the private dashboard. Navigation is allowed
 * only inside the exact companion origin selected from its ready line;
 * permission requests and new windows are denied unconditionally.
 */
export function createLoopbackNavigationPolicy({ origin } = {}) {
  const allowedOrigin = exactLoopbackOrigin(origin);
  const policy = {
    origin: allowedOrigin,
    isAllowedURL(url) {
      return isAllowedCompanionURL(url, allowedOrigin);
    },
    handleWillNavigate(event, url) {
      const allowed = isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillRedirect(event, url) {
      const allowed = isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillFrameNavigate(event, details) {
      const url = typeof details === "string" ? details : details?.url;
      const allowed = details?.isMainFrame === true
        && isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillAttachWebview(event) {
      event?.preventDefault?.();
      return false;
    },
    handleWindowOpen() {
      return Object.freeze({ action: "deny" });
    },
    handlePermissionRequest({ callback } = {}) {
      callback?.(false);
      return false;
    },
    handlePermissionCheck() {
      return false;
    },
    handleBeforeRequest(details, callback) {
      const allowed = isAllowedCompanionURL(details?.url, allowedOrigin);
      callback?.({ cancel: !allowed });
      return allowed;
    },
  };
  return Object.freeze(policy);
}

export function installLoopbackNavigationPolicy({
  webContents,
  session,
  policy,
} = {}) {
  if (!webContents || typeof webContents.on !== "function") {
    throw new TypeError("webContents is required");
  }
  if (!policy || typeof policy.isAllowedURL !== "function") {
    throw new TypeError("policy is required");
  }
  const onWillNavigate = (event, url) => policy.handleWillNavigate(event, url);
  const onWillRedirect = (event, url) => policy.handleWillRedirect(event, url);
  const onWillFrameNavigate = (event, details) => (
    policy.handleWillFrameNavigate(event, details)
  );
  const onWillAttachWebview = (event) => policy.handleWillAttachWebview(event);
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-redirect", onWillRedirect);
  webContents.on("will-frame-navigate", onWillFrameNavigate);
  webContents.on("will-attach-webview", onWillAttachWebview);
  webContents.setWindowOpenHandler?.(() => policy.handleWindowOpen());
  session?.setPermissionRequestHandler?.((_contents, _permission, callback) => {
    policy.handlePermissionRequest({ callback });
  });
  session?.setPermissionCheckHandler?.(() => policy.handlePermissionCheck());
  const requestFilter = { urls: ["<all_urls>"] };
  const onBeforeRequest = (details, callback) => (
    policy.handleBeforeRequest(details, callback)
  );
  session?.webRequest?.onBeforeRequest?.(requestFilter, onBeforeRequest);
  return Object.freeze({
    remove() {
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      session?.webRequest?.onBeforeRequest?.(requestFilter, null);
    },
  });
}
