import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { translate } from "../public/localization.js";

async function downloadHarness({ native = true, electron = false, openResult = "opened" } = {}) {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const nameStart = source.indexOf("const SHARE_CARD_SAVED_FILE_PATTERN =");
  const nameEnd = source.indexOf("function setShareCardStatus(", nameStart);
  const actionStart = source.indexOf("function shareCardBlob(canvas) {");
  const actionEnd = source.indexOf("function copyShareCardImage() {", actionStart);
  assert.ok(nameStart >= 0 && nameEnd > nameStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

  const events = new Map();
  const timers = new Map();
  const posted = [];
  const statuses = [];
  const toasts = [];
  const downloads = [];
  const opened = [];
  const bridge = { postMessage(message) { posted.push(message); } };
  const window = {
    webkit: { messageHandlers: { tibotattleDownloads: bridge } },
    addEventListener(name, listener) {
      const listeners = events.get(name) ?? new Set();
      listeners.add(listener);
      events.set(name, listeners);
    },
    removeEventListener(name, listener) { events.get(name)?.delete(listener); },
  };
  if (electron) {
    window.tibotattleDesktop = {
      version: "v1",
      async openLatestDownload() {
        opened.push(true);
        return openResult;
      },
    };
  }
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [2026, 8, 28, 7, 4]));
    }
  }
  let nextTimer = 0;
  const actions = Function(
    "$", "document", "window", "URL", "Date", "setTimeout", "clearTimeout",
    "setShareCardStatus", "showShareCardToast", "dismissShareCardToast",
    "updateShareCardActions", "t",
    `let shareCard = { reference: "TEST" };
     let shareCardBusy = false;
     ${source.slice(nameStart, nameEnd)}
     ${source.slice(actionStart, actionEnd)}
     return { shareCardFileName, downloadShareCard };`,
  )(
    () => ({ toBlob(callback) { callback(new Blob(["png"], { type: "image/png" })); } }),
    {
      body: { classList: { contains: () => native } },
      createElement(tag) {
        assert.equal(tag, "a");
        const link = { click() { downloads.push(link.download); } };
        return link;
      },
    },
    window,
    { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    FixedDate,
    (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    (id) => timers.delete(id),
    (message) => statuses.push(message),
    (message, options) => toasts.push({ message, options }),
    () => {},
    () => {},
    (key, values = {}) => translate(key, values, "en-US"),
  );
  return {
    ...actions, downloads, posted, statuses, toasts, opened,
    dispatch(name, detail) {
      for (const listener of events.get(name) ?? []) listener({ detail });
    },
    fireTimeout() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test("share export names use local save time without a reference", async () => {
  const { shareCardFileName } = await downloadHarness();
  assert.equal(
    shareCardFileName(new Date(2026, 8, 28, 7, 4)),
    "2026-09-28-07-04-tibotattle-results.png",
  );
});

test("native save confirms the final Downloads basename before offering Open image", async () => {
  const harness = await downloadHarness();
  const pending = harness.downloadShareCard();
  await setImmediate();
  const requestedFilename = "2026-09-28-07-04-tibotattle-results.png";
  assert.deepEqual(harness.downloads, [requestedFilename]);
  assert.deepEqual(harness.toasts, []);
  harness.dispatch("tibotattle:share-download-result", {
    status: "saved", requestedFilename: "other.png", filename: "other.png",
  });
  assert.deepEqual(harness.toasts, []);
  harness.dispatch("tibotattle:share-download-result", {
    status: "saved", requestedFilename,
    filename: "2026-09-28-07-04-tibotattle-results-1.png",
  });
  await pending;
  assert.equal(
    harness.toasts[0].message,
    "Saved to Downloads as 2026-09-28-07-04-tibotattle-results-1.png.",
  );
  harness.toasts[0].options.onAction();
  assert.deepEqual(harness.posted, [{
    type: "open-completed-download",
    filename: "2026-09-28-07-04-tibotattle-results-1.png",
  }]);
  harness.dispatch("tibotattle:share-open-result", {
    filename: "2026-09-28-07-04-tibotattle-results-1.png", opened: false,
  });
  assert.equal(
    harness.statuses.at(-1),
    "The image could not be opened automatically. Find it in Downloads.",
  );
});

test("native save failure and invalid or missing confirmation do not claim success", async () => {
  for (const outcome of ["failed", "invalid", "unconfirmed"]) {
    const harness = await downloadHarness();
    const pending = harness.downloadShareCard();
    await setImmediate();
    if (outcome === "failed") {
      harness.dispatch("tibotattle:share-download-result", {
        status: "failed",
        requestedFilename: "2026-09-28-07-04-tibotattle-results.png",
      });
    } else if (outcome === "invalid") {
      harness.dispatch("tibotattle:share-download-result", {
        status: "saved",
        requestedFilename: "2026-09-28-07-04-tibotattle-results.png",
        filename: "../not-a-share-image.png",
      });
    } else {
      harness.fireTimeout();
    }
    await pending;
    assert.deepEqual(harness.toasts, []);
    assert.match(harness.statuses.at(-1), /could not be saved|could not be confirmed/u);
  }
});

test("plain browser reports a requested download without claiming its location", async () => {
  const harness = await downloadHarness({ native: false });
  await harness.downloadShareCard();
  assert.equal(
    harness.toasts[0].message,
    "Download requested as 2026-09-28-07-04-tibotattle-results.png.",
  );
  assert.equal(harness.toasts[0].options, undefined);
});

test("Electron confirms the final saved basename and opens through the fixed bridge", async () => {
  const harness = await downloadHarness({ native: false, electron: true });
  const pending = harness.downloadShareCard();
  await setImmediate();
  assert.deepEqual(harness.toasts, []);
  harness.dispatch("tibotattle:share-card-download-completed", {
    filename: "2026-09-28-07-04-tibotattle-results-1.png",
  });
  await pending;
  assert.equal(harness.toasts[0].message,
    "Saved to Downloads as 2026-09-28-07-04-tibotattle-results-1.png.");
  harness.toasts[0].options.onAction();
  await setImmediate();
  assert.deepEqual(harness.opened, [true]);
});

test("Electron save and open failures are reported without a false success", async () => {
  const failed = await downloadHarness({ native: false, electron: true });
  const pending = failed.downloadShareCard();
  await setImmediate();
  failed.dispatch("tibotattle:share-card-download-failed");
  await pending;
  assert.deepEqual(failed.toasts, []);
  assert.match(failed.statuses.at(-1), /could not be saved/u);

  const unavailable = await downloadHarness({ native: false, electron: true, openResult: "unavailable" });
  const saved = unavailable.downloadShareCard();
  await setImmediate();
  unavailable.dispatch("tibotattle:share-card-download-completed", {
    filename: "2026-09-28-07-04-tibotattle-results.png",
  });
  await saved;
  unavailable.toasts[0].options.onAction();
  await setImmediate();
  assert.match(unavailable.statuses.at(-1), /could not be opened automatically/u);
});
