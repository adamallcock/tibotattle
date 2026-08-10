import assert from "node:assert/strict";
import test from "node:test";

import * as canonical from "../../../packages/i18n/index.js";
import {
  I18N_BROWSER_MIRROR_FILE,
  buildI18nBrowserMirror,
  checkI18nBrowserMirror,
} from "../../../scripts/generate-i18n-browser-mirror.js";
import * as browser from "../public/i18n.generated.js";

test("the browser i18n mirror is current and exposes the canonical contract", async () => {
  assert.equal(await checkI18nBrowserMirror(), true);
  assert.deepEqual(Object.keys(browser), Object.keys(canonical));
  assert.equal(
    await buildI18nBrowserMirror(),
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(I18N_BROWSER_MIRROR_FILE, "utf8")),
  );

  assert.equal(
    browser.formatNumber(1234567.89, "en-US"),
    canonical.formatNumber(1234567.89, "en-US"),
  );
  assert.equal(
    browser.formatDate("2026-08-03T12:00:00.000Z", "en-US"),
    canonical.formatDate("2026-08-03T12:00:00.000Z", "en-US"),
  );
});
