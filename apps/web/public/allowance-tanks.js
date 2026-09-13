import { drawAllowanceTank } from "./allowance-tank-renderer.js";

let userPaused = false;
const number = (value) =>
  value !== "" && value != null && Number.isFinite(Number(value))
    ? Number(value)
    : null;

// Match the forecast to its observed pool, never to its position in the grid.
export function allowanceTankPace(tank, forecast, now = Date.now()) {
  const remaining = number(tank.remaining);
  const reset = number(tank.resetAt);
  const ratio = number(forecast?.tankRatio);
  if (
    tank.forecastPool !== "true" ||
    tank.stale === "true" ||
    forecast?.hidden ||
    remaining === null ||
    remaining <= 0 ||
    reset === null ||
    reset <= now ||
    reset !== number(forecast?.tankReset) ||
    remaining !== number(forecast?.tankRemaining) ||
    ratio === null ||
    ratio <= 0
  )
    return null;
  return ratio;
}

// One frame loop for every tank. The host controls visibility and motion policy.
export function createTankMotion({ request, cancel, draw, active }) {
  let frame = null,
    disposed = false,
    previous = null,
    time = 0;
  function tick(stamp) {
    frame = null;
    if (disposed || !active()) {
      previous = null;
      return;
    }
    if (previous === null || stamp - previous >= 1000 / 30) {
      const dt =
        previous === null ? 0 : Math.min(0.1, (stamp - previous) / 1000);
      time += dt;
      previous = stamp;
      draw(time, dt);
    }
    frame = request(tick);
  }
  return {
    sync() {
      if (disposed) return;
      if (!active()) {
        if (frame !== null) cancel(frame);
        frame = null;
        previous = null;
      } else if (frame === null) frame = request(tick);
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancel(frame);
      frame = null;
    },
  };
}

