// Presentation only: all values and cycle boundaries come from the dashboard's
// existing selectors. Motion moves a time cursor; it never animates data values.
const SVG_NS = "http://www.w3.org/2000/svg";
const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function horizonAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  const stops = [
    [0, [12, 27, 48], [33, 49, 72]],
    [5, [35, 49, 80], [157, 107, 113]],
    [7, [90, 172, 221], [255, 218, 157]],
    [12, [50, 162, 231], [202, 239, 252]],
    [16, [81, 177, 233], [222, 239, 231]],
    [19, [99, 99, 150], [248, 171, 120]],
    [21, [24, 40, 67], [61, 61, 94]],
    [24, [12, 27, 48], [33, 49, 72]],
  ];
  const hi = stops.findIndex(stop => stop[0] > h);
  const before = stops[hi - 1], after = stops[hi];
  const f = (h - before[0]) / (after[0] - before[0]);
  const mix = index => before[index].map((n, i) => Math.round(n + (after[index][i] - n) * f)).join(",");
  const orbit = offset => {
    const angle = (h - 6) * Math.PI / 12 + offset;
    return { x: 77 - 16 * Math.cos(angle), y: 75 - 49 * Math.sin(angle),
      opacity: clamp(Math.sin(angle) * 5 + .4, 0, 1) };
  };
  return { top: `rgb(${mix(1)})`, bottom: `rgb(${mix(2)})`, sun: orbit(0),
    moon: orbit(Math.PI), stars: 1 - clamp((Math.sin((h - 6) * Math.PI / 12) + .15) * 3, 0, 1) };
}

// Modulo elapsed time, never a CSS transition from the last angle back to zero.
export function advanceHorizonTime(at, elapsed, domain, duration = 40_000) {
  const span = domain.endMs - domain.startMs;
  if (!(span > 0)) return domain.startMs;
  return domain.startMs + ((at - domain.startMs + Math.max(0, elapsed) * span / duration) % span + span) % span;
}

export function sampleAt(points, timestamp, maximumAge = 6 * 3_600_000) {
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].timestampMs <= timestamp) low = middle + 1;
    else high = middle;
  }
  const point = points[low - 1];
  return point && timestamp - point.timestampMs <= maximumAge ? point : null;
}

// Unit conversion of the existing rolling-window total. A partial recovered
// window uses its measured duration, and unknown pricing never becomes $0.
export function hourlySpend(point) {
  if (!finite(point?.allowanceWeightedUsd) || point.allowanceWeightedUsd < 0
      || !finite(point?.measuredSpanMs) || point.measuredSpanMs <= 0) return null;
  const rate = point.allowanceWeightedUsd / point.measuredSpanMs * 3_600_000;
  return finite(rate) ? rate : null;
}

// A presentation index over already-priced usage buckets. Quota readings and
// comparison-chart visibility do not determine whether recorded spending exists.
// Prefix sums keep replay queries logarithmic and leave unknown pricing explicit.
export function createSpendRateLookup(buckets, { intervals, bucketMs = 900_000, windowMs = 3 * 3_600_000 } = {}) {
  const unavailable = () => null;
  if (!buckets.length || !finite(bucketMs) || bucketMs <= 0 || !finite(windowMs)
      || windowMs < bucketMs || windowMs % bucketMs !== 0) return unavailable;
  const rows = [...buckets].sort((a, b) => a.endMs - b.endMs);
  const costs = [0], missing = [0], ends = [];
  const contiguous = [];
  for (const row of rows) {
    if (!finite(row.startMs) || !finite(row.endMs) || row.endMs - row.startMs !== bucketMs
        || row.startMs % bucketMs !== 0 || row.endMs % bucketMs !== 0
        || (ends.length && row.startMs < ends.at(-1))) return unavailable;
    const priced = finite(row.usd) && row.usd >= 0;
    costs.push(costs.at(-1) + (priced ? row.usd : 0));
    missing.push(missing.at(-1) + (priced ? 0 : 1));
    ends.push(row.endMs);
    const last = contiguous.at(-1);
    if (last?.[1] === row.startMs) last[1] = row.endMs;
    else contiguous.push([row.startMs, row.endMs]);
  }
  // Selected-plan coverage explicitly includes quiet time. Legacy buckets alone
  // establish only their contiguous runs; an omitted run must not become $0.
  const coverage = intervals ?? contiguous;
  if (!coverage.length || coverage.some(([start, end], i) => !finite(start) || !finite(end)
      || end <= start || start % bucketMs !== 0 || end % bucketMs !== 0
      || (i > 0 && start < coverage[i - 1][1]))) return unavailable;
  const upperBound = (values, at) => {
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid] <= at) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const starts = coverage.map(([start]) => start);
  return timestamp => {
    if (!finite(timestamp) || timestamp < rows[0].startMs || timestamp > ends.at(-1)) return null;
    // A bucket becomes knowable at its end. Never pull future activity into the
    // selected time, or spread its cost fractionally across the unfinished bin.
    const endMs = Math.floor(timestamp / bucketMs) * bucketMs;
    const interval = coverage[upperBound(starts, endMs - 1) - 1];
    if (!interval || endMs > interval[1]) return null;
    const startMs = Math.max(rows[0].startMs, interval[0], endMs - windowMs);
    if (startMs >= endMs) return null;
    const from = upperBound(ends, startMs), to = upperBound(ends, endMs);
    if (missing[to] !== missing[from]) return null;
    return { timestampMs: endMs, allowanceWeightedUsd: Math.max(0, costs[to] - costs[from]), measuredSpanMs: endMs - startMs };
  };
}

