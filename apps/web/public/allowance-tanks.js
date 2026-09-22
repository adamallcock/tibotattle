import { drawAllowanceTank } from "./allowance-tank-renderer.js";

let userPaused = false;
let hasAgitated = false;
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

// Three damped standing waves: impulses change velocity, never surface position.
// Each cosine mode has zero mean, so a click cannot alter the displayed capacity.
export function createTankSlosh() {
  const values = [0, 0, 0];
  const velocities = [0, 0, 0];
  const frequencies = [6, 10, 14];
  const damping = [1.2, 1.8, 2.5];
  return {
    values,
    get agitation() {
      return Math.min(1, Math.hypot(...velocities, ...values.map((value, i) => value * frequencies[i])) / 180);
    },
    kick(position = 0.5) {
      const x = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0.5;
      for (let i = 0; i < values.length; i++) {
        const impulse = [100, 70, 45][i] * Math.cos((i + 1) * Math.PI * x);
        // Bound total modal energy while keeping displacement continuous on repeated taps.
        const available = Math.sqrt(Math.max(0, 120 ** 2 - (frequencies[i] * values[i]) ** 2));
        velocities[i] = Math.max(-available, Math.min(available, velocities[i] + impulse));
      }
    },
    step(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      for (let i = 0; i < values.length; i++) {
        const decay = damping[i];
        const frequency = Math.sqrt(frequencies[i] ** 2 - decay ** 2);
        const sine = Math.sin(frequency * dt);
        const cosine = Math.cos(frequency * dt);
        const envelope = Math.exp(-decay * dt);
        const x = values[i];
        const v = velocities[i];
        values[i] = envelope * (x * cosine + (v + decay * x) * sine / frequency);
        velocities[i] = envelope * (v * cosine - (decay * v + frequencies[i] ** 2 * x) * sine / frequency);
      }
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
  let expiryTimer = null;
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
      waves: entry.slosh.values,
      agitation: entry.slosh.agitation,
      colors: entry.colors,
      width: entry.width,
      height: entry.height,
      flowEnabled: !entry.stale && number(entry.card.dataset.resetAt) > Date.now(),
      dpr: entry.dpr,
      widthScale: entry.card.dataset.shortWindow === "true" ? 0.6 : 1,
    });
  }
  for (const card of container.querySelectorAll(".quota-tank")) {
    const remaining = number(card.dataset.remaining);
    if (remaining === null || remaining < 0 || remaining > 100) continue;
    const canvas = doc.createElement("canvas");
    if (!canvas.getContext("2d")) continue;
    canvas.className = "quota-tank-canvas";
    canvas.setAttribute("role", "button");
    canvas.setAttribute("tabindex", "0");
    canvas.setAttribute("aria-label", t("allowance.agitateTank"));
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
    const hint = doc.createElement("span");
    hint.className = "quota-tank-hint";
    hint.textContent = t("allowance.sloshHint");
    card.append(hint);
    const entry = {
      hint,
      card,
      canvas,
      remaining,
      pace,
      stale: card.dataset.stale === "true",
      visible: false,
      width: 0,
      height: 556,
      dpr: 1,
      slosh: createTankSlosh(),
    };
    palette(entry);
    entry.agitate = (event) => {
      if (reduced.matches || userPaused || entry.stale || entry.remaining <= 0) return;
      const bounds = canvas.getBoundingClientRect();
      const scale = bounds.height / 556;
      const vesselWidth = Math.min(188 * scale, bounds.width - 64 * scale)
        * (card.dataset.shortWindow === "true" ? 0.6 : 1);
      const position = event?.clientX === undefined || event.detail === 0
        ? 0.5
        : (event.clientX - bounds.left - (bounds.width - vesselWidth) / 2) / vesselWidth;
      hasAgitated = true;
      for (const item of entries) item.hint.style.visibility = "hidden";
      entry.slosh.kick(position);
      motion.sync();
    };
    entry.keydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.repeat) return;
      entry.agitate();
    };
    canvas.addEventListener("click", entry.agitate);
    canvas.addEventListener("keydown", entry.keydown);
    entries.push(entry);
  }
  if (!entries.length) return { dispose() {} };
  const controlHost = forecast?.querySelector(".weekly-pace-forecast-heading")
    ?? container.querySelector(".quota-tank");
  controlHost?.append(controls);
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
        entry.slosh.step(dt);
        paint(entry, time);
      }
    },
  });
  function sync() {
    // Expiry is independent of canvas visibility: the forecast can remain on
    // screen while every tank is offscreen and its frame loop is asleep.
    if (expiryTimer !== null) view.clearTimeout(expiryTimer);
    expiryTimer = null;
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const entry of entries) {
      if (entry.pace === null) continue;
      if (allowanceTankPace(entry.card.dataset, forecastState, now) === null) {
        entry.pace = null;
        entry.card.dataset.flow = "unknown";
        palette(entry);
        paint(entry);
      } else {
        nextExpiry = Math.min(nextExpiry, number(entry.card.dataset.resetAt));
      }
    }
    if (Number.isFinite(nextExpiry)) {
      expiryTimer = view.setTimeout(sync, Math.min(2_147_483_647, nextExpiry - now));
    }
    const label = t(
      userPaused ? "allowance.resumeMotion" : "allowance.pauseMotion",
    );
    button.setAttribute("aria-label", label);
    button.title = label;
    button.dataset.paused = String(userPaused);
    controls.hidden = reduced.matches
      || !entries.some(entry => !entry.stale && entry.remaining > 0);
    button.setAttribute("aria-pressed", String(userPaused));
    for (const entry of entries) {
      const disabled = reduced.matches || userPaused || entry.stale || entry.remaining <= 0;
      entry.hint.style.visibility = disabled || hasAgitated ? "hidden" : "visible";
      entry.canvas.setAttribute("aria-disabled", String(disabled));
      entry.canvas.setAttribute("tabindex", disabled ? "-1" : "0");
    }
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
      entry.height = Math.max(1, change.contentRect.height);
      // The measured header height keeps labels of any length above the artwork.
      const header = entry.card.querySelector(".quota-tank-header");
      entry.card.style.setProperty("--tank-label-space", `${Math.ceil(header?.getBoundingClientRect().height ?? 0) + 4}px`);
      entry.dpr = Math.min(view.devicePixelRatio || 1, 2);
      entry.canvas.width = entry.width * entry.dpr;
      entry.canvas.height = entry.height * entry.dpr;
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
      if (expiryTimer !== null) view.clearTimeout(expiryTimer);
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
        entry.canvas.removeEventListener("click", entry.agitate);
        entry.canvas.removeEventListener("keydown", entry.keydown);
        entry.canvas.remove();
        entry.hint.remove();
        entry.card.classList.remove("has-liquid-tank");
        entry.card.style.removeProperty("--tank-label-space");
      }
    },
  };
}
