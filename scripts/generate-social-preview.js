#!/usr/bin/env node
/**
 * Render the website's social share card (og:image / twitter:image) from the
 * live homepage.
 *
 * The card this replaces was a hand-taken screenshot that lived only in
 * .release-build/, was tracked by nothing, and was copied forward unchanged by
 * every release. By 0.1.15 it still showed an older headline, a DEMO DATA
 * panel, a fitted allowance of $1,879 against a live figure of $2,043, and —
 * the part that actually cost something — "Public download coming soon", months
 * after the app became publicly installable. install-cta.js hides that string
 * at runtime, so visitors saw the correct CTA and only link previews carried
 * the wrong one, which is exactly why it survived unnoticed.
 *
 * The figure on this card is a published estimate that moves daily, so the card
 * has to be regenerated rather than authored. Rendering the homepage (rather
 * than compositing a template) means the card cannot drift from the page's own
 * copy again: the headline, the CTA and the number are whatever the site is
 * serving.
 *
 * ONE browser session, deliberately. The first version of this script ran
 * Chrome twice — once with --dump-dom to check the page, once with --screenshot
 * to capture it — and described that as checking the DOM "before the shutter".
 * It was not: two invocations are two page loads, so the guard validated one
 * render while shipping another, and a card whose figure failed to load on the
 * second render would have passed every check. The capture and the check now
 * share a single navigation over the DevTools protocol, so what is verified is
 * what is written.
 *
 * Headless Chrome directly, not Playwright or Puppeteer: this runs on the
 * release machine, which has Chrome, and a marketing screenshot does not
 * justify a browser in a dependency graph that architecture:check enforces.
 *
 * Usage:
 *   node scripts/generate-social-preview.js --output <path.png> [--url <url>]
 *                                           [--expect-text <string>] [--replace]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 1200x630 is the og:image size every major consumer crops toward. Capturing at
// 1440x756 holds that exact ratio while fitting roughly a fifth more of the page
// in, which is what brings the install command and version line into frame; 2x
// then downsamples for text sharpness.
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 630;
const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 756;
const DEVICE_SCALE = 2;

const NAVIGATION_TIMEOUT_MS = 45_000;
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_POLL_MS = 500;
// The card must not be captured mid-animation or before webfonts swap.
const POST_SETTLE_QUIET_MS = 1_200;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const DEFAULT_URL = "https://tibotattle.com/";

// What proves the page is worth photographing.
//
// An earlier version required only /\$[0-9],[0-9]{3}/, which the chart's own
// axis labels satisfy — the live page carries $1,000, $2,000 and $3,000 as
// gridline text. That guard would have passed on a page whose headline figure
// never arrived. This sentence is emitted only once the published community
// estimate has resolved, so it is the honest signal.
const REQUIRED_TEXT = "TiboTattle";
const RESOLVED_ESTIMATE_SENTINEL = "Latest published estimate (";
// Kept as a second, weaker check purely so the failure message can name the
// figure that was captured. Never the sole gate.
const FIGURE_PATTERN = /\$[0-9]{1,3}(?:,[0-9]{3})+/u;
const STALE_CTA_PATTERN = /Public download coming soon/u;
const SHIPPED_CTA_PATTERN = /brew install/u;

function fail(code, message) {
  console.error(`${code}: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { output: null, url: DEFAULT_URL, expectText: null, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replace") { options.replace = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("SOCIAL_PREVIEW_ARGS_INVALID", `${flag} requires a value`);
    }
    index += 1;
    if (flag === "--output") options.output = value;
    else if (flag === "--url") options.url = value;
    else if (flag === "--expect-text") options.expectText = value;
    else fail("SOCIAL_PREVIEW_ARGS_INVALID", `Unknown argument: ${flag}`);
  }
  if (options.output === null) {
    fail("SOCIAL_PREVIEW_ARGS_INVALID", "--output <path.png> is required");
  }
  if (!options.output.toLowerCase().endsWith(".png")) {
    fail("SOCIAL_PREVIEW_ARGS_INVALID", "--output must end in .png");
  }
  if (!isAbsolute(options.output)) {
    fail("SOCIAL_PREVIEW_ARGS_INVALID", "--output must be an absolute path");
  }
  if (!/^https?:\/\//u.test(options.url)) {
    fail("SOCIAL_PREVIEW_ARGS_INVALID", "--url must be http(s)");
  }
  return options;
}

function locateChrome() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (found === undefined) {
    fail("SOCIAL_PREVIEW_BROWSER_UNAVAILABLE",
      "No Chrome/Chromium/Edge/Brave found. Install one, or capture the card manually at 1200x630.");
  }
  return found;
}

/** Minimal DevTools client: one navigation, one evaluation, one screenshot. */
class DevToolsSession {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      const waiter = this.#pending.get(frame.id);
      if (waiter === undefined) return;
      this.#pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message ?? "devtools error"));
      else waiter.resolve(frame.result ?? {});
    });
  }

  send(method, params = {}, timeoutMs = NAVIGATION_TIMEOUT_MS) {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); rejectPromise(error); },
      });
    });
  }

  close() { try { this.#socket.close(); } catch { /* already gone */ } }
}

async function launchChrome(chrome) {
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
    `--force-device-scale-factor=${DEVICE_SCALE}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  // Chrome prints the DevTools endpoint to stderr once the port is bound.
  const endpoint = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => rejectPromise(new Error("Chrome did not report a DevTools port")), 30_000);
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /ws:\/\/[^\s]+/u.exec(buffer);
      if (match) { clearTimeout(timer); resolvePromise(match[0]); }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Chrome exited early with code ${code}`));
    });
  });
  // The stderr endpoint is the BROWSER target, which does not implement Page.*.
  // The screenshot needs a page target, resolved from the HTTP list endpoint.
  const port = new URL(endpoint).port;
  const deadline = Date.now() + 20_000;
  let pageEndpoint = null;
  while (Date.now() < deadline && pageEndpoint === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = Array.isArray(targets)
        ? targets.find((target) => target?.type === "page"
          && typeof target?.webSocketDebuggerUrl === "string")
        : undefined;
      if (page !== undefined) pageEndpoint = page.webSocketDebuggerUrl;
    } catch { /* Chrome is still binding; retry until the deadline */ }
    if (pageEndpoint === null) await delay(250);
  }
  if (pageEndpoint === null) {
    throw new Error("Chrome exposed no page target to attach to");
  }
  return { child, endpoint: pageEndpoint };
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("DevTools connect timed out")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); rejectPromise(new Error("DevTools connect failed")); }, { once: true });
  });
  return new DevToolsSession(socket);
}

