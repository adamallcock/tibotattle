import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const performanceStyles = await readFile(new URL("../public/model-performance.css", import.meta.url), "utf8");
const reference = await readFile(new URL("../../../docs/reference/2026-09-13-dashboard-component-reference.md", import.meta.url), "utf8");

test("dashboard component styles keep shared visual rules scoped", () => {
  for (const selector of [
    ".reporting-period-toolbar",
    ".reporting-period-selection",
    ".dashboard-tabs",
    ".chart-card",
    ".dashboard-state",
    ".evidence-meta",
    ".technical-disclosure",
  ]) {
    assert.match(styles, new RegExp(`\\.dashboard-shell[^{]*${selector.replaceAll(".", "\\.")}`), selector);
  }
  assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*dashboard-state-indicator/u);
  assert.match(styles, /aria-pressed="true"/u);
  assert.match(styles, /aria-selected="true"/u);
});

test("model performance has explicit evidence rows and state treatments", () => {
  for (const selector of [
    ".performance-evidence",
    ".performance-evidence-row",
    ".performance-card",
    ".performance-empty",
    ".performance-details",
  ]) assert.match(performanceStyles, new RegExp(selector.replaceAll(".", "\\.")), selector);
  assert.match(performanceStyles, /data-state="partial"/u);
  assert.match(performanceStyles, /data-state="stale"/u);
  assert.match(performanceStyles, /prefers-reduced-motion:\s*reduce/u);
});

test("dashboard component reference documents the integration contract", () => {
  for (const token of [
    ".reporting-period-toolbar",
    ".segmented-control",
    ".dashboard-tabs",
    ".chart-card",
    ".dashboard-state",
    ".evidence-meta",
    ".technical-disclosure",
  ]) assert.match(reference, new RegExp(token.replaceAll(".", "\\.")), token);
  assert.match(reference, /aria-pressed="true"/u);
  assert.match(reference, /aria-selected="true"/u);
});
