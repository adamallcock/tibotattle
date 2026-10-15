import {
  startLocalCompanionServer as startServer,
} from "../../apps/local/server.js";

// This test client models the trusted in-process composition root. It never
// discovers credentials over HTTP. Security-boundary tests use globalThis.fetch
// directly when they intend to exercise an unauthenticated caller.
const applications = new Map();

export async function startLocalCompanionServer(options) {
  const app = await startServer(options);
  applications.set(String(app.port), app);
  const close = app.close.bind(app);
  app.close = async (...args) => {
    if (applications.get(String(app.port)) === app) {
      applications.delete(String(app.port));
    }
    return close(...args);
  };
  return app;
}

export function localAuthorizationHeaders({ port, path, method = "GET" }) {
  const app = applications.get(String(port));
  if (!app) return {};
  const pathname = new URL(path, "http://127.0.0.1").pathname;
  return app.localAuthorizationHeaders({
    method: pathname.startsWith("/api/") ? method : "GET",
    path: pathname,
  });
}

export function fetch(input, options = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return globalThis.fetch(input, options);
  }
  const method = options.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(localAuthorizationHeaders({
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
  }));
  const provided = options.headers ?? (input instanceof Request ? input.headers : undefined);
  for (const [key, value] of new Headers(provided)) headers.set(key, value);
  return globalThis.fetch(input, { ...options, headers });
}
