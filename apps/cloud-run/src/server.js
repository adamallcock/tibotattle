import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createGcsObjectStore,
  createMemoryObjectStore,
} from "./object-store.js";

const MAX_DRAIN_MILLISECONDS = 8_000;
const VALID_ENVIRONMENTS = new Set(["local-test", "contained-staging", "production"]);

function fixedError(code) {
  const error = new Error("Contained Cloud Run service configuration failed");
  error.code = code;
  return error;
}

function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.byteLength,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    severity: "INFO",
    event,
    ...fields,
  })}\n`);
}

export function configurationFromEnvironment(environment = process.env) {
  const selectedEnvironment = environment.ENVIRONMENT ?? "contained-staging";
  const collectionMode = environment.COLLECTION_MODE ?? "disabled";
  const objectStoreMode = environment.OBJECT_STORE_MODE ?? "gcs";
  const port = Number(environment.PORT ?? 8080);
  if (!VALID_ENVIRONMENTS.has(selectedEnvironment)
      || collectionMode !== "disabled"
      || !Number.isSafeInteger(port)
      || port < 0
      || port > 65_535
      || !["gcs", "memory"].includes(objectStoreMode)
      || (objectStoreMode === "memory" && selectedEnvironment !== "local-test")) {
    throw fixedError("configuration_invalid");
  }
  if (objectStoreMode === "gcs"
      && (typeof environment.GCS_BUCKET !== "string"
        || environment.GCS_BUCKET.length < 3)) {
    throw fixedError("storage_configuration_invalid");
  }
  return Object.freeze({
    environment: selectedEnvironment,
    collectionMode,
    objectStoreMode,
    port,
    gcsBucket: environment.GCS_BUCKET ?? null,
    gcsPrefix: environment.GCS_PREFIX ?? "quarantine/v1",
    gcsReadinessObject:
      environment.GCS_READINESS_OBJECT ?? "operations/readiness-v1",
  });
}

export function createContainedServer({ configuration, objectStore }) {
  if (!configuration || !objectStore || typeof objectStore.probe !== "function") {
    throw fixedError("configuration_invalid");
  }
  let draining = false;
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = globalThis.crypto.randomUUID();
    let routeClass = "unknown";
    let status = 404;
    try {
      const url = new URL(request.url, "http://contained.invalid");
      if (url.search || url.hash) {
        status = 400;
        json(response, status, { error: { code: "invalid_request" } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        routeClass = "liveness";
        status = 200;
        json(response, status, {
          schemaVersion: "contained-cloud-run-health-v0.1",
          status: "ok",
          collectionMode: "disabled",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        routeClass = "readiness";
        const storageReady = !draining && await objectStore.probe();
        status = storageReady ? 200 : 503;
        json(response, status, {
          schemaVersion: "contained-cloud-run-readiness-v0.1",
          status: storageReady ? "ready" : "not_ready",
          checks: {
            draining: draining ? "blocked" : "ok",
            objectStore: storageReady ? "ok" : "unavailable",
            metadataStore: "not_implemented",
            collection: "disabled",
          },
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        routeClass = "contained_api";
        status = 503;
        json(response, status, {
          error: { code: "collection_disabled" },
        });
        return;
      }
      status = 404;
      json(response, status, { error: { code: "not_found" } });
    } catch {
      status = 500;
      if (!response.headersSent) {
        json(response, status, { error: { code: "internal_error" } });
      } else {
        response.destroy();
      }
    } finally {
      log("request_completed", {
        requestId,
        routeClass,
        status,
        durationMs: Math.min(Date.now() - startedAt, 60_000),
      });
    }
  });
  return Object.freeze({
    server,
    setDraining(value) {
      draining = value === true;
    },
  });
}

export async function startContainedService({
  environment = process.env,
  configuration = configurationFromEnvironment(environment),
  objectStore = configuration.objectStoreMode === "memory"
    ? createMemoryObjectStore()
    : createGcsObjectStore({
      bucketName: configuration.gcsBucket,
      prefix: configuration.gcsPrefix,
      readinessObject: configuration.gcsReadinessObject,
    }),
} = {}) {
  const app = createContainedServer({ configuration, objectStore });
  await new Promise((resolveListen, rejectListen) => {
    app.server.once("error", rejectListen);
    app.server.listen(configuration.port, "0.0.0.0", () => {
      app.server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : null;
  return Object.freeze({
    ...app,
    port,
    async close() {
      app.setDraining(true);
      await new Promise((resolveClose) => {
        const force = setTimeout(() => {
          app.server.closeAllConnections?.();
          resolveClose();
        }, MAX_DRAIN_MILLISECONDS);
        force.unref?.();
        app.server.close(() => {
          clearTimeout(force);
          resolveClose();
        });
      });
    },
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const app = await startContainedService();
  log("service_started", {
    port: app.port,
    environment: process.env.ENVIRONMENT ?? "contained-staging",
    collectionMode: "disabled",
  });
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    log("service_draining", { signal });
    await app.close();
    log("service_stopped");
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
}
