import { compareModelPresentation, modelThemeIcon, modelUsagePresentation } from "./model-visuals.js";

const PREFIX = "accounting.cacheContinuity.matrix.";
const BUCKETS = Object.freeze([
  ["under_one_minute", "underOneMinute", 0, 60],
  ["one_to_two_minutes", "oneToTwoMinutes", 60, 120],
  ["two_to_five_minutes", "twoToFiveMinutes", 120, 300],
  ["five_to_ten_minutes", "fiveToTenMinutes", 300, 600],
  ["ten_to_thirty_minutes", "tenToThirtyMinutes", 600, 1_800],
  ["thirty_minutes_to_one_hour", "thirtyMinutesToOneHour", 1_800, 3_600],
  ["one_to_two_hours", "oneToTwoHours", 3_600, 7_200],
  ["two_to_six_hours", "twoToSixHours", 7_200, 21_600],
  ["six_to_twenty_four_hours", "sixToTwentyFourHours", 21_600, 86_400],
  // Closed at seven days, which is the hosted lane's lookback: a longer gap
  // is not measured at all rather than counted in this band. The old vocabulary
  // ended in an unbounded `over_three_days`, which this cannot claim.
  ["over_twenty_four_hours", "twentyFourHoursPlus", 86_400, 604_800],
]);
const COUNT_FIELDS = [
  "comparableReturns", "reusedMoreThanHalfReturns", "reusedHalfOrLessReturns",
  "matchedOrExceededReturns", "reusedBetweenHalfAndPreviousReturns",
  "cacheReadDrops", "lostCacheTokens", "pricedDrops", "unpricedDrops",
];
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const validCounts = (row) => row && COUNT_FIELDS.every((field) => count(row[field]))
  && row.reusedMoreThanHalfReturns + row.reusedHalfOrLessReturns === row.comparableReturns
  && row.matchedOrExceededReturns + row.reusedBetweenHalfAndPreviousReturns === row.reusedMoreThanHalfReturns
  && row.cacheReadDrops === row.reusedHalfOrLessReturns
  && row.pricedDrops + row.unpricedDrops === row.cacheReadDrops;

export function cacheReuseMatrixBuckets(impact) {
  if (!validCounts(impact) || !impact.byOutcomeBucket) return null;
  const rows = [];
  for (const [id, label, startSeconds, endSeconds] of BUCKETS) {
    const row = impact.byOutcomeBucket[id];
    if (!validCounts(row) || row.startSeconds !== startSeconds || row.endSeconds !== endSeconds
      || !["complete", "incomplete"].includes(row.coverageStatus)
      || !(row.estimatedPremiumUsd === null || amount(row.estimatedPremiumUsd))) return null;
    rows.push({ ...row, id, label });
  }
  if (COUNT_FIELDS.some((field) => sum(rows.map((row) => row[field])) !== impact[field])) return null;
  // Every bucket is rendered as measured. The previous vocabulary ended in two
  // day-scale buckets that were merged back together for display; this one ends
  // in the single bucket the evidence is actually cut into, so there is nothing
  // to merge and nothing that could disagree with what was measured.
  return rows;
}

// Keep volume comparable between model selections. The unit is chosen from
// the whole selected reporting period, never from the active model alone.
export function chooseCacheReuseMatrixUnit(impact) {
  const rows = cacheReuseMatrixBuckets(impact);
  if (!rows) return 1;
  const raw = Math.max(1, impact.comparableReturns / 900,
    ...rows.map((row) => row.comparableReturns / 360));
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  const nice = [1, 2, 5, 10].find((value) => value >= scaled) ?? 10;
  return nice * magnitude;
}

