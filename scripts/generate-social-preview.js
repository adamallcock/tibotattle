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
 * after the app became publicly installable. Every link preview said the app
 * was not available yet.
 *
 * The figure on this card is a published estimate that moves daily, so the card
 * has to be regenerated rather than authored. Regenerating from the homepage
 * (rather than compositing a template) means the card cannot drift from the
 * page's own copy again: the headline, the CTA, and the number are whatever the
 * site is actually serving.
 *
 * Headless Chrome is used directly rather than adding Playwright or Puppeteer:
 * this runs on the release machine, which has Chrome, and a screenshot for a
 * marketing asset does not justify a browser dependency in a repository whose
 * production dependency graph is enforced by architecture:check.
 *
 * Usage:
 *   node scripts/generate-social-preview.js --output <path.png> [--url <url>]
 *                                           [--expect-text <string>] [--replace]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// The card is 1200x630 (the og:image size every major consumer crops toward).
// Capturing at 1440x756 keeps that exact ratio while fitting roughly a fifth
// more of the page in, which is what brings the version line and the install
// command into frame; 2x then downsamples for text sharpness.
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 630;
const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 756;
const DEVICE_SCALE = 2;

// The homepage's headline figure arrives from an API after first paint. A
// capture taken before it lands shows an empty or placeholder panel, and that
// failure is invisible in the output file: it is a valid PNG of the right size.
// This budget is generous because a slow capture is recoverable and a blank
// card is not.
const VIRTUAL_TIME_BUDGET_MS = 20_000;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const DEFAULT_URL = "https://tibotattle.com/";

// A rendered card must contain the product name and a currency figure. The
// figure pattern is what proves the community panel resolved rather than
// leaving its placeholder behind.
const REQUIRED_TEXT = "TiboTattle";
const REQUIRED_FIGURE = /\$[0-9],[0-9]{3}/u;

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

function runChrome(chrome, args) {
  const result = spawnSync(chrome, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    fail("SOCIAL_PREVIEW_BROWSER_FAILED", `Chrome could not be run: ${result.error.message}`);
  }
  return result;
}

function sips(args) {
  const result = spawnSync("sips", args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail("SOCIAL_PREVIEW_RESIZE_FAILED", `sips failed: ${result.stderr?.trim() ?? "unknown error"}`);
  }
  return result.stdout ?? "";
}

function imageDimensions(path) {
  const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(/pixelWidth:\s*(\d+)/u.exec(out)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/u.exec(out)?.[1]);
  return { width, height };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const output = resolve(options.output);
  if (existsSync(output) && !options.replace) {
    fail("SOCIAL_PREVIEW_OUTPUT_EXISTS", `${output} already exists (pass --replace)`);
  }
  const chrome = locateChrome();
  mkdirSync(dirname(output), { recursive: true });

  const commonArgs = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
    `--force-device-scale-factor=${DEVICE_SCALE}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
  ];

  // Verify the page renders what the card is supposed to show BEFORE capturing
  // it. A blank or half-loaded card is a valid PNG and passes every size check,
  // so this is the only step that can tell a good capture from a useless one.
  const dom = runChrome(chrome, [...commonArgs, "--dump-dom", options.url]);
  const html = dom.stdout ?? "";
  if (html.length === 0) {
    fail("SOCIAL_PREVIEW_PAGE_EMPTY", `${options.url} returned no DOM`);
  }
  const text = html.replace(/<[^>]*>/gu, " ");
  if (!text.includes(REQUIRED_TEXT)) {
    fail("SOCIAL_PREVIEW_PAGE_UNEXPECTED",
      `${options.url} did not render "${REQUIRED_TEXT}"`);
  }
  if (!REQUIRED_FIGURE.test(text)) {
    fail("SOCIAL_PREVIEW_FIGURE_MISSING",
      "The allowance figure had not rendered. Capturing now would publish a card with an empty panel.");
  }
  if (options.expectText !== null && !text.includes(options.expectText)) {
    fail("SOCIAL_PREVIEW_PAGE_UNEXPECTED",
      `${options.url} did not contain expected text: ${options.expectText}`);
  }
  // Guard the specific regression this script exists to prevent: the retired
  // card promised a download that already shipped.
  const staleCta = /Public download coming soon/u.test(text)
    && !/brew install/u.test(text);
  if (staleCta) {
    fail("SOCIAL_PREVIEW_STALE_CTA",
      "The page is still advertising the download as unavailable; refusing to bake that into a share card.");
  }

  const capturePath = `${output}.capture.png`;
  rmSync(capturePath, { force: true });
  const shot = runChrome(chrome, [...commonArgs, `--screenshot=${capturePath}`, options.url]);
  if (!existsSync(capturePath)) {
    fail("SOCIAL_PREVIEW_CAPTURE_FAILED",
      `Chrome produced no screenshot (exit ${shot.status})`);
  }

  const captured = imageDimensions(capturePath);
  if (captured.width !== CAPTURE_WIDTH * DEVICE_SCALE
      || captured.height !== CAPTURE_HEIGHT * DEVICE_SCALE) {
    rmSync(capturePath, { force: true });
    fail("SOCIAL_PREVIEW_CAPTURE_INVALID",
      `Expected ${CAPTURE_WIDTH * DEVICE_SCALE}x${CAPTURE_HEIGHT * DEVICE_SCALE}, got ${captured.width}x${captured.height}`);
  }

  rmSync(output, { force: true });
  sips(["-z", String(OUTPUT_HEIGHT), String(OUTPUT_WIDTH), capturePath, "--out", output]);
  rmSync(capturePath, { force: true });

  const final = imageDimensions(output);
  if (final.width !== OUTPUT_WIDTH || final.height !== OUTPUT_HEIGHT) {
    fail("SOCIAL_PREVIEW_OUTPUT_INVALID",
      `Expected ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}, got ${final.width}x${final.height}`);
  }
  const bytes = statSync(output).size;
  // A near-empty PNG of the right dimensions is the signature of a page that
  // rendered nothing. Real captures of this page are hundreds of kilobytes.
  if (bytes < 20_000) {
    fail("SOCIAL_PREVIEW_OUTPUT_SUSPECT",
      `${output} is only ${bytes} bytes, which suggests a blank capture`);
  }

  const figure = REQUIRED_FIGURE.exec(text)?.[0] ?? "(none)";
  console.log(JSON.stringify({
    ok: true,
    code: "SOCIAL_PREVIEW_GENERATED",
    output,
    url: options.url,
    width: final.width,
    height: final.height,
    bytes,
    renderedFigure: figure,
  }, null, 2));
}

main();
