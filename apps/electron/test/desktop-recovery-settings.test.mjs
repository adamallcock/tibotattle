import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopRecoverySettingsAction,
  desktopRecoverySettingsDialogCopy,
} from "../desktop-recovery-settings.js";

function fixture({ response = 2, handlerError = null, dialogError = null } = {}) {
  const calls = [];
  const handlerCalls = {
    choose: [],
    default: [],
  };
  let callNumber = 0;
  const dialog = {
    async showMessageBox(options) {
      calls.push(options);
      callNumber += 1;
      const error = typeof dialogError === "function"
        ? dialogError(callNumber)
        : callNumber === 1 ? dialogError : null;
      if (error) throw error;
      return {
        response: typeof response === "function" ? response(callNumber) : response,
      };
    },
  };
  const controller = {
    handlers: {
      async chooseCodexHome(...args) {
        handlerCalls.choose.push(args);
        if (handlerError) throw handlerError;
      },
      async useDefaultCodexHome(...args) {
        handlerCalls.default.push(args);
        if (handlerError) throw handlerError;
      },
    },
  };
  return { calls, controller, dialog, handlerCalls };
}

test("Choose Codex Folder invokes only the bounded custom-folder handler", async () => {
  const value = fixture({ response: 0 });
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });

  const result = await action.show();

  assert.deepEqual(result, { status: "choose_applied" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(value.handlerCalls.choose, [[{}]]);
  assert.deepEqual(value.handlerCalls.default, []);
  assert.deepEqual(Reflect.ownKeys(value.handlerCalls.choose[0][0]), []);
  assert.deepEqual(value.calls[0].buttons, [
    "Choose Codex Folder",
    "Use Default Folder",
    "Cancel",
  ]);
  assert.equal(value.calls[0].cancelId, 2);
  assert.equal(value.calls[0].noLink, true);
});

test("Use Default Folder invokes only the bounded default-folder handler", async () => {
  const value = fixture({ response: 1 });
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });

  const result = await action.show();

  assert.deepEqual(result, { status: "default_applied" });
  assert.deepEqual(value.handlerCalls.choose, []);
  assert.deepEqual(value.handlerCalls.default, [[{}]]);
});

test("Cancel changes nothing and malformed dialog responses fail closed to Cancel", async () => {
  for (const response of [2, undefined, -1, 99, "0"]) {
    const value = fixture({ response });
    const action = createDesktopRecoverySettingsAction({
      controller: value.controller,
      dialog: value.dialog,
    });
    const result = await action.show();
    assert.deepEqual(result, { status: "cancelled" });
    assert.deepEqual(value.handlerCalls, { choose: [], default: [] });
  }
});

test("concurrent recovery clicks share one native dialog and one controller action", async () => {
  const calls = [];
  const handlerCalls = [];
  let resolveDialog;
  const value = {
    dialog: {
      showMessageBox(options) {
        calls.push(options);
        return new Promise((resolve) => {
          resolveDialog = resolve;
        });
      },
    },
    controller: {
      handlers: {
        async chooseCodexHome(...args) {
          handlerCalls.push(args);
        },
        async useDefaultCodexHome() {},
      },
    },
  };
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });
  const first = action.show();
  const second = action.show();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  resolveDialog({ response: 0 });
  assert.deepEqual(await first, { status: "choose_applied" });
  assert.deepEqual(handlerCalls, [[{}]]);

  // A later, sequential recovery click may retry after the first attempt has
  // settled, but it still gets its own single-flight window.
  const third = action.show();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  resolveDialog({ response: 2 });
  assert.deepEqual(await third, { status: "cancelled" });
});

test("a native dialog failure is contained without invoking a controller handler", async () => {
  const value = fixture({ dialogError: new Error("private/path/raw dialog failure") });
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });

  const result = await action.show();

  assert.deepEqual(result, { status: "dialog_unavailable" });
  assert.deepEqual(value.handlerCalls, { choose: [], default: [] });
  assert.doesNotMatch(JSON.stringify(value.calls), /private|raw|failure/u);
});

test("a controller failure is contained behind one fixed failure dialog", async () => {
  const value = fixture({
    response: (callNumber) => callNumber === 1 ? 0 : 2,
    handlerError: new Error("/private/secret/raw controller failure"),
  });
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });

  const result = await action.show();

  assert.deepEqual(result, { status: "action_failed" });
  assert.deepEqual(value.handlerCalls.choose, [[{}]]);
  assert.deepEqual(value.handlerCalls.default, []);
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.calls[1].buttons, ["Cancel"]);
  assert.doesNotMatch(JSON.stringify(value.calls), /private|secret|raw|controller failure/u);
});

test("a failure-dialog error is also contained and leaves recovery usable", async () => {
  const value = fixture({
    response: (callNumber) => callNumber === 1 ? 1 : 0,
    handlerError: new Error("opaque"),
    dialogError: (callNumber) => callNumber === 2
      ? new Error("failure dialog unavailable")
      : null,
  });
  const action = createDesktopRecoverySettingsAction({
    controller: value.controller,
    dialog: value.dialog,
  });

  const result = await action.show();

  assert.deepEqual(result, { status: "action_failed" });
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.handlerCalls.default, [[{}]]);
});

test("all reviewed locales provide fixed recovery copy without renderer or path data", () => {
  const expected = {
    "en-US": ["Choose Codex Folder", "Use Default Folder", "Cancel"],
    "zh-Hans": ["选择 Codex 文件夹", "使用默认文件夹", "取消"],
    es: ["Elegir carpeta de Codex", "Usar carpeta predeterminada", "Cancelar"],
  };
  for (const locale of Object.keys(expected)) {
    const copy = desktopRecoverySettingsDialogCopy({ locale });
    assert.deepEqual(copy.buttons, expected[locale]);
    assert.equal(Object.isFrozen(copy), true);
    assert.equal(Object.isFrozen(copy.buttons), true);
    assert.doesNotMatch(JSON.stringify(copy), /__|\/private|\\Users|raw error/u);
  }
});

test("system locale negotiation selects Simplified Chinese copy", () => {
  const copy = desktopRecoverySettingsDialogCopy({
    locale: "system",
    systemLocales: ["zh-CN"],
  });
  assert.deepEqual(copy.buttons, ["选择 Codex 文件夹", "使用默认文件夹", "取消"]);
});

test("factory validates the main-process dependencies and bounded options", () => {
  const valid = fixture();
  assert.throws(
    () => createDesktopRecoverySettingsAction({ dialog: valid.dialog }),
    /controller.handlers is required/u,
  );
  assert.throws(
    () => createDesktopRecoverySettingsAction({ controller: valid.controller }),
    /dialog.showMessageBox is required/u,
  );
  assert.throws(
    () => createDesktopRecoverySettingsAction({
      controller: valid.controller,
      dialog: valid.dialog,
      extra: true,
    }),
    /unexpected keys/u,
  );
  assert.throws(
    () => createDesktopRecoverySettingsAction({
      controller: valid.controller,
      dialog: valid.dialog,
      locale: "",
    }),
    /locale must be a bounded string/u,
  );
  assert.throws(
    () => createDesktopRecoverySettingsAction({
      controller: valid.controller,
      dialog: valid.dialog,
      systemLocales: Array.from({ length: 17 }, () => "en-US"),
    }),
    /systemLocales must be bounded strings/u,
  );
  assert.throws(
    () => createDesktopRecoverySettingsAction({
      controller: { handlers: { chooseCodexHome() {} } },
      dialog: valid.dialog,
    }),
    /useDefaultCodexHome is required/u,
  );
});
