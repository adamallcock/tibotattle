/**
 * Small Electron-only bridge for controls that belong to the desktop shell,
 * not to the hosted dashboard. It intentionally has no filesystem or URL
 * input: Settings is one fixed local route/bridge action and Share is one
 * fixed dashboard panel.
 */

const ELECTRON_API_VERSION = "v1";
const LANGUAGE_VALUES = new Set(["system", "en", "zh-Hans", "es"]);
const LANGUAGE_PICKER_VALUES = Object.freeze({
  system: "system",
  en: "en-US",
  "zh-Hans": "zh-Hans",
  es: "es",
});
const DESKTOP_LANGUAGE_BY_PICKER_VALUE = Object.freeze(
  Object.fromEntries(
    Object.entries(LANGUAGE_PICKER_VALUES).map(([desktop, picker]) => [picker, desktop]),
  ),
);

function electronDashboard(documentRef) {
  return documentRef?.documentElement?.classList?.contains("electron-dashboard") === true
    || documentRef?.body?.classList?.contains("electron-dashboard") === true;
}

function focusSharePanel(documentRef, windowRef) {
  const panel = documentRef?.querySelector?.("#share-panel");
  if (!panel) return false;
  panel.setAttribute?.("tabindex", "-1");
  const focus = () => {
    panel.focus?.({ preventScroll: true });
    let reduceMotion = false;
    try {
      reduceMotion = windowRef?.matchMedia?.("(prefers-reduced-motion: reduce)")
        ?.matches === true;
    } catch {
      // A presentation-only media-query failure must not make Share unusable.
    }
    panel.scrollIntoView?.({
      block: "start",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };
  if (typeof windowRef?.requestAnimationFrame === "function") {
    windowRef.requestAnimationFrame(focus);
  } else {
    windowRef?.setTimeout?.(focus, 0);
  }
  return true;
}

function openSettings(windowRef) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version === ELECTRON_API_VERSION
      && typeof bridge.openSettings === "function") {
    void bridge.openSettings();
  }
}

function readPersistedLanguage(bridge, applyLanguage) {
  if (typeof bridge?.getSettings !== "function") return;
  void bridge.getSettings().then((state) => {
    const candidate = state?.settings?.language ?? state?.language;
    applyLanguage(candidate);
  }).catch(() => {});
}

function dispatchFixedDesktopEvent(windowRef, type) {
  const EventConstructor = windowRef?.Event;
  if (typeof EventConstructor !== "function"
      || typeof windowRef?.dispatchEvent !== "function") return false;
  // These events are intentionally payload-free.  The main process has
  // already verified the outcome; the dashboard only needs a semantic state
  // transition and must never receive a path, identifier, filename, or error.
  windowRef.dispatchEvent(new EventConstructor(type));
  return true;
}

function installCommandBridge(documentRef, windowRef, applyLanguage) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version !== ELECTRON_API_VERSION
      || typeof bridge.onCommand !== "function") return () => {};
  const onCommand = (command) => {
    if (!command || typeof command !== "object") return;
    if (command.command === "refresh") {
      documentRef.querySelector?.("#refresh-button")?.click?.();
      return;
    }
    if (command.command === "hostedSignInReturn") {
      // The desktop host has already validated and reduced the external app
      // link to this one semantic command.  Do not forward a URL, argv, or
      // token into the page; wake the existing page-local handoff instead.
      dispatchFixedDesktopEvent(windowRef, "tibotattle:hosted-sign-in-return");
      return;
    }
    if (command.command === "shareCardDownloadCompleted") {
      dispatchFixedDesktopEvent(
        windowRef,
        "tibotattle:share-card-download-completed",
      );
      return;
    }
    if (command.command === "shareCardDownloadFailed") {
      dispatchFixedDesktopEvent(
        windowRef,
        "tibotattle:share-card-download-failed",
      );
      return;
    }
    if (command.command !== "language" || !LANGUAGE_VALUES.has(command.value)) return;
    applyLanguage(command.value);
  };
  const unsubscribe = bridge.onCommand(onCommand);
  return typeof unsubscribe === "function" ? unsubscribe : () => {};
}

export function mountDesktopShell({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!electronDashboard(documentRef)) return Object.freeze({ teardown() {} });
  const shareButton = documentRef.querySelector?.("#electron-share-button");
  const settingsButton = documentRef.querySelector?.("#electron-settings-button");
  if (!shareButton || !settingsButton) return Object.freeze({ teardown() {} });
  const onShare = () => {
    if (windowRef.location && windowRef.location.hash !== "#overview") {
      windowRef.location.hash = "#overview";
    }
    focusSharePanel(documentRef, windowRef);
  };
  const onSettings = () => openSettings(windowRef);
  const bridge = windowRef?.tibotattleDesktop;
  const picker = documentRef.querySelector?.("[data-language-picker]");
  let applyingLanguage = false;
  const applyLanguage = (value) => {
    if (!LANGUAGE_VALUES.has(value) || !picker) return;
    applyingLanguage = true;
    try {
      picker.value = LANGUAGE_PICKER_VALUES[value];
      picker.dispatchEvent?.(new Event("change", { bubbles: true }));
    } finally {
      applyingLanguage = false;
    }
  };
  const onLanguageChange = () => {
    if (applyingLanguage || bridge?.version !== ELECTRON_API_VERSION) return;
    const value = DESKTOP_LANGUAGE_BY_PICKER_VALUE[picker?.value];
    if (!LANGUAGE_VALUES.has(value) || typeof bridge.setLanguage !== "function") return;
    try {
      void Promise.resolve(bridge.setLanguage(value)).catch(() => {});
    } catch {
      // A renderer control must not surface bridge implementation errors.
    }
  };
  shareButton.addEventListener("click", onShare);
  settingsButton.addEventListener("click", onSettings);
  picker?.addEventListener?.("change", onLanguageChange);
  readPersistedLanguage(bridge, applyLanguage);
  const unsubscribeCommand = installCommandBridge(documentRef, windowRef, applyLanguage);
  return Object.freeze({
    teardown() {
      shareButton.removeEventListener?.("click", onShare);
      settingsButton.removeEventListener?.("click", onSettings);
      picker?.removeEventListener?.("change", onLanguageChange);
      unsubscribeCommand();
    },
  });
}

if (typeof document !== "undefined") {
  mountDesktopShell();
}
