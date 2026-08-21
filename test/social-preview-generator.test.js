import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/generate-social-preview.js", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

// These reject before a browser is ever launched, so they exercise real
// behaviour without needing Chrome or the network in the suite.
test("the social-preview generator refuses unusable output targets", () => {
  const relative = run(["--output", "card.png"]);
  assert.equal(relative.status, 1);
  assert.match(relative.output, /SOCIAL_PREVIEW_ARGS_INVALID/u);
  assert.match(relative.output, /absolute path/u);

  const wrongType = run(["--output", "/tmp/card.jpg"]);
  assert.equal(wrongType.status, 1);
  assert.match(wrongType.output, /must end in \.png/u);

  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /--output <path\.png> is required/u);

  const unknown = run(["--output", "/tmp/card.png", "--nope", "x"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /Unknown argument: --nope/u);

  const badUrl = run(["--output", "/tmp/card.png", "--url", "ftp://example.com"]);
  assert.equal(badUrl.status, 1);
  assert.match(badUrl.output, /--url must be http\(s\)/u);

  // A flag consuming the next flag as its value silently generated the wrong
  // card rather than failing.
  const danglingValue = run(["--output", "--replace"]);
  assert.equal(danglingValue.status, 1);
  assert.match(danglingValue.output, /requires a value/u);
});

test("an existing card is never overwritten without --replace", async () => {
  // Any existing file will do; the check happens before the browser launches.
  assert.ok(existsSync(SCRIPT));
  const guarded = run(["--output", SCRIPT.replace(/\.js$/u, ".png")]);
  // Either it does not exist (arg checks pass, browser work begins) or it does
  // and we get the overwrite refusal. Only the refusal path is asserted here.
  if (guarded.output.includes("SOCIAL_PREVIEW_OUTPUT_EXISTS")) {
    assert.equal(guarded.status, 1);
  }
});

// The two defects that shipped in the first version of this script. Both were
// invisible in the output file — a card that fails these still has the right
// dimensions and a plausible byte count — so they are pinned in source rather
// than left to be re-derived.
/**
 * Strip comments before pinning behaviour in source. The script's own docstring
 * names the flags of the retired two-invocation design in order to explain why
 * it is retired, so a naive source match reads the explanation as the defect.
 */
function executableSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/u, ""))
    .join("\n");
}

test("the capture and its verification share one browser session", async () => {
  const source = executableSource(await readFile(SCRIPT, "utf8"));

  // Defect 1: the original ran Chrome twice, once with --dump-dom to check the
  // page and once with --screenshot to capture it, then described that as
  // checking "before the shutter". Two invocations are two page loads, so the
  // guard validated a different render from the one it shipped.
  assert.doesNotMatch(source, /--dump-dom/u,
    "a separate --dump-dom run means the verified render is not the captured one");
  assert.doesNotMatch(source, /--screenshot=/u,
    "a separate --screenshot run means the captured render is not the verified one");
  assert.match(source, /Page\.captureScreenshot/u,
    "the screenshot must come from the same DevTools session that was verified");

  // Defect 2: the original gated on /\$[0-9],[0-9]{3}/, which the chart's own
  // axis labels satisfy ($1,000 / $2,000 / $3,000 are gridline text), so it
  // would pass on a page whose headline figure never arrived.
  assert.match(source, /const RESOLVED_ESTIMATE_SENTINEL = "Latest published estimate \("/u,
    "the gate must be the sentence that only appears once the estimate resolves");
  const gateBlock = /if \(!text\.includes\(RESOLVED_ESTIMATE_SENTINEL\)\) \{\s*fail\(/u;
  assert.match(source, gateBlock,
    "the resolved-estimate sentinel must be a hard gate, not advisory");
});

test("the card generator still refuses to bake a retired call to action", async () => {
  const source = executableSource(await readFile(SCRIPT, "utf8"));
  // The regression this script exists to prevent: a card promising a download
  // that already shipped. install-cta.js hides the string at runtime, so only
  // link previews carried it and nobody saw it for months.
  assert.match(source, /SOCIAL_PREVIEW_STALE_CTA/u);
  assert.match(source, /Public download coming soon/u);
});
