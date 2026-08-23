import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDesktopFirstRunReceiptBackend,
  DESKTOP_FIRST_RUN_CONTINUE_LABEL,
  DESKTOP_FIRST_RUN_DIALOG_COPY,
  DESKTOP_FIRST_RUN_QUIT_LABEL,
  DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
  desktopFirstRunDialogCopy,
  ensureDesktopFirstRunAcknowledged,
  validateDesktopFirstRunReceipt,
} from "../desktop-first-run.js";

function receipt() {
  return validateDesktopFirstRunReceipt({
    schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
    acknowledged: true,
  });
}

function fakeDialog(responses = []) {
  const calls = [];
  return {
    calls,
    async showMessageBox(options) {
      calls.push(options);
      const response = responses.shift();
      return response !== null && typeof response === "object"
        ? response
        : { response: response ?? 0 };
    },
  };
}

function fakeBackend({ value = null, loadError = null, saveError = null } = {}) {
  const state = { value, loadCalls: 0, saveCalls: [], loadError, saveError };
  return {
    state,
    async load() {
      state.loadCalls += 1;
      if (state.loadError) throw state.loadError;
      return state.value;
    },
    async save(next) {
      state.saveCalls.push(next);
      if (state.saveError) throw state.saveError;
      state.value = next;
      return next;
    },
  };
}

test("first run shows native disclosure and persists only after Continue", async () => {
  const dialog = fakeDialog([{ response: 0, checkboxChecked: true }]);
  const backend = fakeBackend();
  const quitCalls = [];
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
    quit: async () => quitCalls.push("quit"),
  });

  assert.equal(result.status, "acknowledged");
  assert.deepEqual(result.receipt, receipt());
  assert.equal(result.startAtLogin, true);
  assert.equal(backend.state.loadCalls, 1);
  assert.equal(backend.state.saveCalls.length, 1);
  assert.deepEqual(backend.state.saveCalls[0], receipt());
  assert.deepEqual(quitCalls, []);
  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0].title, DESKTOP_FIRST_RUN_DIALOG_COPY.title);
  assert.equal(dialog.calls[0].message, DESKTOP_FIRST_RUN_DIALOG_COPY.message);
  assert.equal(dialog.calls[0].detail, DESKTOP_FIRST_RUN_DIALOG_COPY.detail);
  assert.deepEqual(dialog.calls[0].buttons, [
    DESKTOP_FIRST_RUN_CONTINUE_LABEL,
    DESKTOP_FIRST_RUN_QUIT_LABEL,
  ]);
  assert.equal(dialog.calls[0].checkboxLabel, DESKTOP_FIRST_RUN_DIALOG_COPY.checkboxLabel);
  assert.equal(dialog.calls[0].checkboxChecked, true);
  assert.equal(dialog.calls[0].defaultId, 0);
  assert.equal(dialog.calls[0].cancelId, 1);
});

test("first-run native copy resolves the system and explicit desktop languages", async () => {
  const expectations = [
    [
      "en",
      "TiboTattle local data",
      "Continue",
      "Quit",
      "Start TiboTattle at login (you can change this later in Settings)",
      /Reads:.*Stores:.*Community contribution.*notifications.*development build.*Never contributed.*Keep the app open/su,
    ],
    [
      "zh-Hans",
      "TiboTattle 本地数据",
      "继续",
      "退出",
      "登录时启动 TiboTattle（稍后可在“设置”中更改）",
      /读取：.*存储：.*社区贡献.*提醒.*开发版本.*从未贡献.*分析运行期间请保持应用打开/su,
    ],
    [
      "es",
      "Datos locales de TiboTattle",
      "Continuar",
      "Salir",
      "Iniciar TiboTattle al iniciar sesión (puedes cambiarlo después en Configuración)",
      /Lee:.*Guarda:.*contribución a la comunidad.*notificaciones.*compilación de desarrollo.*Nunca se contribuye.*Mantén la aplicación abierta/su,
    ],
  ];
  for (const [locale, title, continueLabel, quitLabel, checkboxLabel, detailPattern] of expectations) {
    const copy = desktopFirstRunDialogCopy({ locale });
    assert.equal(copy.title, title);
    assert.deepEqual(copy.buttons, [continueLabel, quitLabel]);
    assert.equal(copy.checkboxLabel, checkboxLabel);
    assert.notEqual(copy.message, "");
    assert.match(copy.detail, detailPattern);
  }
  assert.equal(
    desktopFirstRunDialogCopy({ locale: "system", systemLocales: ["es-ES"] }).buttons[0],
    "Continuar",
  );
  assert.equal(
    desktopFirstRunDialogCopy({ locale: "zh-Hans", systemLocales: ["es-ES"] }).buttons[0],
    "继续",
  );

  const dialog = fakeDialog([0]);
  await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: fakeBackend(),
    locale: "es",
  });
  const copy = desktopFirstRunDialogCopy({ locale: "es" });
  assert.deepEqual(dialog.calls[0], {
    type: "info",
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [...copy.buttons],
    checkboxLabel: copy.checkboxLabel,
    checkboxChecked: true,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
});