export function mountAllowanceTanks(container, forecast, { t }) {
  if (!container) return { dispose() {} };
  const doc = container.ownerDocument,
    view = doc.defaultView;
  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
  const entries = [];
  const forecastState = forecast
    ? { ...forecast.dataset, hidden: forecast.hidden }
    : null;
  const controls = doc.createElement("div");
  controls.className = "allowance-motion-controls";
  const button = doc.createElement("button");
  button.type = "button";
  const icon = doc.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);
  controls.append(button);
  let forecastVisible = false;
  let disposed = false,
    lastTime = 0;
  const paletteKeys = [
    "bg",
    "panel",
    "ink",
    "muted",
    "edge",
    "metal",
    "bright",
    "shadow",
    "fluid",
    "glow",
    "deep",
  ];
  function palette(entry) {
    const probe = doc.createElement("span");
    probe.hidden = true;
    entry.card.append(probe);
    entry.colors = {};
    for (const key of paletteKeys) {
      probe.style.color = `var(--tank-${key})`;
      entry.colors[key] = view.getComputedStyle(probe).color;
    }
    probe.remove();
  }
  function paint(entry, time = lastTime) {
    if (entry.width <= 0) return;
    drawAllowanceTank(entry.canvas, {
      remaining: entry.remaining,
      pace: entry.pace,
      time: entry.stale ? 0 : time,
      tilt: entry.tilt,
      colors: entry.colors,
      width: entry.width,
      dpr: entry.dpr,
      widthScale: entry.card.dataset.shortWindow === "true" ? 0.4 : 1,
    });
  }
  for (const card of container.querySelectorAll(".quota-tank")) {
    const remaining = number(card.dataset.remaining);
    if (remaining === null || remaining < 0 || remaining > 100) continue;
    const canvas = doc.createElement("canvas");
    if (!canvas.getContext("2d")) continue;
    canvas.className = "quota-tank-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const pace = allowanceTankPace(card.dataset, forecastState);
    card.dataset.flow =
      pace === null
        ? "unknown"
        : pace >= 2
          ? "critical"
          : pace > 1.15
            ? "over"
            : "calm";
    card.classList.add("has-liquid-tank");
    card.insertBefore(canvas, card.querySelector(".quota-tank-bottom"));
    const entry = {
      card,
      canvas,
      remaining,
      pace,
      stale: card.dataset.stale === "true",
      visible: false,
      width: 0,
      dpr: 1,
      tilt: 0,
      velocity: 0,
      pointerX: null,
    };
    palette(entry);
    entry.move = (event) => {
      if (reduced.matches || userPaused || entry.stale) return;
      const dx =
        entry.pointerX === null
          ? 0
          : Math.max(-20, Math.min(20, event.clientX - entry.pointerX));
      entry.pointerX = event.clientX;
      entry.velocity = Math.max(-100, Math.min(100, entry.velocity + dx * 2));
    };
    entry.leave = () => {
      entry.pointerX = null;
    };
    canvas.addEventListener("pointermove", entry.move);
    canvas.addEventListener("pointerleave", entry.leave);
    entries.push(entry);
  }
  if (!entries.length) return { dispose() {} };
  container.after(controls);
  const motion = createTankMotion({
    request: (callback) => view.requestAnimationFrame(callback),
    cancel: (frame) => view.cancelAnimationFrame(frame),
    active: () =>
      !disposed &&
      container.isConnected &&
      !doc.hidden &&
      !reduced.matches &&
      !userPaused &&
      entries.some(
        (entry) => entry.visible && !entry.stale && entry.remaining > 0,
      ),
    draw(time, dt) {
      lastTime = time;
      for (const entry of entries) {
        if (!entry.visible || entry.stale || entry.remaining === 0) continue;
        entry.velocity =
          (entry.velocity - entry.tilt * dt * 13) * Math.exp(-dt * 2.7);
        entry.tilt += entry.velocity * dt;
        // An elapsed reset stops forecast flow even before the next data refresh.
        if (
          entry.pace !== null &&
          number(entry.card.dataset.resetAt) <= Date.now()
        ) {
          entry.pace = null;
          entry.card.dataset.flow = "unknown";
          palette(entry);
        }
        paint(entry, time);
      }
    },
  });
  function sync() {
    const label = t(
      userPaused ? "allowance.resumeMotion" : "allowance.pauseMotion",
    );
    button.setAttribute("aria-label", label);
    button.title = label;
    button.dataset.paused = String(userPaused);
    controls.hidden = reduced.matches;
    button.setAttribute("aria-pressed", String(userPaused));
    if (forecast) {
      const ratio = number(forecastState?.tankRatio);
      const available = entries.some((entry) => entry.pace !== null);
      forecast.dataset.motion =
        !reduced.matches &&
        !userPaused &&
        !doc.hidden &&
        forecastVisible &&
        available
          ? "running"
          : "paused";
      forecast.style.setProperty(
        "--forecast-flow-duration",
        `${Math.max(1.2, 5 / Math.max(0.3, Math.min(5, ratio ?? 1)))}s`,
      );
    }
    motion.sync();
  }
  button.addEventListener("click", () => {
    userPaused = !userPaused;
    sync();
  });
  const resize = new view.ResizeObserver((changes) => {
    for (const change of changes) {
      const entry = entries.find((item) => item.canvas === change.target);
      if (!entry) continue;
      entry.width = Math.max(0, Math.round(change.contentRect.width));
      entry.dpr = Math.min(view.devicePixelRatio || 1, 2);
      entry.canvas.width = entry.width * entry.dpr;
      entry.canvas.height = 418 * entry.dpr;
      paint(entry);
    }
  });
  const intersection = new view.IntersectionObserver((changes) => {
    for (const change of changes) {
      if (change.target === forecast) forecastVisible = change.isIntersecting;
      const entry = entries.find((item) => item.card === change.target);
      if (entry) entry.visible = change.isIntersecting;
    }
    sync();
  });
  if (forecast) intersection.observe(forecast);
  for (const entry of entries) {
    resize.observe(entry.canvas);
    intersection.observe(entry.card);
  }
  const theme = new view.MutationObserver(() => {
    for (const entry of entries) {
      palette(entry);
      paint(entry);
    }
  });
  theme.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  const appearance = view.matchMedia("(prefers-color-scheme: dark)");
  const recolor = () => {
    for (const entry of entries) {
      palette(entry);
      paint(entry);
    }
  };
  appearance.addEventListener("change", recolor);
  reduced.addEventListener("change", sync);
  doc.addEventListener("visibilitychange", sync);
  sync();
  return {
    dispose() {
      disposed = true;
      motion.dispose();
      resize.disconnect();
      intersection.disconnect();
      theme.disconnect();
      reduced.removeEventListener("change", sync);
      appearance.removeEventListener("change", recolor);
      doc.removeEventListener("visibilitychange", sync);
      controls.remove();
      if (forecast) delete forecast.dataset.motion;
      for (const entry of entries) {
        entry.canvas.removeEventListener("pointermove", entry.move);
        entry.canvas.removeEventListener("pointerleave", entry.leave);
        entry.canvas.remove();
        entry.card.classList.remove("has-liquid-tank");
      }
    },
  };
}
