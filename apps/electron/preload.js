// This preload intentionally exposes no filesystem, process, or IPC bridge.
// The marker is private to the isolated preload world and exists only for
// diagnostics/tests that need to prove which preload was installed.
const marker = Object.freeze({
  name: "tibotattle-electron-preload",
  version: "v1",
  capabilities: Object.freeze({
    filesystem: false,
    ipc: false,
  }),
});

function markNativeDashboard() {
  const document = globalThis.document;
  document?.documentElement?.classList?.add?.("native-dashboard");
  document?.body?.classList?.add?.("native-dashboard");
}

// The native dashboard CSS hides browser-only chrome using this fixed class.
// Preload runs before the body necessarily exists, so mark the document root
// immediately and repeat exactly once when the body is ready.
markNativeDashboard();
globalThis.document?.addEventListener?.(
  "DOMContentLoaded",
  markNativeDashboard,
  { once: true },
);

Object.defineProperty(globalThis, "__TIBOTATTLE_PRELOAD_MARKER__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: marker,
});
