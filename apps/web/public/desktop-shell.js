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
const mountedDocuments = new WeakMap();

function electronDashboard(documentRef, windowRef) {
  // The sandboxed preload exposes this exact, frozen-versioned bridge
  // synchronously. It is the strongest startup proof: the DOM marker can be
  // delayed because preload and page DOM events run in isolated worlds.
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version === ELECTRON_API_VERSION) return true;
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

function navigateToSharePanel(documentRef, windowRef) {
  const location = windowRef?.location;
  if (!location || location.hash === "#weekly") {
    focusSharePanel(documentRef, windowRef);
    return;
  }

  // The dashboard navigation listener also handles this hash change. Wait
  // for that event before scheduling the panel focus so its page-heading
  // focus and top-of-page scroll cannot overwrite Share's destination. This
  // is one event listener plus one animation frame, rather than a timer or a
  // polling loop; the browser guarantees a hashchange for this assignment.
  if (typeof windowRef?.addEventListener !== "function") {
    location.hash = "#weekly";
    focusSharePanel(documentRef, windowRef);
    return;
  }
  let handled = false;
  const onHashChange = () => {
    if (handled) return;
    handled = true;
    windowRef.removeEventListener?.("hashchange", onHashChange);
    if (windowRef.location?.hash !== "#weekly") return;
    focusSharePanel(documentRef, windowRef);
  };
  windowRef.addEventListener("hashchange", onHashChange);
  location.hash = "#weekly";
}

function openSettings(windowRef) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version === ELECTRON_API_VERSION
      && typeof bridge.openSettings === "function") {
    try {
      // Keep the renderer action fire-and-forget, but consume a rejected IPC
      // promise. A closed/restarting shell must not turn a button click into
      // an unhandled rejection that makes the control look dead.
      void Promise.resolve(bridge.openSettings()).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function applySidebarState(documentRef, collapsed) {
  if (typeof collapsed !== "boolean") return false;
  const shell = documentRef?.querySelector?.(".dashboard-shell");
  const sidebar = documentRef?.querySelector?.(".dashboard-sidebar");
  if (!shell) return false;
  shell.classList?.toggle?.("sidebar-collapsed", collapsed);
  if (sidebar) {
    sidebar.setAttribute?.("aria-hidden", collapsed ? "true" : "false");
    if ("inert" in sidebar) sidebar.inert = collapsed;
    else if (collapsed) sidebar.setAttribute?.("inert", "");
    else sidebar.removeAttribute?.("inert");
  }
  if (collapsed && sidebar && documentRef.activeElement
      && sidebar.contains?.(documentRef.activeElement)) {
    documentRef.querySelector?.("#main")?.focus?.({ preventScroll: true });
  }
  return true;
}

function readPersistedSettings(bridge, applyLanguage, applySidebar) {
  if (typeof bridge?.getSettings !== "function") return;
  void bridge.getSettings().then((state) => {
    const candidate = state?.settings?.language ?? state?.language;
    applyLanguage(candidate);
    const sidebarCollapsed = state?.settings?.sidebarCollapsed ?? state?.sidebarCollapsed;
    applySidebar(sidebarCollapsed);
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

function dispatchAppearanceOverride(windowRef, command) {
  if (![
    "system",
    "light",
    "dark",
  ].includes(command?.preference)
      || !["light", "dark"].includes(command?.resolvedTheme)) return false;
  const CustomEventConstructor = windowRef?.CustomEvent;
  if (typeof CustomEventConstructor !== "function"
      || typeof windowRef?.dispatchEvent !== "function") return false;
  windowRef.dispatchEvent(new CustomEventConstructor(
    "tibotattle:appearance-override",
    {
      detail: Object.freeze({
        preference: command.preference,
        resolvedTheme: command.resolvedTheme,
      }),
    },
  ));
  return true;
}

function installCommandBridge(documentRef, windowRef, applyLanguage, applySidebar) {
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
    if (command.command === "sidebar") {
      applySidebar(command.collapsed);
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
    if (command.command === "appearance") {
      dispatchAppearanceOverride(windowRef, command);
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
  if (!electronDashboard(documentRef, windowRef)) {
    return Object.freeze({ teardown() {} });
  }
  const existing = mountedDocuments.get(documentRef);
  if (existing) return existing;
  const shareButton = documentRef.querySelector?.("#electron-share-button");
  const settingsButton = documentRef.querySelector?.("#electron-settings-button");
  if (!shareButton || !settingsButton) return Object.freeze({ teardown() {} });
  const onShare = () => {
    // The share card lives on the Allowance page. Navigating to Overview
    // first leaves that page inert, so focus() can succeed in a unit fake yet
    // the packaged Chromium window appears not to move at all.
    navigateToSharePanel(documentRef, windowRef);
  };
  const onSettings = () => openSettings(windowRef);
  const bridge = windowRef?.tibotattleDesktop;
  const picker = documentRef.querySelector?.("[data-language-picker]");
  const applySidebar = (collapsed) => applySidebarState(documentRef, collapsed);
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
  readPersistedSettings(bridge, applyLanguage, applySidebar);
  const unsubscribeCommand = installCommandBridge(
    documentRef,
    windowRef,
    applyLanguage,
    applySidebar,
  );
  const mounted = Object.freeze({
    teardown() {
      shareButton.removeEventListener?.("click", onShare);
      settingsButton.removeEventListener?.("click", onSettings);
      picker?.removeEventListener?.("change", onLanguageChange);
      unsubscribeCommand();
      mountedDocuments.delete(documentRef);
    },
  });
  mountedDocuments.set(documentRef, mounted);
  return mounted;
}

function autoMountDesktopShell() {
  if (typeof document === "undefined") return;
  const mount = () => {
    // Electron's preload normally stamps the marker before this module runs.
    // The DOM-ready retry covers the legitimate startup ordering where the
    // marker is applied while the document body is still being constructed.
    mountDesktopShell();
  };
  mount();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mount();
      // The preload lives in Electron's isolated world. Its DOMContentLoaded
      // listener is not ordered relative to this page-world listener, so a
      // marker can land immediately after the callback above. One macrotask
      // gives the remaining DOM-ready listeners a chance to stamp it; the
      // idempotent mount then installs the controls without starting a poll.
      const schedule = typeof globalThis.window?.setTimeout === "function"
        ? globalThis.window.setTimeout.bind(globalThis.window)
        : globalThis.setTimeout;
      if (typeof schedule === "function") schedule(mount, 0);
    }, { once: true });
  }
}

autoMountDesktopShell();