test("a valid receipt skips the dialog and does not rewrite state", async () => {
  const dialog = fakeDialog();
  const backend = fakeBackend({ value: receipt() });
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
  });

  assert.equal(result.status, "acknowledged");
  assert.deepEqual(result.receipt, receipt());
  assert.equal(result.startAtLogin, false);
  assert.equal(dialog.calls.length, 0);
  assert.equal(backend.state.saveCalls.length, 0);
});

test("Quit/cancel never persists acknowledgement or starts through the gate", async () => {
  const dialog = fakeDialog([{ response: 1, checkboxChecked: true }]);
  const backend = fakeBackend();
  const quitCalls = [];
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
    quit: () => quitCalls.push("quit"),
  });

  assert.deepEqual(result, { status: "cancelled", startAtLogin: false });
  assert.equal(backend.state.saveCalls.length, 0);
  assert.deepEqual(quitCalls, ["quit"]);
});

test("invalid or unsafe receipt fails visibly closed", async () => {
  const dialog = fakeDialog();
  const backend = fakeBackend({ value: { schemaVersion: "old", acknowledged: true } });
  const quitCalls = [];
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
    quit: () => quitCalls.push("quit"),
  });

  assert.deepEqual(result, {
    status: "blocked",
    reason: "invalid_receipt",
    startAtLogin: false,
  });
  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0].type, "error");
  assert.equal(dialog.calls[0].buttons[0], DESKTOP_FIRST_RUN_QUIT_LABEL);
  assert.deepEqual(quitCalls, ["quit"]);
  assert.equal(backend.state.saveCalls.length, 0);
});

test("receipt load failure fails visibly closed without showing consent", async () => {
  const dialog = fakeDialog();
  const backend = fakeBackend({ loadError: new Error("unsafe state") });
  const quitCalls = [];
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
    quit: () => quitCalls.push("quit"),
  });

  assert.deepEqual(result, {
    status: "blocked",
    reason: "invalid_receipt",
    startAtLogin: false,
  });
  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0].type, "error");
  assert.deepEqual(quitCalls, ["quit"]);
});

test("persistence failure fails closed and never allows a companion launch", async () => {
  const dialog = fakeDialog([{ response: 0, checkboxChecked: true }]);
  const backend = fakeBackend({ saveError: new Error("disk failure") });
  const quitCalls = [];
  const result = await ensureDesktopFirstRunAcknowledged({
    dialog,
    receiptBackend: backend,
    quit: () => quitCalls.push("quit"),
  });

  assert.deepEqual(result, {
    status: "blocked",
    reason: "persistence_failed",
    startAtLogin: false,
  });
  assert.equal(dialog.calls.length, 2);
  assert.equal(dialog.calls[0].type, "info");
  assert.equal(dialog.calls[1].type, "error");
  assert.deepEqual(quitCalls, ["quit"]);
});

test("POSIX receipt backend uses the owner-only atomic sibling store", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-first-run-"));
  try {
    const root = join(parent, "state");
    const backend = createDesktopFirstRunReceiptBackend({
      platform: "darwin",
      rootPath: root,
    });
    assert.equal(await backend.load(), null);
    await backend.save(receipt());
    assert.deepEqual(
      await createDesktopFirstRunReceiptBackend({ platform: "darwin", rootPath: root }).load(),
      receipt(),
    );
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal(
      (await lstat(join(root, DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME))).mode & 0o777,
      0o600,
    );
    await chmod(root, 0o755);
    await assert.rejects(backend.load(), (error) => error.code
      === "desktop_settings_backend_unsafe_state");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Windows receipt backend requires the branded protected store and never uses Node fallback", () => {
  const calls = [];
  assert.throws(
    () => createDesktopFirstRunReceiptBackend({
      platform: "win32",
      rootPath: "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state",
      windowsProtectedStateStore: {
        readJson: () => calls.push("read"),
        createJson: () => calls.push("create"),
        replaceJson: () => calls.push("replace"),
      },
      fs: {
        readFile: () => calls.push("fallback"),
      },
    }),
    (error) => error.code === "desktop_settings_backend_store_invalid",
  );
  assert.deepEqual(calls, []);
});
