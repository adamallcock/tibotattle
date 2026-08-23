import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readPublic = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

test("dashboard exposes bounded live state, focusable skip targets, and a labelled Share region", async () => {
  const html = await readPublic("index.html");
  const css = await readPublic("styles.css");

  assert.match(html, /<main id="main" tabindex="-1">/u);
  assert.match(
    html,
    /id="global-state"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"[\s\S]*?aria-relevant="text"/u,
  );
  assert.match(
    html,
    /<article[\s\S]*?class="panel share-panel"[\s\S]*?id="share-panel"[\s\S]*?aria-labelledby="share-panel-title"[\s\S]*?tabindex="-1"/u,
  );
  assert.match(html, /<h3 id="share-panel-title">A results card you can post<\/h3>/u);
  assert.match(css, /\.share-panel:focus\s*\{/u);
  assert.match(css, /#main:focus-visible/u);
  assert.match(css, /@media \(forced-colors: active\), \(prefers-contrast: more\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /outline:\s*3px solid Highlight/u);
});

test("Electron Settings exposes focusable skip target and a live login summary relationship", async () => {
  const html = await readPublic("electron-settings.html");
  const css = await readPublic("electron-settings.css");

  assert.match(html, /<main class="settings-window" id="settings-content" tabindex="-1">/u);
  assert.match(
    html,
    /id="settings-start-at-login-summary"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/u,
  );
  assert.match(
    html,
    /id="settings-start-at-login"[\s\S]*?aria-describedby="settings-start-at-login-summary"/u,
  );
  assert.match(css, /#settings-content:focus/u);
  assert.match(css, /@media \(forced-colors: active\), \(prefers-contrast: more\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /outline:\s*3px solid Highlight/u);
});
