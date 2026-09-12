import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopFirstRunLoginRegistrar,
  desktopFirstRunLoginDialogCopy,
  DESKTOP_FIRST_RUN_LOGIN_STATUSES,
  registerDesktopFirstRunLogin,
} from "../desktop-first-run-login.js";

function snapshot(status, { extra = {} } = {}) {
  return {
    settings: {
      startAtLogin: {
        status,
        canSet: true,
        detail: "raw detail must not cross the helper boundary",
      },
    },
    about: { path: "/private/raw-path-must-not-cross" },
    ...extra,
  };
}

function firstRun(value = {}) {
  return {
    status: "acknowledged",
    receipt: { schemaVersion: "opaque", acknowledged: true },
    startAtLogin: true,
    ...value,
  };
}

function fixture({ result = snapshot("enabled"), error = null, response = 0, dialogError = null, openError = null } = {}) {
  const calls = {
    setStartAtLogin: [],
    openSystemSettings: [],
    dialogs: [],
  };
  const controller = {
    handlers: {
      async setStartAtLogin(value) {
        calls.setStartAtLogin.push(value);
        if (error) throw error;
        return result;
      },
      async openSystemSettings(value) {
        calls.openSystemSettings.push(value);
        if (openError) throw openError;
      },
    },
  };
  const dialog = {
    async showMessageBox(options) {
      calls.dialogs.push(options);
      if (dialogError) throw dialogError;
      return { response };
    },
  };
  return {
    controller,
    dialog,
    calls,
    registrar: createDesktopFirstRunLoginRegistrar({ controller, dialog }),
  };
}

test("login result vocabulary is closed and deeply frozen", () => {
  assert.deepEqual(DESKTOP_FIRST_RUN_LOGIN_STATUSES, [
    "not_requested",
    "enabled",
    "needs_approval",
    "continued_without_login",
  ]);
  assert.equal(Object.isFrozen(DESKTOP_FIRST_RUN_LOGIN_STATUSES), true);
  assert.equal(Object.isFrozen(desktopFirstRunLoginDialogCopy()), true);
  assert.equal(Object.isFrozen(desktopFirstRunLoginDialogCopy().buttons), true);
});

