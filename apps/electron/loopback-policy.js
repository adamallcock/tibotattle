import { shellError } from "./errors.js";

export const ELECTRON_LOOPBACK_HOST = "127.0.0.1";

// Electron's permission and webRequest handlers belong to a Session, not to
// an individual BrowserWindow.  The dashboard and Settings windows normally
// use the same default session, so installing the policy for the second
// window must not replace the first window's handlers (and removing the
// second window must not remove the first window's filtering).  Keep one
// session-level installation alive until its last window releases it.
const sessionPolicyInstallations = new WeakMap();

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

function isAllowedCompanionBlobURL(url, allowedOrigin) {
  let selectedOrigin;
  try {
    selectedOrigin = exactLoopbackOrigin(allowedOrigin);
  } catch {
    return false;
  }
  if (typeof url !== "string") return false;
  let parsed;
  let creator;
  try {
    parsed = new URL(url);
    creator = new URL(parsed.pathname);
  } catch {
    return false;
  }
  return parsed.protocol === "blob:"
    && parsed.origin === selectedOrigin
    && parsed.search === ""
    && parsed.hash === ""
    && creator.origin === selectedOrigin
    && creator.protocol === "http:"
    && creator.hostname === ELECTRON_LOOPBACK_HOST
    && creator.username === ""
    && creator.password === ""
    && creator.pathname.length > 1
    && creator.search === ""
    && creator.hash === "";
}

export function isAllowedCompanionBlobDownload(details, allowedOrigin, webContentsId) {
  return isAllowedCompanionBlobURL(details?.url, allowedOrigin)
    && details?.method === "GET"
    // Chromium reports blob anchor downloads as `other`; image/XHR/media
    // Blob requests must remain denied. The webContents identity is the
    // dashboard-only capability, so Settings cannot borrow this permission.
    && details?.resourceType === "other"
    && Number.isSafeInteger(webContentsId)
    && details?.webContentsId === webContentsId;
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
    handleBeforeRequest(details, callback, {
      allowBlobDownloadWebContentsId = null,
    } = {}) {
      const allowed = isAllowedCompanionURL(details?.url, allowedOrigin)
        || (allowBlobDownloadWebContentsId !== null
          && isAllowedCompanionBlobDownload(
            details,
            allowedOrigin,
            allowBlobDownloadWebContentsId,
          ));
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
  allowBlobDownloads = false,
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

  let sessionInstallation;
  const blobDownloadWebContentsId = allowBlobDownloads
    && Number.isSafeInteger(webContents.id)
    ? webContents.id
    : null;
  const canTrackSession = session !== null
    && session !== undefined
    && (typeof session === "object" || typeof session === "function");
  if (canTrackSession) {
    sessionInstallation = sessionPolicyInstallations.get(session);
    if (sessionInstallation === undefined) {
      const requestFilter = { urls: ["<all_urls>"] };
      const onPermissionRequest = (_contents, _permission, callback) => {
        policy.handlePermissionRequest({ callback });
      };
      const onPermissionCheck = () => policy.handlePermissionCheck();
      const blobDownloadWebContentsIds = new Set();
      const onBeforeRequest = (details, callback) => (
        policy.handleBeforeRequest(details, callback, {
          allowBlobDownloadWebContentsId: blobDownloadWebContentsIds.has(details?.webContentsId)
            ? details.webContentsId
            : null,
        })
      );
      session.setPermissionRequestHandler?.(onPermissionRequest);
      session.setPermissionCheckHandler?.(onPermissionCheck);
      session.webRequest?.onBeforeRequest?.(requestFilter, onBeforeRequest);
      sessionInstallation = {
        count: 0,
        policyOrigin: policy.origin ?? null,
        requestFilter,
        onPermissionRequest,
        onPermissionCheck,
        onBeforeRequest,
        blobDownloadWebContentsIds,
      };
      sessionPolicyInstallations.set(session, sessionInstallation);
    } else if (sessionInstallation.policyOrigin !== (policy.origin ?? null)) {
      // A single Electron session cannot safely enforce two different
      // companion origins.  Refuse the second installation rather than
      // silently letting one window broaden or replace the other window's
      // network policy.
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      throw new TypeError("session loopback policy origin conflict");
    }
    sessionInstallation.count += 1;
    if (blobDownloadWebContentsId !== null) {
      sessionInstallation.blobDownloadWebContentsIds.add(blobDownloadWebContentsId);
    }
  }

  let removed = false;
  return Object.freeze({
    remove() {
      if (removed) return;
      removed = true;
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      if (sessionInstallation === undefined) return;
      if (blobDownloadWebContentsId !== null) {
        sessionInstallation.blobDownloadWebContentsIds.delete(blobDownloadWebContentsId);
      }
      sessionInstallation.count -= 1;
      if (sessionInstallation.count > 0) return;
      session.setPermissionRequestHandler?.(null);
      session.setPermissionCheckHandler?.(null);
      session.webRequest?.onBeforeRequest?.(sessionInstallation.requestFilter, null);
      sessionPolicyInstallations.delete(session);
    },
  });
}
