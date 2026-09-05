const { contextBridge, ipcRenderer } = require("electron");

const ACTION_CHANNEL = "tibotattle:electron-tray-popover:v1";
const MODEL_CHANNEL = "tibotattle:electron-tray-popover-model:v1";
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

if (typeof contextBridge?.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld("tibotattleTrayPopover", Object.freeze({
    version: "v1",
    requestAction,
    onModel: subscribe,
  }));
}