test("fresh checked first run registers once and accepts only enabled snapshot status", async () => {
  const value = fixture();
  const result = await value.registrar.apply(firstRun());
  assert.deepEqual(result, { status: "enabled" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(value.calls.setStartAtLogin, [{ enabled: true }]);
  assert.deepEqual(value.calls.openSystemSettings, []);
  assert.deepEqual(value.calls.dialogs, []);
});

test("fresh checked first run reports needs approval and offers Login Items", async () => {
  const value = fixture({ result: snapshot("needs-approval"), response: 0 });
  const result = await value.registrar.apply(firstRun());
  assert.deepEqual(result, { status: "needs_approval" });
  assert.deepEqual(value.calls.setStartAtLogin, [{ enabled: true }]);
  assert.deepEqual(value.calls.openSystemSettings, []);
  assert.equal(value.calls.dialogs.length, 1);
  assert.deepEqual(value.calls.dialogs[0].buttons, [
    "Continue",
    "Open Login Items Settings",
  ]);
});

test("needs approval opens only the fixed startup settings target when requested", async () => {
  const value = fixture({ result: snapshot("needs-approval"), response: 1 });
  const result = await value.registrar.apply(firstRun());
  assert.deepEqual(result, { status: "needs_approval" });
  assert.deepEqual(value.calls.openSystemSettings, [{ target: "startup" }]);
});

test("unchecked, existing, cancelled, and blocked first runs never register", async () => {
  const cases = [
    firstRun({ startAtLogin: false }),
    { status: "acknowledged", receipt: { schemaVersion: "opaque" }, startAtLogin: false },
    { status: "cancelled", startAtLogin: false },
    { status: "blocked", reason: "invalid_receipt", startAtLogin: false },
  ];
  for (const valueToApply of cases) {
    const value = fixture({ error: new Error("must not be called") });
    const result = await value.registrar.apply(valueToApply);
    assert.deepEqual(result, { status: "not_requested" });
    assert.deepEqual(value.calls.setStartAtLogin, []);
    assert.deepEqual(value.calls.dialogs, []);
    assert.deepEqual(value.calls.openSystemSettings, []);
  }
});

test("registration failures continue startup and keep raw errors out of dialog/result", async () => {
  const raw = new Error("secret path /private/user/project and credential");
  const value = fixture({ error: raw, response: 0 });
  const result = await value.registrar.apply(firstRun());
  assert.deepEqual(result, { status: "continued_without_login" });
  assert.equal(value.calls.dialogs.length, 1);
  const dialogText = JSON.stringify(value.calls.dialogs[0]);
  assert.equal(dialogText.includes(raw.message), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(value.calls.openSystemSettings, []);
});

test("registration failures open Login Items only when the second dialog button is selected", async () => {
  const value = fixture({ error: new Error("opaque"), response: 1 });
  const result = await value.registrar.apply(firstRun());
  assert.deepEqual(result, { status: "continued_without_login" });
  assert.deepEqual(value.calls.openSystemSettings, [{ target: "startup" }]);
});

test("dialog and system-settings failures are contained", async () => {
  const dialogFailure = fixture({ error: new Error("opaque"), dialogError: new Error("dialog raw") });
  assert.deepEqual(
    await dialogFailure.registrar.apply(firstRun()),
    { status: "continued_without_login" },
  );
  assert.deepEqual(dialogFailure.calls.openSystemSettings, []);

  const settingsFailure = fixture({
    error: new Error("opaque"),
    response: 1,
    openError: new Error("settings raw"),
  });
  assert.deepEqual(
    await settingsFailure.registrar.apply(firstRun()),
    { status: "continued_without_login" },
  );
  assert.deepEqual(settingsFailure.calls.openSystemSettings, [{ target: "startup" }]);
});

test("system, English, Simplified Chinese, and Spanish copy is fixed and complete", () => {
  const expectations = [
    ["en-US", "TiboTattle will continue without Start at login", "Continue", "Open Login Items Settings"],
    ["zh-Hans", "TiboTattle 将继续启动，但不会在登录时启动", "继续", "打开登录项设置"],
    ["es", "TiboTattle continuará sin iniciarse al iniciar sesión", "Continuar", "Abrir configuración de elementos de inicio"],
  ];
  for (const [locale, title, continueLabel, settingsLabel] of expectations) {
    const copy = desktopFirstRunLoginDialogCopy({ locale });
    assert.equal(copy.title, title);
    assert.deepEqual(copy.buttons, [continueLabel, settingsLabel]);
    assert.ok(copy.message.length > 0);
    assert.ok(copy.detail.length > 0);
  }
  assert.equal(
    desktopFirstRunLoginDialogCopy({ locale: "system", systemLocales: ["es-ES"] }).buttons[0],
    "Continuar",
  );
});

test("registrar is one-shot even when apply is accidentally called twice", async () => {
  const value = fixture();
  const first = await value.registrar.apply(firstRun());
  const second = await value.registrar.apply(firstRun());
  assert.strictEqual(first, second);
  assert.deepEqual(value.calls.setStartAtLogin, [{ enabled: true }]);
  assert.deepEqual(value.calls.dialogs, []);
});

test("dependencies and first-run shape are strict", async () => {
  assert.throws(
    () => createDesktopFirstRunLoginRegistrar({ controller: {}, dialog: {} }),
    /controller\.handlers/u,
  );
  const value = fixture();
  await assert.rejects(
    value.registrar.apply({ status: "acknowledged", startAtLogin: true, raw: "unexpected" }),
    /firstRun has unexpected keys/u,
  );
  await assert.rejects(
    value.registrar.apply({ status: "unknown", startAtLogin: true }),
    /firstRun\.status is invalid/u,
  );
  assert.deepEqual(value.calls.setStartAtLogin, []);
});

test("convenience registration call uses the same bounded contract", async () => {
  const value = fixture();
  assert.deepEqual(
    await registerDesktopFirstRunLogin({
      firstRun: firstRun(),
      controller: value.controller,
      dialog: value.dialog,
    }),
    { status: "enabled" },
  );
  assert.deepEqual(value.calls.setStartAtLogin, [{ enabled: true }]);
});
