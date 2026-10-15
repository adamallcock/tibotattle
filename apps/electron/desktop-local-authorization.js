import { isAllowedCompanionURL, isExactLoopbackOrigin } from "./loopback-policy.js";
import { shellError } from "./errors.js";

const CAPABILITY_HEADER = "X-TiboTattle-Local-Capability";
const OPERATION_HEADER = "X-TiboTattle-Operation-Authorization";
const installations = new WeakMap();
const PRIVATE_REPORT_PATHS = new Set([
  "/reports/gradient", "/reports/weekly", "/reports/quality", "/reports/multi-surface",
]);

export function isPrivateCompanionURL(url, origin) {
  if (!isAllowedCompanionURL(url, origin)) return false;
  const path = new URL(url).pathname;
  return path.startsWith("/api/") || PRIVATE_REPORT_PATHS.has(path);
}

function withoutPrivateHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => (
    ![CAPABILITY_HEADER.toLowerCase(), OPERATION_HEADER.toLowerCase()]
      .includes(name.toLowerCase())
  )));
}

function isTrustedRequest(details, registration, origin) {
  if (!registration || !isPrivateCompanionURL(details.url, origin)) return false;
  try {
    const { webContents } = registration;
    return !webContents.isDestroyed?.()
      && details.webContentsId === webContents.id
      && (details.webContents === undefined || details.webContents === webContents)
      && details.frame !== null && details.frame !== undefined
      && details.frame === webContents.mainFrame
      && isAllowedCompanionURL(webContents.getURL(), origin)
      && isAllowedCompanionURL(details.frame.url, origin);
  } catch {
    return false;
  }
}

/**
 * The capability stays in the main process. The session hook adds it only to
 * a request from a registered live window's exact trusted main frame. A
 * browser, another WebContents, a detached frame, or a worker cannot inherit
 * the window's authority by merely addressing the loopback service.
 */
export function installDesktopLocalAuthorization({
  session,
  webContents,
  origin,
  requestAuthorizationHeaders,
} = {}) {
  if (!isExactLoopbackOrigin(origin)
      || !Number.isSafeInteger(webContents?.id)
      || typeof requestAuthorizationHeaders !== "function"
      || typeof session?.webRequest?.onBeforeSendHeaders !== "function") {
    throw new TypeError("desktop local authorization configuration is invalid");
  }
  let installation = installations.get(session);
  if (installation && (installation.origin !== origin
      || installation.requestAuthorizationHeaders !== requestAuthorizationHeaders)) {
    throw new TypeError("desktop local authorization session conflict");
  }
  if (!installation) {
    const registrations = new Map();
    const filter = { urls: ["<all_urls>"] };
    const handler = (details, callback) => {
      const requestHeaders = withoutPrivateHeaders(details.requestHeaders);
      const registration = registrations.get(details.webContentsId);
      if (isTrustedRequest(details, registration, origin)) {
        try {
          // Replace any renderer-supplied capability. The operation token is
          // independently scoped, short-lived and single use at the server.
          Object.assign(requestHeaders, requestAuthorizationHeaders(details.url));
          for (const [name, value] of Object.entries(details.requestHeaders ?? {})) {
            if (name.toLowerCase() === OPERATION_HEADER.toLowerCase()) {
              requestHeaders[OPERATION_HEADER] = value;
            }
          }
        } catch {
          callback({ cancel: true, requestHeaders });
          return;
        }
      }
      callback({ requestHeaders });
    };
    installation = { origin, requestAuthorizationHeaders, registrations, filter };
    session.webRequest.onBeforeSendHeaders(filter, handler);
    installations.set(session, installation);
  }
  if (installation.registrations.has(webContents.id)) {
    throw new TypeError("desktop local authorization window already registered");
  }
  const registration = { webContents };
  installation.registrations.set(webContents.id, registration);
  let removed = false;
  return Object.freeze({
    remove() {
      if (removed) return;
      removed = true;
      if (installation.registrations.get(webContents.id) === registration) {
        installation.registrations.delete(webContents.id);
      }
      if (installation.registrations.size === 0) {
        session.webRequest.onBeforeSendHeaders(installation.filter, null);
        installations.delete(session);
      }
    },
  });
}

/** Wrap the main process status poll without making auth available to UI DTOs. */
export function createAuthorizedCompanionFetch({ fetchImpl, requestAuthorizationHeaders }) {
  if (typeof fetchImpl !== "function" || typeof requestAuthorizationHeaders !== "function") {
    throw new TypeError("desktop local fetch configuration is invalid");
  }
  return (url, options = {}) => fetchImpl(url, {
    ...options,
    headers: {
      ...withoutPrivateHeaders(Object.fromEntries(new Headers(options.headers))),
      ...requestAuthorizationHeaders(url),
    },
    // Never forward an authenticated main-process request through a redirect.
    redirect: "error",
  });
}

async function readBoundedAuthorizationReply(response, signal) {
  if (response?.status !== 200 || typeof response.body?.getReader !== "function") {
    throw new Error("authorization response invalid");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Closed reader. */ }
  };
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256) throw new Error("authorization response invalid");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    // Cancellation is best effort and cannot extend the overall deadline.
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Create the owner-only browser bootstrap only for an explicit desktop action. */
export async function prepareDesktopBrowserAuthorization({ origin, fetchImpl, requestAuthorizationHeaders }) {
  if (!isExactLoopbackOrigin(origin) || typeof fetchImpl !== "function"
      || typeof requestAuthorizationHeaders !== "function") {
    throw shellError("desktop_dashboard_browser_unavailable");
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(shellError("desktop_dashboard_browser_unavailable"));
    }, 5_000);
    timer.unref?.();
  });
  const bootstrapPath = "/api/local/authorization/browser-bootstrap";
  async function post(path, body, operationAuthorization) {
    controller.signal.throwIfAborted();
    const url = `${origin}${path}`;
    return readBoundedAuthorizationReply(await fetchImpl(url, {
      method: "POST", body: JSON.stringify(body), cache: "no-store", credentials: "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: {
        ...requestAuthorizationHeaders(url), Origin: origin,
        "Content-Type": "application/json", "X-Usage-Monitor-Local": "1",
        ...(operationAuthorization === undefined ? {} : { [OPERATION_HEADER]: operationAuthorization }),
      },
    }), controller.signal);
  }
  try {
    return await Promise.race([deadline, (async () => {
      const grant = await post("/api/local/authorization", { method: "POST", path: bootstrapPath });
      if (grant === null || typeof grant !== "object" || Array.isArray(grant)
          || Object.keys(grant).length !== 1
          || typeof grant.authorization !== "string"
          || !/^[A-Za-z0-9_-]{43}$/u.test(grant.authorization)) throw new Error("invalid grant");
      const result = await post(bootstrapPath, {}, grant.authorization);
      if (result === null || typeof result !== "object" || Array.isArray(result)
          || Object.keys(result).length !== 1 || result.available !== true) {
        throw new Error("browser bootstrap unavailable");
      }
      return true;
    })()]);
  } catch {
    throw shellError("desktop_dashboard_browser_unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