export function cacheReuseMatrixLights(summary, unit) {
  if (!count(summary?.comparableReturns) || !count(summary?.reusedMoreThanHalfReturns)
    || summary.reusedMoreThanHalfReturns > summary.comparableReturns || !amount(unit) || unit < 1
    || Math.ceil(summary.comparableReturns / unit) > 900) return [];
  const result = [];
  for (let index = 0; index < Math.ceil(summary.comparableReturns / unit); index += 1) {
    const start = index * unit;
    const filled = Math.min(unit, summary.comparableReturns - start) / unit;
    const more = Math.min(Math.max(summary.reusedMoreThanHalfReturns - start, 0), unit) / unit;
    result.push({ more, less: filled - more });
  }
  return result;
}

export function createCacheReuseMatrix({
  container, t, formatNumber, formatPercent, formatModelName,
  formatMetric = () => [], onModelChange = () => {}, onInspect = () => {},
  documentRef = container.ownerDocument, windowRef = documentRef.defaultView,
}) {
  const tr = (key, values) => t(`${PREFIX}${key}`, values);
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = documentRef.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const stage = el("div", "cache-matrix-stage");
  const header = el("div", "cache-matrix-instrument-head");
  const unitLabel = el("span", "cache-matrix-unit");
  const pickerField = el("label", "cache-matrix-model-field");
  const pickerLabel = el("span");
  const picker = el("select", "cache-matrix-model-picker model-picker");
  pickerField.append(pickerLabel, picker);
  const modelNote = el("small", "cache-matrix-model-note");
  header.append(unitLabel, pickerField, modelNote);
  const view = el("div", "cache-matrix-view");
  const plot = svgEl("svg", { class: "cache-matrix-plot", "aria-hidden": "true", focusable: "false" });
  const hitLayer = el("div", "cache-matrix-hit-layer");
  hitLayer.setAttribute("role", "group");
  const empty = el("p", "cache-matrix-empty");
  view.append(plot, hitLayer, empty);
  const detail = el("div", "cache-matrix-detail");
  const identity = el("div", "cache-matrix-detail-identity");
  const gapLabel = el("strong");
  const sampleLabel = el("small");
  identity.append(gapLabel, sampleLabel);
  const outcomes = el("div", "cache-matrix-outcomes");
  const rates = ["more", "less"].map((key) => {
    const wrapper = el("div", `cache-matrix-outcome cache-matrix-${key}`);
    const value = el("div", "cache-matrix-detail-value");
    const percent = el("span");
    const fraction = el("small");
    const label = el("small", "cache-matrix-outcome-label");
    value.append(percent, fraction);
    wrapper.append(value, label);
    outcomes.append(wrapper);
    return { key, percent, fraction, label };
  });
  const metrics = el("div", "cache-matrix-metrics");
  detail.append(identity, outcomes, metrics);
  stage.append(header, view, detail);
  const legend = el("div", "cache-matrix-legend");
  const legendLabels = ["more", "less"].map((key) => {
    const label = el("span", `cache-matrix-${key}`);
    legend.append(label);
    return [key, label];
  });
  const note = el("p", "cache-matrix-note");
  const announcement = el("div", "cache-matrix-sr");
  announcement.setAttribute("aria-live", "polite");
  announcement.setAttribute("aria-atomic", "true");
  container.classList.add("cache-matrix");
  container.replaceChildren(stage, legend, note, announcement);

  let impact = null;
  let currentImpact = null;
  let rows = null;
  let model = "";
  let selectedIndex = -1;
  let unit = 1;
  let width = 0;
  let focusRect = null;
  let geometry = [];
  let buttons = [];
  let destroyed = false;
  let modelIds = [];
  const rate = (value, total) => total > 0 ? formatPercent(value / total * 100) : tr("missing");
  const longGap = (row) => row.label === "twentyFourHoursPlus"
    ? tr("bucket.twentyFourHoursPlus") : t(`accounting.cacheContinuity.outcome.bucket.${row.label}`);
  const groupLabel = (row) => tr("groupLabel", {
    gap: longGap(row), percent: rate(row.reusedMoreThanHalfReturns, row.comparableReturns),
    count: formatNumber(row.comparableReturns),
  });

  function inspect(index, announce = false) {
    if (!rows || !currentImpact) return;
    selectedIndex = index;
    const summary = index < 0 ? currentImpact : rows[index];
    gapLabel.textContent = index < 0 ? tr("allGaps") : longGap(summary);
    sampleLabel.textContent = tr("checked", { count: formatNumber(summary.comparableReturns) })
      + (summary.comparableReturns > 0 && summary.comparableReturns < 10 ? ` · ${tr("sample")}` : "");
    for (const item of rates) {
      const value = summary[item.key === "more" ? "reusedMoreThanHalfReturns" : "reusedHalfOrLessReturns"];
      item.percent.textContent = rate(value, summary.comparableReturns);
      item.fraction.textContent = tr("fraction", {
        count: formatNumber(value), total: formatNumber(summary.comparableReturns),
      });
      item.label.textContent = tr(item.key);
    }
    metrics.replaceChildren(...formatMetric(summary, currentImpact).filter(Boolean).map((text) => el("small", null, text)));
    if (focusRect) {
      const box = geometry[index];
      focusRect.style.opacity = box ? "1" : "0";
      if (box) {
        focusRect.style.transform = `translate(${box.x}px, ${box.y}px)`;
        focusRect.setAttribute("width", box.width);
        focusRect.setAttribute("height", box.height);
      }
    }
    buttons.forEach((button, i) => { button.tabIndex = i === Math.max(0, index) ? 0 : -1; });
    if (announce) announcement.textContent = index < 0
      ? `${gapLabel.textContent}. ${sampleLabel.textContent}` : groupLabel(summary);
    onInspect({ summary, impact: currentImpact, index, model });
  }

  function draw() {
    if (destroyed || !rows) return;
    const activeButton = buttons.indexOf(documentRef.activeElement);
    const w = Math.max(240, Math.round(view.getBoundingClientRect?.().width || width || 850));
    width = w;
    plot.replaceChildren();
    hitLayer.replaceChildren();
    geometry = [];
    buttons = [];
    const narrow = w < 520;
    const columns = narrow ? Math.max(10, Math.floor((w - 125) / 6.4)) : 7;
    const cw = narrow ? 3.8 : Math.min(4.8, ((w - 32) / 9 - 18 - (columns - 1) * 2) / columns);
    const ch = narrow ? 3.8 : 4.8;
    const gap = narrow ? 1.8 : 2;
    const pitch = ch + gap;
    const gridWidth = columns * cw + (columns - 1) * gap;
    const wholeRows = cacheReuseMatrixBuckets(impact) ?? rows;
    const maxRows = Math.max(1, ...wholeRows.map((row) => Math.ceil(Math.ceil(row.comparableReturns / unit) / columns)));
    const baseline = 86 + Math.max(115, maxRows * pitch);
    let height = baseline + 66;
    if (narrow) height = rows.reduce((total, row) => total
      + Math.max(67, Math.ceil(Math.ceil(row.comparableReturns / unit) / columns) * pitch + 35), 26) + 40;
    plot.setAttribute("viewBox", `0 0 ${w} ${height}`);
    plot.style.height = `${height}px`;
    view.style.minHeight = `${height}px`;
    const text = (x, y, label, className = "", anchor = "start") => {
      const node = svgEl("text", { x, y, class: className, "text-anchor": anchor });
      node.textContent = label;
      plot.append(node);
    };
    if (!narrow) {
      for (const fraction of [0, .25, .5, .75, 1]) plot.append(svgEl("line", {
        x1: 18, x2: w - 18, y1: baseline - fraction * (baseline - 86), y2: baseline - fraction * (baseline - 86),
        class: fraction === 0 ? "cache-matrix-baseline" : "cache-matrix-gridline",
      }));
    }
    let cursor = 26;
    rows.forEach((row, index) => {
      const lights = cacheReuseMatrixLights(row, unit);
      const pixelRows = Math.ceil(lights.length / columns);
      const pixelHeight = Math.max(ch, pixelRows * pitch - gap);
      let gx, gy, box;
      if (narrow) {
        const rowHeight = Math.max(67, pixelHeight + 35);
        gx = 18;
        gy = cursor + 5;
        box = { x: 7, y: cursor - 4, width: w - 14, height: rowHeight };
        text(gx, gy + pixelHeight + 19, tr(`short.${row.label}`), "cache-matrix-gap");
        text(w - 18, cursor + 17, rate(row.reusedMoreThanHalfReturns, row.comparableReturns), "cache-matrix-rate", "end");
        text(w - 18, cursor + 36, tr("n", { count: formatNumber(row.comparableReturns) }), "cache-matrix-muted", "end");
        cursor += rowHeight;
      } else {
        const band = (w - 32) / 9;
        const center = 16 + (index + .5) * band;
        gx = center - gridWidth / 2;
        gy = baseline - pixelHeight;
        box = { x: 16 + index * band + 2, y: 12, width: band - 4, height: baseline + 39 };
        text(center, 32, rate(row.reusedMoreThanHalfReturns, row.comparableReturns), "cache-matrix-rate", "middle");
        text(center, 52, tr("n", { count: formatNumber(row.comparableReturns) }), "cache-matrix-muted", "middle");
        text(center, baseline + 25, tr(`short.${row.label}`), "cache-matrix-gap", "middle");
      }
      const cells = svgEl("g", { class: "cache-matrix-cells" });
      lights.forEach((light, i) => {
        const x = gx + (i % columns) * (cw + gap);
        const y = narrow ? gy + Math.floor(i / columns) * pitch : baseline - ch - Math.floor(i / columns) * pitch;
        for (const [key, offset] of [["more", 0], ["less", light.more]]) {
          if (light[key] > 0) cells.append(svgEl("rect", {
            x: x + offset * cw, y, width: cw * light[key], height: ch, rx: .55, class: `cache-matrix-cell-${key}`,
          }));
        }
      });
      plot.append(cells);
      if (!row.comparableReturns) text(gx + (narrow ? 0 : gridWidth / 2), narrow ? gy + 14 : baseline - 12,
        tr("missing"), "cache-matrix-muted", narrow ? "start" : "middle");
      geometry.push(box);
      const button = el("button", "cache-matrix-hit");
      button.type = "button";
      button.setAttribute("aria-label", groupLabel(row));
      Object.assign(button.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
      button.addEventListener("pointerenter", () => inspect(index));
      button.addEventListener("focus", () => inspect(index, true));
      button.addEventListener("click", () => inspect(index, true));
      button.addEventListener("keydown", (event) => {
        let target = index;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") target = Math.min(rows.length - 1, index + 1);
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = Math.max(0, index - 1);
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = rows.length - 1;
        else if (event.key === "Escape") { inspect(-1, true); return; }
        else return;
        event.preventDefault();
        buttons[target].focus();
      });
      buttons.push(button);
      hitLayer.append(button);
    });
    focusRect = svgEl("rect", { class: "cache-matrix-selection", x: 0, y: 0, width: 1, height: 1, rx: 7 });
    plot.append(focusRect);
    text(w / 2, height - 11, tr("axis"), "cache-matrix-muted", "middle");
    inspect(selectedIndex);
    if (activeButton >= 0) buttons[activeButton]?.focus();
  }

  function updatePicker() {
    const availableIds = Array.isArray(impact?.byModel) ? impact.byModel.map((row) => row.model)
      .filter((id) => typeof id === "string" && id.length > 0) : [];
    modelIds = [...new Set([...availableIds, ...(model ? [model] : [])])].sort(compareModelPresentation);
    picker.replaceChildren(...[["", tr("allModels")], ...modelIds.map((id) => [id, formatModelName(id)])].map(([id, label]) => {
      const option = el("option");
      option.value = id;
      option.setAttribute("aria-label", label);
      const presentation = id ? modelUsagePresentation(id) : { theme: "layers", className: "allowance-model-classic" };
      const icon = modelThemeIcon(documentRef, presentation.theme);
      if (icon) { icon.classList.add(presentation.className); option.append(icon); }
      option.append(el("span", null, label));
      return option;
    }));
    if (windowRef?.CSS?.supports("appearance", "base-select")) {
      const button = el("button");
      button.type = "button";
      button.append(el("selectedcontent"));
      picker.prepend(button);
    }
    picker.value = model;
  }

  function renderCurrent() {
    const cohort = model && Array.isArray(impact?.byModel)
      ? impact.byModel.find((row) => row.model === model) : null;
    currentImpact = model ? (cohort ? { ...cohort, status: impact.status } : null) : impact;
    rows = impact?.status === "available" ? cacheReuseMatrixBuckets(currentImpact) : null;
    // A model cohort must be a subset of the period cohort. This also keeps
    // the fixed evidence unit bounded if a response is internally inconsistent.
    const periodRows = cacheReuseMatrixBuckets(impact);
    if (model && rows && (!periodRows || rows.some((row, i) =>
      COUNT_FIELDS.some((field) => row[field] > periodRows[i][field])))) rows = null;
    const unavailable = !rows;
    const noEvidence = !unavailable && currentImpact.comparableReturns === 0;
    empty.hidden = !unavailable && !noEvidence;
    empty.textContent = unavailable ? tr(model
      ? Array.isArray(impact?.byModel) ? "modelUnavailable" : "modelBreakdownUnavailable"
      : "unavailable") : tr("empty");
    plot.style.display = unavailable ? "none" : "";
    hitLayer.hidden = unavailable;
    outcomes.hidden = unavailable;
    metrics.hidden = unavailable;
    legend.hidden = unavailable;
    note.hidden = unavailable;
    unitLabel.textContent = tr("unit", { count: formatNumber(unit) });
    pickerLabel.textContent = tr("model");
    const modelBreakdownAvailable = Array.isArray(impact?.byModel);
    modelNote.hidden = impact?.status !== "available" || modelBreakdownAvailable;
    modelNote.textContent = tr("modelBreakdownUnavailable");
    // Retain an escape to All models when a previously chosen model is absent
    // from an older snapshot. Otherwise do not offer an inert one-option picker.
    picker.disabled = !modelBreakdownAvailable && !model;
    picker.setAttribute("aria-label", tr("modelLabel"));
    hitLayer.setAttribute("aria-label", tr("chartLabel", { count: formatNumber(unit) }));
    legendLabels.forEach(([key, label]) => { label.textContent = tr(key); });
    note.textContent = tr("partialLight", { count: formatNumber(unit) });
    if (unavailable) {
      plot.replaceChildren();
      hitLayer.replaceChildren();
      buttons = [];
      gapLabel.textContent = model ? formatModelName(model) : tr("allGaps");
      sampleLabel.textContent = tr("noEvidence");
      view.style.minHeight = "230px";
    } else draw();
    onModelChange({ model, impact: unavailable ? null : currentImpact });
  }
  const changeModel = () => { model = picker.value; renderCurrent(); };
  picker.addEventListener("change", changeModel);
  const resetInspect = (event) => {
    if (!hitLayer.contains(documentRef.activeElement) && event.pointerType !== "touch") inspect(-1);
  };
  view.addEventListener("pointerleave", resetInspect);
  const observer = windowRef?.ResizeObserver ? new windowRef.ResizeObserver((entries) => {
    const next = entries[0]?.contentRect.width;
    if (next > 0 && Math.abs(next - width) > 1) { width = next; draw(); }
  }) : null;
  observer?.observe(view);

  return {
    render({ impact: next }) {
      if (destroyed) return;
      impact = next;
      unit = chooseCacheReuseMatrixUnit(impact);
      updatePicker();
      renderCurrent();
    },
    get selectedModel() { return model; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      picker.removeEventListener("change", changeModel);
      view.removeEventListener("pointerleave", resetInspect);
      container.replaceChildren();
      container.classList.remove("cache-matrix");
    },
  };
}
