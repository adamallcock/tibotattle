import { translate } from "./localization.js";
import { normalizeTrayPreferences, validTrayPreferences, TRAY_OPTIONS } from "./electron-tray-preferences.js";

/** A renderer-owned undo slot; persistence and validation remain in the host. */
export function createTraySettingsController({ documentRef, bridge, localizer } = {}) {
  const root = documentRef?.querySelector?.("#settings-tray-controls");
  if (!root || typeof documentRef.createElement !== "function") return { update() {}, teardown() {} };
  const translationKeys = new Map();
  const t = (key, values) => {
    const id = `electron.trayCustomization.${key}`;
    const copy = localizer?.t?.(id, values) ?? translate(id, values);
    if (values === undefined) translationKeys.set(copy, id);
    return copy;
  };
  let current = normalizeTrayPreferences(null);
  let previous = null;
  let busy = false;
  let available = false;
  let status = "current";
  let capabilities = {};
  let exampleState = "current";
  const listeners = [];
  const node = (tag, copy, className) => {
    const element = documentRef.createElement(tag);
    if (copy !== undefined) {
      element.textContent = copy;
      // Static controls join the page's existing language-change mechanism.
      const key = translationKeys.get(copy);
      if (key) element.setAttribute("data-i18n", key);
    }
    if (className) element.className = className;
    return element;
  };
  const listen = (element, type, handler) => {
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener(type, handler));
  };
  const notice = node("p", "", "settings-tray-notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const controls = node("div", undefined, "settings-tray-grid");
  const selections = new Map();
  const selectionFields = new Map();
  const checkboxes = new Map();
  function select(parent, key) {
    const label = node("label", undefined, "settings-field");
    label.append(node("span", t(key)));
    const input = node("select");
    input.id = `tray-${key}`;
    for (const value of TRAY_OPTIONS[key]) {
      const option = node("option", t(`option.${value}`));
      option.value = value;
      input.append(option);
    }
    label.append(input);
    parent.append(label);
    selections.set(key, input);
    selectionFields.set(key, label);
    listen(input, "change", () => {
      const next = { ...current, [key]: input.value };
      if (next.preset === "both") next.barMetric = "remaining";
      void save(next);
    });
  }
  function check(parent, key, labelKey = key) {
    const label = node("label", undefined, "settings-tray-checkbox");
    const input = node("input");
    input.type = "checkbox";
    label.append(input, node("span", t(labelKey)));
    parent.append(label);
    checkboxes.set(key, input);
    listen(input, "change", () => void save({ ...current, [key]: input.checked }));
  }
  const bar = node("fieldset", undefined, "settings-card settings-tray-group");
  bar.append(node("legend", t("besideIcon")));
  for (const key of ["preset", "iconMode", "meterWindow", "barMetric", "resetFormat"]) select(bar, key);
  check(bar, "emphasizeLow");
  const capabilityNotice = node("p", "", "settings-tray-note");
  bar.append(capabilityNotice);
  const popup = node("fieldset", undefined, "settings-card settings-tray-group");
  popup.append(node("legend", t("whenOpened")));
  const sections = node("div", undefined, "settings-tray-sections");
  popup.append(sections);
  for (const key of ["historyRange", "density"]) select(popup, key);
  check(popup, "showChart");
  const totals = node("fieldset", undefined, "settings-tray-totals");
  totals.append(node("legend", t("metrics")));
  for (const metric of TRAY_OPTIONS.metrics) {
    const label = node("label", undefined, "settings-tray-checkbox");
    const input = node("input");
    input.type = "checkbox";
    input.dataset.trayMetric = metric;
    label.append(input, node("span", t(`option.${metric}`)));
    totals.append(label);
    checkboxes.set(`metric.${metric}`, input);
    listen(input, "change", () => void save({ ...current, metrics: input.checked
      ? [...current.metrics, metric] : current.metrics.filter((value) => value !== metric) }));
  }
  popup.append(totals, node("p", t("usageRule"), "settings-tray-note"));
  controls.append(bar, popup);
  const preview = node("section", undefined, "settings-card settings-tray-preview");
  preview.setAttribute("aria-label", t("preview"));
  preview.append(node("h3", t("preview")), node("p", t("example"), "settings-tray-note"));
  const stateLabel = node("label", undefined, "settings-field");
  stateLabel.append(node("span", t("previewState")));
  const stateSelect = node("select");
  for (const value of ["current", "refreshing", "partial", "stale", "offline"]) {
    const option = node("option", t(`state.${value}`));
    option.value = value;
    stateSelect.append(option);
  }
  stateLabel.append(stateSelect);
  const previewBar = node("div", undefined, "settings-tray-preview-bar");
  const previewPopup = node("div", undefined, "settings-tray-preview-popup");
  preview.append(stateLabel, previewBar, previewPopup);
  listen(stateSelect, "change", () => { exampleState = stateSelect.value; renderPreview(); });
  const actions = node("div", undefined, "settings-tray-actions");
  const undo = node("button", t("undo"), "button");
  const restore = node("button", t("restore"), "button");
  undo.type = restore.type = "button";
  actions.append(undo, restore);
  listen(undo, "click", () => { if (previous) void save(previous, { undoing: true }); });
  listen(restore, "click", () => void save(null, { restoring: true }));
  root.replaceChildren(controls, preview, actions, notice);

  function renderPreview() {
    const missing = exampleState === "offline";
    const stale = exampleState === "stale";
    const value = missing || stale || exampleState === "partial" ? "—" : "63%";
    const week = missing || stale ? "—" : "8%";
    const reset = current.resetFormat === "clock" ? t("exampleClock") : t("exampleCountdown");

    const icon = node("span", undefined, "settings-tray-preview-icon");
    const bird = node("img");
    bird.src = "./tibotattle-icon.png";
    bird.alt = "";
    bird.width = bird.height = 22;
    icon.append(bird);
    if (current.iconMode !== "app") {
      const meters = node("span", undefined, "settings-tray-preview-meters");
      const meterWindow = ["five-hour", "weekly"].includes(current.preset) ? current.preset : current.meterWindow;
      for (const kind of current.iconMode === "dual-meter" ? ["five-hour", "weekly"] : [meterWindow]) {
        const amount = kind === "five-hour" ? value : week;
        const track = node("span", undefined, "settings-tray-preview-meter");
        track.setAttribute("aria-label", `${t(`option.${kind}`)}: ${amount}`);
        const fill = node("span");
        fill.style.width = amount === "—" ? "0%" : amount;
        track.classList.toggle("is-unknown", amount === "—");
        track.classList.toggle("is-low", current.emphasizeLow && amount !== "—" && Number.parseInt(amount, 10) <= 10);
        track.append(fill);
        meters.append(track);
      }
      icon.append(meters);
    }
    icon.setAttribute("aria-label", t(`option.${current.iconMode}`));
    previewBar.replaceChildren(icon);
    const windows = current.preset === "both" ? [["5h", value], ["7d", week]]
      : current.preset === "icon-only" ? [] : [[current.preset === "five-hour" ? "5h" : "7d", current.preset === "five-hour" ? value : week]];
    previewBar.title = windows.map(([label, amount]) => `${label} ${amount}`).join(" · ");
    for (const [index, [label, amount]] of windows.entries()) {
      if (index > 0 && capabilities.title !== false) previewBar.append(node("span", "·"));
      const metric = current.barMetric === "remaining" || current.preset === "both" ? `${label} ${amount}`
        : `${label} ${current.barMetric === "remaining-reset" ? `${amount} · ` : ""}${missing || stale || amount === "—" ? "—" : reset}`;
      const text = node("span", metric);
      text.classList.toggle("is-low", current.emphasizeLow && amount !== "—" && Number.parseInt(amount, 10) <= 10);
      if (capabilities.title !== false) previewBar.append(text);
    }
    previewPopup.dataset.density = current.density;
    previewPopup.replaceChildren(node("strong", "TiboTattle"), node("p", t(`state.${exampleState}`), "settings-tray-note"));
    for (const section of current.sections) {
      const card = node("section");
      card.append(node("h4", t(`option.${section}`)));
      if (section === "allowances") card.append(node("p", `5h ${value} · 7d ${week}`), node("p", missing || stale ? t(`state.${exampleState}`) : reset));
      if (section === "pace") card.append(node("p", t(missing || stale ? "state.offline" : "examplePace")));
      if (section === "usage") {
        card.append(node("p", t(`option.${current.historyRange}`)));
        for (const item of current.metrics) card.append(node("p", `${t(`option.${item}`)}: ${missing ? "—" : item === "cost" ? "$12.40" : item === "tokens" ? "1.2M" : "86"}`));
        if (current.showChart) {
          const chart = node("div", missing ? "—" : "▂ ▄ ▃ ▆ ▂ ▅ ▇", "settings-tray-example-chart");
          chart.setAttribute("aria-label", t("exampleChart"));
          card.append(chart);
        }
        if (exampleState === "partial") card.append(node("p", t("partialPricing")));
      }
      if (section === "cache") card.append(node("p", missing ? "—" : t("exampleCache")));
      previewPopup.append(card);
    }
    previewPopup.append(node("p", t("alwaysAvailable"), "settings-tray-note"));
  }
  function render() {
    const locked = busy || !available || status !== "current";
    for (const [key, input] of selections) {
      input.value = current[key];
      selectionFields.get(key).hidden = capabilities.title === false && key === "barMetric";
      if (key === "preset") {
        const caption = selectionFields.get(key).children[0];
        const labelKey = capabilities.title === false ? "tooltipPreset" : "preset";
        caption.textContent = t(labelKey);
        caption.setAttribute("data-i18n", `electron.trayCustomization.${labelKey}`);
      }
      input.disabled = locked || (key === "barMetric" && (current.preset === "both" || current.preset === "icon-only"))
        || (key === "meterWindow" && (current.iconMode !== "meter" || ["weekly", "five-hour"].includes(current.preset)));
    }
    for (const [key, input] of checkboxes) {
      input.checked = key.startsWith("metric.") ? current.metrics.includes(key.slice(7)) : current[key];
      input.disabled = locked;
    }
    sections.replaceChildren();
    const ordered = [...current.sections, ...TRAY_OPTIONS.sections.filter((item) => !current.sections.includes(item))];
    for (const section of ordered) {
      const row = node("div", undefined, "settings-tray-section-row");
      const label = node("label", undefined, "settings-tray-checkbox");
      const input = node("input");
      input.type = "checkbox";
      input.checked = current.sections.includes(section);
      input.disabled = locked;
      input.dataset.traySection = section;
      input.id = `tray-section-${section}`;
      input.addEventListener("change", () => void save({ ...current, sections: input.checked
        ? [...current.sections, section] : current.sections.filter((item) => item !== section) }));
      label.append(input, node("span", t(`option.${section}`)));
      row.append(label);
      for (const [direction, offset] of [["up", -1], ["down", 1]]) {
        const button = node("button", direction === "up" ? "↑" : "↓", "button");
        button.type = "button";
        button.dataset.trayMove = `${section}-${direction}`;
        button.setAttribute("aria-label", t(direction, { section: t(`option.${section}`) }));
        const index = current.sections.indexOf(section);
        button.disabled = locked || index < 0 || index + offset < 0 || index + offset >= current.sections.length;
        button.addEventListener("click", () => {
          const next = [...current.sections];
          [next[index], next[index + offset]] = [next[index + offset], next[index]];
          void save({ ...current, sections: next }, { focusMove: `${section}-${direction}` });
        });
        row.append(button);
      }
      sections.append(row);
    }
    undo.disabled = locked || previous === null;
    // Unknown or unreadable files remain owned by the compatible host version.
    restore.disabled = locked;
    capabilityNotice.textContent = t(capabilities.title === false ? "platformTooltip" : "platformMac");
    if (status !== "current") notice.textContent = t(status === "future" ? "future" : "invalid");
    renderPreview();
  }
  async function save(next, { restoring = false, undoing = false, focusMove = null } = {}) {
    if (!available || busy) return;
    if (!restoring && !validTrayPreferences(next)) {
      notice.textContent = t("usageRule");
      render();
      return;
    }
    const focusId = documentRef.activeElement?.id;
    const before = normalizeTrayPreferences(current);
    busy = true;
    render();
    try {
      const result = await (restoring ? bridge.restoreTrayDefaults() : bridge.setTrayPreferences(next));
      const saved = result?.settings?.tray ?? result?.tray ?? next;
      if (!validTrayPreferences(saved)) throw new Error("Unavailable settings result");
      current = normalizeTrayPreferences(saved);
      previous = undoing ? null : before;
      status = "current";
      notice.textContent = t("saved");
    } catch {
      current = before;
      notice.textContent = t("saveFailed");
    } finally {
      busy = false;
      render();
      if (focusMove) root.querySelector(`[data-tray-move="${focusMove}"]`)?.focus();
      else if (focusId) documentRef.getElementById?.(focusId)?.focus();
    }
  }
  render();
  return {
    update(state, connected = true) {
      if (busy) return;
      current = normalizeTrayPreferences(state?.tray);
      status = state?.traySettingsStatus ?? "current";
      capabilities = state?.trayCapabilities ?? {};
      for (const id of ["settings-tab-tray", "settings-tray-heading"]) {
        const heading = documentRef.getElementById?.(id);
        if (heading) {
          const key = capabilities.title === true ? "menuBar" : "title";
          heading.textContent = t(key);
          heading.setAttribute("data-i18n", `electron.trayCustomization.${key}`);
        }
      }
      available = connected && typeof bridge?.setTrayPreferences === "function" && typeof bridge?.restoreTrayDefaults === "function";
      render();
    },
    teardown() { for (const remove of listeners) remove(); },
  };
}
