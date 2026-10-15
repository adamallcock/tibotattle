// Browser access to the private companion is explicitly bootstrapped. Electron
// supplies the header in its main process; standalone browsers read the owner's
// short-lived authorization file only after an explicit file selection.
const CAPABILITY_HEADER = "X-TiboTattle-Local-Capability";
const OPERATION_HEADER = "X-TiboTattle-Operation-Authorization";
const AUTHORIZATION_PATH = "/api/local/authorization";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_FILE_BYTES = 1024;
const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
const PRIVATE_REPORTS = new Set([
  "/reports/gradient", "/reports/weekly", "/reports/quality", "/reports/multi-surface",
]);

function authorizationError() {
  const error = new Error("Local authorization is required.");
  error.code = "local_caller_not_authorized";
  return error;
}

function localOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.username === "" && url.password === ""
      && url.pathname === "/" && url.search === "" && url.hash === ""
      ? url.origin : null;
  } catch { return null; }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function createLocalRequestClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  origin = globalThis.location?.origin,
  nativeAuthorization = () => globalThis.tibotattleDesktop?.version === "v1"
    || globalThis.tibotattleTrayPopover?.version === "v1",
  now = Date.now,
  onAuthorizationRequired = () => {},
} = {}) {
  const expectedOrigin = localOrigin(origin);
  let capability = null;
  let authorizationGeneration = 0;

  function clear() {
    capability = null;
    authorizationGeneration += 1;
    // Native reconnect belongs to the shell. Its bridge has no file unlock
    // step, so emitting the browser retry event would cause a denied-request
    // reload loop while the companion is unavailable or restarting.
    if (!nativeAuthorization()) onAuthorizationRequired();
  }

  async function inspectAuthorization(response, requestedCapability) {
    if (response.status === 403) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.error?.code === "local_caller_not_authorized"
          && capability === requestedCapability) clear();
    }
    return response;
  }

  async function request(input, options = {}) {
    // Hosted pages do not participate in local authorization. They never have
    // a selected local capability, and use their existing cookie/CSRF contract.
    if (expectedOrigin === null) return fetchImpl(input, options);
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("A fixed local request URL is required.");
    }
    const url = new URL(input, expectedOrigin);
    if (url.origin !== expectedOrigin || url.username || url.password || url.hash) {
      throw new TypeError("A same-origin local request is required.");
    }
    const protectedRoute = url.pathname.startsWith("/api/") || PRIVATE_REPORTS.has(url.pathname);
    if (!protectedRoute) return fetchImpl(input, options);
    if (capability === null && !nativeAuthorization()) throw authorizationError();
    const requestedCapability = capability;
    const headers = new Headers(options.headers);
    // Callers cannot substitute a capability or replay a prior operation token.
    headers.delete(CAPABILITY_HEADER);
    headers.delete(OPERATION_HEADER);
    if (capability !== null) headers.set(CAPABILITY_HEADER, capability);
    const method = (options.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) && url.search !== "") {
      throw new TypeError("A fixed local operation path is required.");
    }
    if (!["GET", "HEAD"].includes(method) && url.pathname !== AUTHORIZATION_PATH) {
      const authorizationResponse = await inspectAuthorization(await fetchImpl(AUTHORIZATION_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: options.signal,
        headers: new Headers([
          ["Accept", "application/json"], ["Content-Type", "application/json"],
          ...(capability === null ? [] : [[CAPABILITY_HEADER, capability]]),
        ]),
        body: JSON.stringify({ method, path: url.pathname }),
      }), requestedCapability);
      if (!authorizationResponse.ok) return authorizationResponse;
      const authorization = await authorizationResponse.json().catch(() => null);
      if (!exactKeys(authorization, ["authorization"])
          || typeof authorization.authorization !== "string" || !TOKEN.test(authorization.authorization)) {
        throw authorizationError();
      }
      headers.set(OPERATION_HEADER, authorization.authorization);
    }
    // Redirects must never carry either authorization to a different endpoint.
    // A failed request is never automatically replayed, including mutations.
    return inspectAuthorization(await fetchImpl(input, {
      ...options, method, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
    }), requestedCapability);
  }

  async function authorizeFile(file) {
    const generation = ++authorizationGeneration;
    capability = null;
    if (expectedOrigin === null || !file || !Number.isSafeInteger(file.size)
        || file.size < 1 || file.size > MAX_FILE_BYTES || typeof file.text !== "function") {
      throw authorizationError();
    }
    let value;
    try {
      const text = await file.text();
      if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw authorizationError();
      value = JSON.parse(text);
    } catch { throw authorizationError(); }
    const current = now();
    if (generation !== authorizationGeneration
        || !exactKeys(value, ["version", "origin", "capability", "expiresAt"])
        || value.version !== 1 || value.origin !== expectedOrigin
        || typeof value.capability !== "string" || !TOKEN.test(value.capability)
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= current
        || value.expiresAt > current + BOOTSTRAP_TTL_MS + 5000) {
      throw authorizationError();
    }
    capability = value.capability;
    try {
      const response = await request("/api/local/health");
      if (!response.ok || generation !== authorizationGeneration) throw authorizationError();
    } catch {
      if (generation === authorizationGeneration) capability = null;
      throw authorizationError();
    }
  }

  return Object.freeze({
    request,
    authorizeFile,
    needsAuthorization: () => expectedOrigin !== null && capability === null && !nativeAuthorization(),
  });
}

let browserClient;
function currentClient() {
  browserClient ??= createLocalRequestClient({
    onAuthorizationRequired: () => globalThis.window?.dispatchEvent(
      new Event("tibotattle:local-authorization-required"),
    ),
  });
  return browserClient;
}

export function localRequest(input, options) {
  return currentClient().request(input, options);
}

export function mountLocalAuthorization({
  documentRef = document,
  windowRef = window,
  client = currentClient(),
  t,
} = {}) {
  let pending = null;
  return Object.freeze({
    authorize() {
      if (!client.needsAuthorization()) return Promise.resolve();
      if (pending !== null) return pending;
      pending = new Promise((resolve) => {
        const dialog = documentRef.createElement("dialog");
        dialog.className = "local-authorization-dialog";
        const heading = documentRef.createElement("h2");
        heading.id = "local-authorization-heading";
        const description = documentRef.createElement("p");
        const status = documentRef.createElement("p");
        status.setAttribute("role", "status");
        const button = documentRef.createElement("button");
        button.type = "button";
        const input = documentRef.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.hidden = true;
        dialog.setAttribute("aria-labelledby", heading.id);
        const relocalize = () => {
          heading.textContent = t("localAuthorization.title");
          description.textContent = t("localAuthorization.description");
          button.textContent = t("localAuthorization.choose");
        };
        relocalize();
        windowRef.addEventListener("tibotattle:locale-change", relocalize);
        button.addEventListener("click", () => input.click());
        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          input.value = "";
          if (!file) return;
          button.disabled = true;
          status.textContent = t("localAuthorization.checking");
          try {
            await client.authorizeFile(file);
            windowRef.removeEventListener("tibotattle:locale-change", relocalize);
            dialog.close();
            dialog.remove();
            pending = null;
            resolve();
          } catch {
            status.textContent = t("localAuthorization.invalid");
            button.disabled = false;
            button.focus();
          }
        });
        dialog.addEventListener("cancel", (event) => event.preventDefault());
        dialog.append(heading, description, button, input, status);
        documentRef.body.append(dialog);
        dialog.showModal();
        button.focus();
      });
      return pending;
    },
  });
}