// Neighboring markers share a badge at the latest event's actual time. Every
// event remains in the inspection text; no timestamp is moved to avoid overlap.
export function resetMarkerGroups(events, x, minimumSpacing = 24) {
  const groups = [];
  for (const event of [...events].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const last = groups.at(-1);
    if (last && x(event) - x(last[0]) < minimumSpacing) last.push(event);
    else groups.push([event]);
  }
  return groups;
}

export function presentationSegments(points, keys, { segmentKey, breakBefore, maxGapMs = Infinity } = {}) {
  const segments = [];
  let current = [];
  for (const point of points) {
    const previous = current.at(-1);
    if (!keys.every(key => finite(point[key])) || (previous
      && ((segmentKey && point[segmentKey] !== previous[segmentKey]) || (breakBefore && point[breakBefore])
        || point.timestampMs - previous.timestampMs > maxGapMs))) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (keys.every(key => finite(point[key]))) current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

// Split at the exact linear crossing so a warm lobe cannot include a cool one.
export function differenceLobes(points, x, y) {
  const paths = { above: "", below: "" };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    if (![a.observed, a.expected, b.observed, b.expected].every(finite)) continue;
    if (a.residualSegment !== b.residualSegment) continue;
    const da = a.observed - a.expected, db = b.observed - b.expected;
    const polygon = (left, right, sign) => {
      paths[sign >= 0 ? "above" : "below"] += `M${x(left)},${y(left.observed)}L${x(right)},${y(right.observed)}L${x(right)},${y(right.expected)}L${x(left)},${y(left.expected)}Z`;
    };
    if (da * db < 0) {
      const ratio = da / (da - db);
      const cross = { timestampMs: a.timestampMs + (b.timestampMs - a.timestampMs) * ratio,
        observed: a.observed + (b.observed - a.observed) * ratio,
        expected: a.expected + (b.expected - a.expected) * ratio };
      polygon(a, cross, da); polygon(cross, b, db);
    } else polygon(a, b, da || db);
  }
  return paths;
}

function svgNode(document, tag, attrs) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

export function mountTrendsHorizon(root, { t, locale, timeZone, formatMoney, formatPercent, formatDuration }) {
  const document = root.ownerDocument;
  const win = document.defaultView;
  const $ = selector => root.querySelector(selector);
  const charts = new Map();
  let resetEvents = [];
  let allowanceSamples = [];
  let spendAt = () => null;
  const input = $("#trends-time");
  const replay = $("#trends-replay");
  const sky = $(".trends-sky");
  const media = win.matchMedia("(prefers-reduced-motion: reduce)");
  let at = null, playing = false, frame = 0, lastFrame = null, disposed = false;
  let formatLocale = locale;
  const formatters = new Map();
  const formatter = options => {
    const key = JSON.stringify(options);
    if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(formatLocale, { timeZone, ...options }));
    return formatters.get(key);
  };
  const clockParts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const format = (timestamp, options) => formatter(options).format(timestamp);
  const domain = () => {
    for (const id of ["usage-timeline-chart", "timeline-chart", "allowance-timeline-chart"]) {
      const chart = charts.get(id);
      if (chart && !chart.shell.hidden && chart.svg.isConnected) return chart.domain;
    }
    return null;
  };
  const setText = (selector, value) => { const el = $(selector); if (el && el.textContent !== value) el.textContent = value; };
  const setPlayLabel = () => {
    replay.textContent = t(playing ? "trends.pause" : "trends.play");
    replay.setAttribute("aria-pressed", String(playing));
  };
  function stop() {
    playing = false; win.cancelAnimationFrame(frame); frame = 0; lastFrame = null; setPlayLabel();
  }
  function select(timestamp, user = false) {
    const bounds = domain();
    if (!bounds) return;
    if (user) stop();
    at = clamp(timestamp, bounds.startMs, bounds.endMs);
    input.value = String(at);
    const parts = clockParts.formatToParts(at);
    const part = key => Number(parts.find(p => p.type === key)?.value ?? 0);
    const light = horizonAt(part("hour") + part("minute") / 60 + part("second") / 3600);
    sky.style.background = `linear-gradient(125deg,${light.top},${light.bottom})`;
    for (const body of ["sun", "moon"]) {
      const element = sky.querySelector(`.trends-${body}`), position = light[body];
      // Keep the orbit in the open sky between the clock and the readouts.
      element.style.left = `${45 + (position.x - 77) * .5}%`; element.style.top = `${position.y}%`; element.style.opacity = position.opacity;
    }
    sky.querySelector(".trends-stars").style.opacity = light.stars;
    setText("#trends-date", format(at, { weekday: "long", month: "short", day: "numeric", year: "numeric" }));
    setText("#trends-clock", format(at, { hour: "numeric", minute: "2-digit" }));
    const description = format(at, { dateStyle: "medium", timeStyle: "short" });
    input.setAttribute("aria-valuetext", description);
    const levelPoint = sampleAt(allowanceSamples, at, 3 * 3_600_000);
    const spendPoint = spendAt(at);
    const rate = hourlySpend(spendPoint);
    setText("#trends-allowance-value", finite(levelPoint?.allowanceRemaining) ? formatPercent(levelPoint.allowanceRemaining, 0) : "—");
    setText("#trends-spend-value", rate === null ? "—" : formatMoney(rate));
    setText("#trends-spend-basis", rate === null ? t("trends.rateUnavailable")
      : t("trends.rollingAverage", { duration: formatDuration(spendPoint.measuredSpanMs) }));
    for (const chart of charts.values()) {
      if (chart.shell.hidden || !chart.svg.isConnected) continue;
      const inside = at >= chart.domain.startMs && at <= chart.domain.endMs;
      chart.guide.setAttribute("visibility", inside ? "visible" : "hidden");
      const x = chart.x({ timestampMs: at });
      chart.guide.setAttribute("x1", x); chart.guide.setAttribute("x2", x);
      const point = inside ? sampleAt(chart.points, at, chart.maximumAge) : null;
      chart.dots.forEach(({ dot, item }) => {
        const value = point?.[item.key];
        dot.setAttribute("visibility", finite(value) ? "visible" : "hidden");
        if (finite(value)) {
          dot.setAttribute("cx", chart.x(point)); dot.setAttribute("cy", chart.y(value));
        }
      });
      if (chart.lastPoint !== point) {
        chart.lastPoint = point;
        const values = chart.series.map(item => `${item.label}: ${finite(point?.[item.key]) ? item.format(point[item.key]) : "—"}`).join(" · ");
        const sampleTime = chart.shell.id === "allowance-timeline-chart" && point?.allowanceObservedAt
          ? Date.parse(point.allowanceObservedAt) : point?.timestampMs;
        chart.readout.textContent = values + (point ? ` · ${t("trends.sample", { time: format(sampleTime, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) })}` : ` · ${t("trends.noSample")}`);
      }
    }
  }
  function tick(now) {
    if (!playing || disposed) return;
    if (document.hidden || root.inert || !root.isConnected) { stop(); return; }
    const elapsed = lastFrame === null ? 0 : Math.min(now - lastFrame, 100);
    lastFrame = now;
    select(advanceHorizonTime(at, elapsed, domain()));
    frame = win.requestAnimationFrame(tick);
  }
  input.oninput = () => select(Number(input.value), true);
  replay.onclick = () => {
    if (playing) return stop();
    if (!domain() || media.matches) return;
    playing = true; setPlayLabel(); frame = win.requestAnimationFrame(tick);
  };
  $("#trends-latest").onclick = () => { if (domain()) select(domain().endMs, true); };
  function motionChanged() { stop(); replay.hidden = media.matches; }
  function visibilityChanged() { if (document.hidden) stop(); }
  media.addEventListener("change", motionChanged);
  document.addEventListener("visibilitychange", visibilityChanged);
  const pageObserver = new win.MutationObserver(() => { if (root.inert) stop(); });
  pageObserver.observe(root, { attributes: true, attributeFilter: ["inert"] });
  motionChanged();

  function renderEvents() {
    const chart = charts.get("allowance-timeline-chart");
    if (!chart || chart.shell.hidden || !chart.svg.isConnected) {
      setText("#trends-reset-count", t("trends.allowanceUnavailable"));
      return;
    }
    chart.svg.querySelector(".trends-reset-layer")?.remove();
    const visible = resetEvents.filter(event => event.timestampMs >= chart.domain.startMs && event.timestampMs <= chart.domain.endMs);
    setText("#trends-reset-count", visible.length ? t("trends.resetCount", { count: visible.length }) : t("trends.resetUnavailable"));
    const layer = svgNode(document, "g", { class: "trends-reset-layer" });
    for (const group of resetMarkerGroups(visible, chart.x)) {
      const event = group.at(-1), x = chart.x(event);
      const caption = group.map(item => {
        const label = t(item.kind === "observed_reset" ? "trends.resetObserved" : "trends.resetBoundary");
        const detail = t("trends.resetDetail", { event: label,
          time: format(item.timestampMs, { dateStyle: "medium", timeStyle: "short" }) });
        return item.confirmedAtMs > item.timestampMs ? detail + " " + t("trends.resetConfirmed", {
          time: format(item.confirmedAtMs, { dateStyle: "medium", timeStyle: "short" }),
        }) : detail;
      }).join("\n");
      const marker = svgNode(document, "g", { class: `trends-reset-marker ${event.kind}`, tabindex: 0, role: "button", "aria-label": caption });
      const title = svgNode(document, "title", {}); title.textContent = caption;
      const stem = svgNode(document, "line", { x1: x, x2: x, y1: 21, y2: chart.height - chart.margin.bottom });
      const badge = svgNode(document, "rect", { x: x - 9, y: 1, width: 18, height: 18, rx: 6 });
      const icon = svgNode(document, "text", { x, y: 14, "text-anchor": "middle", "aria-hidden": "true", "data-i18n-skip": "" });
      icon.textContent = group.length > 1 ? String(group.length) : event.kind === "observed_reset" ? "↻" : "◇";
      if (group.length > 1) icon.setAttribute("class", "trends-reset-group-count");
      marker.append(title, stem, badge, icon);
      const inspect = () => {
        select(event.timestampMs, true);
        setText("#trends-event-detail", caption);
        $("#trends-event-detail").hidden = false;
      };
      marker.addEventListener("click", e => { e.stopPropagation(); inspect(); });
      marker.addEventListener("focus", inspect);
      marker.addEventListener("pointerenter", inspect);
      marker.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); inspect(); }
      });
      layer.append(marker);
    }
    chart.svg.append(layer);
  }

  function register(shell, model) {
    if (!model || disposed) return;
    const { svg, points, series, x, y, domain: bounds, margin, width, height } = model;
    svg.style.aspectRatio = `${width} / ${height}`;
    charts.get(shell.id)?.cleanup();
    const layer = svgNode(document, "g", { class: "trends-data-fill", "aria-hidden": "true", "pointer-events": "none" });
    const addPath = (d, className) => layer.append(svgNode(document, "path", { d, class: className }));
    if (shell.id === "allowance-timeline-chart") {
      const defs = svgNode(document, "defs", {});
      const gradient = svgNode(document, "linearGradient", { id: "trends-reservoir-gradient", x1: "0%", y1: "0%", x2: "0%", y2: "100%" });
      for (const [offset, opacity] of [["0%", .42], ["55%", .18], ["100%", .035]]) {
        gradient.append(svgNode(document, "stop", { offset, "stop-color": "var(--green-2)", "stop-opacity": opacity }));
      }
      defs.append(gradient); svg.append(defs);
      for (const segment of presentationSegments(points, ["allowanceRemaining"], series[0])) {
        const edge = segment.map(p => `${x(p)},${y(p.allowanceRemaining)}`).join("L");
        addPath(`M${x(segment[0])},${y(0)}L${edge}L${x(segment.at(-1))},${y(0)}Z`, "trends-reservoir-fill");
      }
    }
    if (shell.id === "timeline-chart") {
      const lobes = differenceLobes(points, x, y);
      addPath(lobes.above, "trends-difference-above"); addPath(lobes.below, "trends-difference-below");
    }
    if (["usage-timeline-chart", "difference-timeline-chart"].includes(shell.id)) {
      const key = series[0].key;
      let above = "", below = "";
      points.forEach((point, i) => {
        if (!finite(point[key])) return;
        const previous = points[i - 1];
        const start = Date.parse(point.periodStartAt);
        const left = Number.isFinite(start) ? Math.max(margin.left, x({ timestampMs: start })) : x(point) - Math.min(5, previous ? (x(point) - x(previous)) * .8 : 3);
        const barWidth = Math.max(.6, x(point) - left - .6);
        const d = `M${left},${y(0)}h${barWidth}V${y(point[key])}h${-barWidth}Z`;
        if (point[key] < 0) below += d; else above += d;
      });
      addPath(above, shell.id === "usage-timeline-chart" ? "trends-activity-fill" : "trends-difference-above");
      addPath(below, "trends-difference-below");
    }
    svg.insertBefore(layer, svg.firstChild);
    const guide = svgNode(document, "line", { y1: margin.top, y2: height - margin.bottom, class: "trends-guide", "aria-hidden": "true", "pointer-events": "none" });
    svg.append(guide);
    const dots = series.map(item => {
      const dot = svgNode(document, "circle", { r: 4, class: `trends-selected-point ${item.className}`, "aria-hidden": "true", "pointer-events": "none" });
      svg.append(dot); return { dot, item };
    });
    const readout = document.createElement("p");
    readout.className = "trends-readout"; readout.dataset.i18nSkip = ""; shell.append(readout);
    const choosePointer = event => {
      if (event.target.closest?.(".trends-reset-marker")) return;
      if (event.buttons || event.pointerType === "touch" && event.type !== "click") return;
      const rect = svg.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / rect.width * width - margin.left, 0, width - margin.left - margin.right) / (width - margin.left - margin.right);
      select(bounds.startMs + ratio * (bounds.endMs - bounds.startMs), true);
    };
    const chooseFocus = event => {
      const cx = Number(event.target.getAttribute("cx"));
      if (event.target.hasAttribute("cx") && finite(cx)) select(bounds.startMs + (cx - margin.left) / (width - margin.left - margin.right) * (bounds.endMs - bounds.startMs), true);
    };
    svg.addEventListener("pointermove", choosePointer); svg.addEventListener("click", choosePointer); svg.addEventListener("focusin", chooseFocus);
    charts.set(shell.id, { ...model, shell, guide, dots, readout, maximumAge: series[0].maxGapMs ?? 6 * 3_600_000,
      cleanup() { svg.removeEventListener("pointermove", choosePointer); svg.removeEventListener("click", choosePointer); svg.removeEventListener("focusin", chooseFocus); } });
    const limits = domain();
    if (limits) {
      input.disabled = replay.disabled = false;
      input.min = limits.startMs; input.max = limits.endMs; input.step = Math.max(1, (limits.endMs - limits.startMs) / 4000);
      select(at === null ? limits.endMs : at);
    }
    if (shell.id === "allowance-timeline-chart") renderEvents();
  }
  return {
    register,
    select,
    setSpendLookup(lookup) { spendAt = lookup; },
    setAllowanceSamples(points) {
      allowanceSamples = points.filter(point => finite(point.timestampMs)).sort((a, b) => a.timestampMs - b.timestampMs);
    },
    setEvents(events) {
      const byTime = new Map();
      for (const event of events) {
        if (!finite(event.timestampMs) || !["observed_reset", "window_change"].includes(event.kind)) continue;
        if (byTime.get(event.timestampMs)?.kind !== "observed_reset") byTime.set(event.timestampMs, event);
      }
      resetEvents = [...byTime.values()];
      $("#trends-event-detail").hidden = true;
      renderEvents();
    },
    refresh() {
      for (const [id, chart] of charts) {
        if (!chart.svg.isConnected || chart.shell.hidden) { chart.cleanup(); charts.delete(id); }
      }
      input.disabled = replay.disabled = !domain();
      if (!domain()) {
        stop(); at = null; setText("#trends-date", "—"); setText("#trends-clock", "—");
        setText("#trends-allowance-value", "—"); setText("#trends-spend-value", "—");
        setText("#trends-spend-basis", t("trends.rateUnavailable"));
      } else select(at ?? domain().endMs);
    },
    refreshLocale(next) {
      if (formatLocale !== next) { formatLocale = next; formatters.clear(); charts.forEach(chart => { delete chart.lastPoint; }); }
      setPlayLabel(); if (at !== null) select(at);
    },
    dispose() { disposed = true; stop(); charts.forEach(chart => chart.cleanup()); charts.clear(); media.removeEventListener("change", motionChanged); document.removeEventListener("visibilitychange", visibilityChanged); pageObserver.disconnect(); },
  };
}