async function readPageText(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText : ''",
    returnByValue: true,
  });
  return typeof result?.result?.value === "string" ? result.result.value : "";
}

/**
 * Wait for the published estimate to resolve. The page paints immediately and
 * fills the headline from an API afterwards, so "loaded" is not the same as
 * "worth photographing".
 */
async function waitForResolvedPage(session) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let text = "";
  while (Date.now() < deadline) {
    text = await readPageText(session);
    if (text.includes(RESOLVED_ESTIMATE_SENTINEL)) return text;
    await delay(SETTLE_POLL_MS);
  }
  return text;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const output = resolve(options.output);
  if (existsSync(output) && !options.replace) {
    fail("SOCIAL_PREVIEW_OUTPUT_EXISTS", `${output} already exists (pass --replace)`);
  }
  const chrome = locateChrome();
  mkdirSync(dirname(output), { recursive: true });

  let launched;
  try {
    launched = await launchChrome(chrome);
  } catch (error) {
    fail("SOCIAL_PREVIEW_BROWSER_FAILED", error.message);
  }
  const { child, endpoint } = launched;
  let session = null;

  try {
    session = await connect(endpoint);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      deviceScaleFactor: DEVICE_SCALE,
      mobile: false,
    });
    await session.send("Page.navigate", { url: options.url });

    const text = await waitForResolvedPage(session);
    if (text.length === 0) {
      fail("SOCIAL_PREVIEW_PAGE_EMPTY", `${options.url} rendered no text`);
    }
    if (!text.includes(REQUIRED_TEXT)) {
      fail("SOCIAL_PREVIEW_PAGE_UNEXPECTED", `${options.url} did not render "${REQUIRED_TEXT}"`);
    }
    if (!text.includes(RESOLVED_ESTIMATE_SENTINEL)) {
      fail("SOCIAL_PREVIEW_FIGURE_MISSING",
        "The published estimate never resolved. Capturing now would publish a card with an empty headline.");
    }
    if (options.expectText !== null && !text.includes(options.expectText)) {
      fail("SOCIAL_PREVIEW_PAGE_UNEXPECTED",
        `${options.url} did not contain expected text: ${options.expectText}`);
    }
    // The specific regression this script exists to prevent: a card promising a
    // download that already shipped.
    if (STALE_CTA_PATTERN.test(text) && !SHIPPED_CTA_PATTERN.test(text)) {
      fail("SOCIAL_PREVIEW_STALE_CTA",
        "The page still advertises the download as unavailable; refusing to bake that into a share card.");
    }

    await delay(POST_SETTLE_QUIET_MS);

    // Same session, same navigation, same render as everything checked above.
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const data = shot?.data;
    if (typeof data !== "string" || data.length === 0) {
      fail("SOCIAL_PREVIEW_CAPTURE_FAILED", "DevTools returned no screenshot data");
    }
    const capturePath = `${output}.capture.png`;
    rmSync(capturePath, { force: true });
    writeFileSync(capturePath, Buffer.from(data, "base64"));

    const { spawnSync } = await import("node:child_process");
    const sips = (args) => {
      const run = spawnSync("sips", args, { encoding: "utf8" });
      if (run.status !== 0) {
        fail("SOCIAL_PREVIEW_RESIZE_FAILED", `sips failed: ${run.stderr?.trim() ?? "unknown"}`);
      }
      return run.stdout ?? "";
    };
    const dimensions = (path) => {
      const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", path]);
      return {
        width: Number(/pixelWidth:\s*(\d+)/u.exec(out)?.[1]),
        height: Number(/pixelHeight:\s*(\d+)/u.exec(out)?.[1]),
      };
    };

    const captured = dimensions(capturePath);
    if (captured.width !== CAPTURE_WIDTH * DEVICE_SCALE
        || captured.height !== CAPTURE_HEIGHT * DEVICE_SCALE) {
      rmSync(capturePath, { force: true });
      fail("SOCIAL_PREVIEW_CAPTURE_INVALID",
        `Expected ${CAPTURE_WIDTH * DEVICE_SCALE}x${CAPTURE_HEIGHT * DEVICE_SCALE}, got ${captured.width}x${captured.height}`);
    }

    rmSync(output, { force: true });
    sips(["-z", String(OUTPUT_HEIGHT), String(OUTPUT_WIDTH), capturePath, "--out", output]);
    rmSync(capturePath, { force: true });

    const final = dimensions(output);
    if (final.width !== OUTPUT_WIDTH || final.height !== OUTPUT_HEIGHT) {
      fail("SOCIAL_PREVIEW_OUTPUT_INVALID",
        `Expected ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}, got ${final.width}x${final.height}`);
    }
    const bytes = statSync(output).size;
    // A solid-colour card of the right dimensions compresses to almost nothing;
    // real captures of this page are hundreds of kilobytes.
    if (bytes < 20_000) {
      fail("SOCIAL_PREVIEW_OUTPUT_SUSPECT",
        `${output} is only ${bytes} bytes, which suggests a blank capture`);
    }

    console.log(JSON.stringify({
      ok: true,
      code: "SOCIAL_PREVIEW_GENERATED",
      output,
      url: options.url,
      width: final.width,
      height: final.height,
      bytes,
      renderedFigure: FIGURE_PATTERN.exec(text)?.[0] ?? "(none)",
    }, null, 2));
  } catch (error) {
    // A DevTools failure must not look like a successful generation.
    if (error?.code === "ERR_UNHANDLED") throw error;
    fail("SOCIAL_PREVIEW_CAPTURE_FAILED", error?.message ?? String(error));
  } finally {
    session?.close();
    child?.kill("SIGTERM");
  }
}

await main();
