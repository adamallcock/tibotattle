const { contextBridge, ipcRenderer } = require("electron");

const ACTION_CHANNEL = "tibotattle:electron-tray-popover:v1";
const MODEL_CHANNEL = "tibotattle:electron-tray-popover-model:v1";
const VISIBILITY_CHANNEL = "tibotattle:electron-tray-popover-visibility:v1";
const ACTIONS = new Set([
  "open",
  "weekly",
  "timeline",
  "accounting",
  "refresh",
  "settings",
  "quit",
]);

function requestAction(action) {
  if (!ACTIONS.has(action) || typeof ipcRenderer?.send !== "function") return;
  try {
    ipcRenderer.send(ACTION_CHANNEL, action);
  } catch {
    // A closing transient window cannot surface a renderer exception.
  }
}

function subscribe(listener) {
  if (typeof listener !== "function" || typeof ipcRenderer?.on !== "function") {
    return () => {};
  }
  const handler = (_event, model) => {
    try {
      listener(model);
    } catch {
      // Rendering remains presentation-only and cannot affect the main shell.
    }
  };
  ipcRenderer.on(MODEL_CHANNEL, handler);
  return () => ipcRenderer.removeListener?.(MODEL_CHANNEL, handler);
}

let visible = false;
const visibilityListeners = new Set();
function handleVisibility(_event, value) {
  if (typeof value !== "boolean") return;
  visible = value;
  for (const listener of visibilityListeners) {
    try {
      listener(value);
    } catch {
      // A renderer listener cannot affect the main-process visibility state.
    }
  }
}

if (typeof ipcRenderer?.on === "function") {
  ipcRenderer.on(VISIBILITY_CHANNEL, handleVisibility);
}

function getVisibility() {
  return visible;
}

function subscribeVisibility(listener) {
  if (typeof listener !== "function") return () => {};
  visibilityListeners.add(listener);
  return () => visibilityListeners.delete(listener);
}

if (typeof contextBridge?.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld("tibotattleTrayPopover", Object.freeze({
    version: "v1",
    requestAction,
    onModel: subscribe,
    getVisibility,
    onVisibility: subscribeVisibility,
  }));
}
