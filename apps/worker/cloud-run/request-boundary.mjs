function configurationError(code) {
  throw Object.assign(new Error(code), { code });
}

function invalidRequestHost() {
  throw Object.assign(new Error("REQUEST_HOST_INVALID"), {
    code: "REQUEST_HOST_INVALID",
    status: 421,
  });
}

function canonicalOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { configurationError(`${name}_INVALID`); }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || url.origin !== value) {
    configurationError(`${name}_INVALID`);
  }
  return url;
}

/**
 * Builds the exact origins accepted by the Node host. The old single-host
 * configuration remains valid; split mode requires the admin origin to match
 * the application-derived admin hostname and its canonical public origin.
 */
export function createRequestOriginAllowlist({
  publicHostOrigin,
  canonicalPublicOrigin,
  adminHostOrigin,
}) {
  const publicUrl = canonicalOrigin(publicHostOrigin, "HOST_ORIGIN");
  const entries = [{ kind: "public", origin: publicUrl.origin, host: publicUrl.host.toLowerCase() }];
  if (adminHostOrigin !== undefined) {
    const canonicalPublicUrl = canonicalPublicOrigin === undefined
      ? null
      : canonicalOrigin(canonicalPublicOrigin, "PUBLIC_ORIGIN");
    const adminUrl = canonicalOrigin(adminHostOrigin, "ADMIN_HOST_ORIGIN");
    if (canonicalPublicUrl === null
        || canonicalPublicUrl.protocol !== "https:"
        || canonicalPublicUrl.origin !== publicUrl.origin
        || adminUrl.protocol !== "https:"
        || adminUrl.origin !== `https://admin.${canonicalPublicUrl.hostname}`) {
      configurationError("ADMIN_HOST_ORIGIN_INVALID");
    }
    entries.push({ kind: "admin", origin: adminUrl.origin, host: adminUrl.host.toLowerCase() });
  }
  if (new Set(entries.map((entry) => entry.host)).size !== entries.length) {
    configurationError("HOST_ORIGIN_ALLOWLIST_INVALID");
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

/** Resolve only an exact authority installed in the composition-root allowlist. */
export function requestOriginForHost(hostHeader, allowlist) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0 || hostHeader.length > 512) {
    invalidRequestHost();
  }
  const requestedHost = hostHeader.toLowerCase();
  const entry = allowlist.find((candidate) => candidate.host === requestedHost);
  if (!entry) invalidRequestHost();
  return entry;
}

export function sanitizeHeaders(headers, { preserveAccessAssertion = false } = {}) {
  const result = new Headers();
  for (const [name, rawValue] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    const accessAssertion = lower === "cf-access-jwt-assertion";
    if ((lower.startsWith("cf-") && !(preserveAccessAssertion && accessAssertion))
        || lower.startsWith("x-forwarded-")
        || lower === "x-serverless-authorization") continue;
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    result.append(name, value);
  }
  return result;
}

export function buildRequestUrl(rawUrl, host, publicOrigin) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 16_384) {
    configurationError("REQUEST_URL_INVALID");
  }
  let url;
  try { url = new URL(rawUrl, publicOrigin); } catch { configurationError("REQUEST_URL_INVALID"); }
  const configured = new URL(publicOrigin);
  if (url.origin !== configured.origin || url.host !== host.toLowerCase()) {
    configurationError("REQUEST_HOST_INVALID");
  }
  return url;
}
