// Qualification API traffic belongs to the already-selected trusted renderer.
// The main process supplies its private capability; it never crosses CDP.
const READ_PATHS = new Set([
  "/api/health", "/api/local/health", "/api/local/overview", "/api/local/refresh",
  "/api/local/onboarding", "/api/local/gradient", "/api/local/weekly",
  "/api/local/quality", "/api/local/model-performance",
  "/reports/gradient", "/reports/weekly", "/reports/quality", "/reports/multi-surface",
]);
const POST_PATHS = new Set([
  "/api/local/work-usage/query", "/api/local/refresh", "/api/local/refresh/quick",
  "/api/local/refresh/cancel",
]);
const MAXIMUM_BYTES = 16 * 1024 * 1024;

function unavailable(status) {
  return Object.assign(new Error("Authorized renderer response unavailable"), {
    code: "AUTHORIZED_RENDERER_RESPONSE_UNAVAILABLE",
    ...(Number.isInteger(status) ? { status } : {}),
  });
}

export function createAuthorizedRendererFetch(cdp, {
  timeoutMs = 20_000,
  maximumBytes = 4 * 1024 * 1024,
} = {}) {
  if (typeof cdp?.evaluate !== "function" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1 || maximumBytes > MAXIMUM_BYTES) throw unavailable();
  return async (input, options = {}) => {
    let url;
    try { url = new URL(input); } catch { throw unavailable(); }
    const method = options.method ?? "GET";
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.hash
        || (method === "GET" ? !READ_PATHS.has(url.pathname) : method !== "POST" || !POST_PATHS.has(url.pathname))
        || (options.body !== undefined && (typeof options.body !== "string" || Buffer.byteLength(options.body) > 65_536))) {
      throw unavailable();
    }
    const headers = new Headers(options.headers);
    if ([...headers.keys()].some((key) => !["accept", "content-type", "x-usage-monitor-local"].includes(key))) throw unavailable();
    options.signal?.throwIfAborted();
    const request = { url: url.href, method, headers: [...headers], body: options.body ?? null, timeoutMs, maximumBytes };
    const expression = `(async () => {
      const input = ${JSON.stringify(request)};
      if (location.origin !== new URL(input.url).origin || globalThis.tibotattleDesktop?.version !== "v1") return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      let reader;
      try {
        const request = input.method === "GET" ? fetch : (await import("/local-request.js")).localRequest;
        const response = await request(input.url, { method: input.method, headers: input.headers,
          ...(input.body === null ? {} : { body: input.body }), signal: controller.signal,
          credentials: "same-origin", cache: "no-store", redirect: "error" });
        if (response.redirected || !Number.isInteger(response.status)) return null;
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\\d+$/.test(declared) || Number(declared) > input.maximumBytes)) return null;
        reader = response.body?.getReader();
        if (!reader) return null;
        const chunks = []; let bytes = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > input.maximumBytes) return null;
          chunks.push(next.value);
        }
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return { status: response.status, body: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
      } catch { return null; }
      finally { clearTimeout(timer); controller.abort(); try { void reader?.cancel().catch(() => {}); } catch {} }
    })()`;
    let timer;
    let removeAbort = () => {};
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), timeoutMs);
        const abort = () => reject(unavailable());
        options.signal?.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
      });
      const value = await Promise.race([cdp.evaluate(expression), deadline]);
      if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599
          || typeof value.body !== "string" || Buffer.byteLength(value.body) > maximumBytes) throw unavailable();
      return new Response([204, 205, 304].includes(value.status) ? null : value.body, {
        status: value.status, headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error?.code === "AUTHORIZED_RENDERER_RESPONSE_UNAVAILABLE") throw error;
      throw unavailable();
    } finally { clearTimeout(timer); removeAbort(); }
  };
}

export async function fetchRendererJson(cdp, url, options = {}) {
  const response = await createAuthorizedRendererFetch(cdp, options)(url, options);
  if (!response.ok) throw unavailable(response.status);
  try { return await response.json(); } catch { throw unavailable(response.status); }
}

export async function fetchRendererJsonResponse(cdp, url, options = {}) {
  const response = await createAuthorizedRendererFetch(cdp, options)(url, options);
  if (!response.ok) return { status: response.status, body: null };
  try { return { status: response.status, body: await response.json() }; }
  catch { throw unavailable(response.status); }
}
