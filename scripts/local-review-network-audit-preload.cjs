"use strict";

// This preload is intentionally outside the participant artifact. It is used
// only by the release smoke runner to count and block standard Node networking
// APIs before the artifact entrypoint evaluates.
const fs = require("node:fs");
const dgram = require("node:dgram");
const dns = require("node:dns");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const AUDIT_FILE = process.env.USAGE_MONITOR_NETWORK_AUDIT_FILE;
const MAXIMUM_RECORDED_ATTEMPTS = 128;
const writeAuditReceipt = fs.writeFileSync.bind(fs);
const counts = new Map();
let totalAttempts = 0;
let truncated = false;

if (typeof AUDIT_FILE !== "string" || !AUDIT_FILE.startsWith("/")) {
  throw new Error("Local-review network audit requires an absolute receipt path");
}

function record(category) {
  totalAttempts += 1;
  counts.set(category, (counts.get(category) ?? 0) + 1);
  if (totalAttempts > MAXIMUM_RECORDED_ATTEMPTS) truncated = true;
  const error = new Error("Network attempt blocked by local-review audit");
  error.code = "USAGE_MONITOR_NETWORK_ATTEMPT_BLOCKED";
  throw error;
}

function patchMethod(target, name, category) {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    return;
  }
  const original = target[name];
  if (typeof original !== "function") return;
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
    writable: false,
    value: function blockedNetworkMethod() {
      return record(category);
    },
  });
}

for (const name of ["connect", "createConnection"]) {
  patchMethod(net, name, "net.connect");
}
patchMethod(net.Socket?.prototype, "connect", "net.socket.connect");
patchMethod(net.Server?.prototype, "listen", "net.server.listen");

patchMethod(tls, "connect", "tls.connect");
patchMethod(tls.TLSSocket?.prototype, "connect", "tls.socket.connect");

for (const name of ["request", "get"]) patchMethod(http, name, `http.${name}`);
for (const name of ["request", "get"]) patchMethod(https, name, `https.${name}`);
patchMethod(http2, "connect", "http2.connect");

for (const name of ["bind", "connect", "send"]) {
  patchMethod(dgram.Socket?.prototype, name, `dgram.${name}`);
}

const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
for (const name of dnsMethods) patchMethod(dns, name, `dns.${name}`);
for (const name of dnsMethods) {
  patchMethod(dns.promises, name, `dns.promises.${name}`);
}
for (const name of dnsMethods.filter((name) => !["lookup", "lookupService"].includes(name))) {
  patchMethod(dns.Resolver?.prototype, name, `dns.resolver.${name}`);
  patchMethod(dns.promises?.Resolver?.prototype, name, `dns.promises.resolver.${name}`);
}

for (const [name, category] of [
  ["fetch", "global.fetch"],
  ["WebSocket", "global.websocket"],
  ["EventSource", "global.eventsource"],
]) {
  if (typeof globalThis[name] !== "function") continue;
  Object.defineProperty(globalThis, name, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: function blockedGlobalNetworkApi() {
      return record(category);
    },
  });
}

process.once("exit", () => {
  const byCategory = Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
  const receipt = {
    schemaVersion: "usage-monitor-local-review-network-attempt-process-v0.1",
    instrumentation: "node-api-interposition-v0.1",
    totalAttempts,
    byCategory,
    truncated,
    maximumRecordedAttempts: MAXIMUM_RECORDED_ATTEMPTS,
    coverage: {
      tcpClient: true,
      tcpServer: true,
      tls: true,
      dnsCallback: true,
      dnsPromise: true,
      http1: true,
      http2: true,
      udp: true,
      fetch: true,
      webSocket: true,
      eventSource: true,
      quic: false,
      nativeSyscalls: false,
      nonNodeChildProcesses: false,
    },
  };
  writeAuditReceipt(AUDIT_FILE, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
});
