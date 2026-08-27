const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "tibotattle:electron-recovery:v1";
const ACTIONS = new Set(["retry", "settings", "diagnostics", "quit"]);

function send(action) {
  if (!ACTIONS.has(action) || typeof ipcRenderer?.send !== "function") return;
  try {
    ipcRenderer.send(CHANNEL, action);
  } catch {
    // A closing recovery window cannot turn a bounded action into a renderer
    // exception or an unhandled main-process rejection.
  }
}

if (typeof contextBridge?.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld("tibotattleRecovery", Object.freeze({
    version: "v1",
    retry: () => send("retry"),
    settings: () => send("settings"),
    diagnostics: () => send("diagnostics"),
    quit: () => send("quit"),
  }));
}
