import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function copyHarness({ toBlob, write }) {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function shareCardBlob(canvas) {");
  const end = source.indexOf("function copyShareCardText() {", start);
  assert.ok(start !== -1 && end > start, "share-card copy action is available");

  const statuses = [];
  const toasts = [];
  const canvas = { toBlob };
  class ClipboardItem {
    constructor(data) {
      this.data = data;
    }
  }
  const copy = Function(
    "$", "navigator", "ClipboardItem", "setShareCardStatus",
    "showShareCardToast", "updateShareCardActions",
    `let shareCard = { reference: "TEST" };
     let shareCardBusy = false;
     ${source.slice(start, end)}
     return copyShareCardImage;`,
  )(
    () => canvas,
    { clipboard: { write } },
    ClipboardItem,
    (message) => statuses.push(message),
    (message) => toasts.push(message),
    () => {},
  );
  return { copy, statuses, toasts };
}

test("image clipboard write starts during the click before PNG conversion finishes", async () => {
  const order = [];
  let finishPng;
  const { copy, statuses, toasts } = await copyHarness({
    toBlob(callback, type) {
      assert.equal(type, "image/png");
      order.push("toBlob");
      finishPng = callback;
    },
    write(items) {
      order.push("write");
      assert.equal(items.length, 1);
      assert.ok(items[0].data["image/png"] instanceof Promise);
      return items[0].data["image/png"].then((blob) => {
        assert.equal(blob.type, "image/png");
      });
    },
  });

  const pending = copy();
  assert.deepEqual(order, ["toBlob", "write"]);
  assert.equal(toasts.length, 0);
  finishPng(new Blob(["png"], { type: "image/png" }));
  await pending;
  assert.deepEqual(statuses, [""]);
  assert.match(toasts[0], /^Copied\./u);
});

test("failed PNG conversion is reported separately from clipboard refusal", async () => {
  let finishPng;
  const { copy, statuses, toasts } = await copyHarness({
    toBlob(callback) { finishPng = callback; },
    write(items) { return items[0].data["image/png"]; },
  });

  const pending = copy();
  finishPng(null);
  await pending;
  assert.deepEqual(statuses, [
    "TiboTattle could not turn the card into a PNG. Nothing was copied.",
  ]);
  assert.deepEqual(toasts, []);
});

test("rejected clipboard write reports a copy failure after PNG conversion", async () => {
  let finishPng;
  const { copy, statuses, toasts } = await copyHarness({
    toBlob(callback) { finishPng = callback; },
    write() { return Promise.reject(new Error("NotAllowedError")); },
  });

  const pending = copy();
  finishPng(new Blob(["png"], { type: "image/png" }));
  await pending;
  assert.deepEqual(statuses, [
    "The image could not be copied to the clipboard. Use Save image instead.",
  ]);
  assert.deepEqual(toasts, []);
});
