import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  createDesktopActionInterface,
  createDesktopMenuTemplate,
  DESKTOP_ACTION_NAMES,
  installDesktopApplicationMenu,
  resolveDesktopLocale,
} from "../desktop-menu.js";
import {
  createDesktopTrayTemplate,
  resolveDesktopTrayIcon,
  STATUS_PLACEHOLDER,
  TRAY_ICON_RELATIVE_PATH,
  TRAY_ICON_SIZE,
  TRAY_TEMPLATE_CROP_INSET_RATIO,
  TRAY_TEMPLATE_CROP_SIZE_RATIO,
} from "../desktop-tray.js";

function actionRecorder() {
  const calls = [];
  const actions = Object.fromEntries(
    DESKTOP_ACTION_NAMES.map((name) => [name, () => calls.push(name)]),
  );
  return { actions, calls };
}

function item(template, label) {
  const value = template.find((entry) => entry.label === label);
  assert.ok(value, `missing menu item: ${label}`);
  return value;
}

test("desktop action interface is bounded and supplies safe no-ops", () => {
  const actions = createDesktopActionInterface({ show: () => "shown" });
  assert.equal(Object.isFrozen(actions), true);
  assert.deepEqual(Object.keys(actions), [...DESKTOP_ACTION_NAMES]);
  assert.equal(actions.show(), "shown");
  for (const name of DESKTOP_ACTION_NAMES.filter((value) => value !== "show")) {
    assert.doesNotThrow(() => actions[name](), name);
  }
  assert.throws(
    () => createDesktopActionInterface(null),
    /actions must be an object/u,
  );
});

test("missing usage refresh is a no-op and cannot invoke the separate retry action", () => {
  const calls = [];
  const actions = createDesktopActionInterface({
    retry: () => calls.push("retry"),
  });
  actions.refresh();
  assert.deepEqual(calls, []);
  actions.retry();
  assert.deepEqual(calls, ["retry"]);
});

test("application menu maps all desktop commands to the injected action interface", () => {
  const { actions, calls } = actionRecorder();
  const template = createDesktopMenuTemplate({
    appName: "TiboTattle Dev",
    platform: "darwin",
    actions,
  });
  assert.deepEqual(template.map(({ label }) => label), [
    "TiboTattle Dev",
    "Edit",
    "View",
    "Window",
  ]);

  const application = template[0].submenu;
  item(application, "About TiboTattle Dev").click();
  item(application, "Settings…").click();
  item(application, "Quit TiboTattle Dev").click();
  assert.deepEqual(calls, ["about", "settings", "quit"]);
  assert.equal(item(application, "Settings…").accelerator, "CmdOrCtrl+,");
  assert.equal(item(application, "Quit TiboTattle Dev").accelerator, "CmdOrCtrl+Q");

  const edit = template.find(({ label }) => label === "Edit").submenu;
  assert.deepEqual(edit.map(({ role }) => role), ["copy", "selectAll"]);

  const view = template.find(({ label }) => label === "View").submenu;
  item(view, "Refresh Usage").click();
  item(view, "Toggle Sidebar").click();
  item(view, "Show TiboTattle Dev").click();
  item(view, "Focus TiboTattle Dev").click();
  assert.deepEqual(calls, [
    "about",
    "settings",
    "quit",
    "refresh",
    "toggleSidebar",
    "show",
    "focus",
  ]);
  assert.equal(item(view, "Refresh Usage").accelerator, "CmdOrCtrl+R");
  assert.equal(item(view, "Toggle Sidebar").accelerator, "CmdOrCtrl+Shift+S");

  const windowMenu = template.find(({ label }) => label === "Window").submenu;
  assert.deepEqual(windowMenu.map(({ role }) => role), ["minimize", "zoom", "front"]);
});

test("Windows and Linux menus use conventional File and Help entries", () => {
  const { actions, calls } = actionRecorder();
  for (const platform of ["win32", "linux"]) {
    const template = createDesktopMenuTemplate({
      appName: "TiboTattle Dev",
      platform,
      actions,
    });
    assert.deepEqual(template.map(({ label }) => label), [
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    const file = template.find(({ label }) => label === "File").submenu;
    item(file, "Open").click();
    item(file, "Settings…").click();
    item(file, "Exit").click();
    const help = template.find(({ label }) => label === "Help").submenu;
    item(help, "About TiboTattle Dev").click();
    assert.equal(item(file, "Settings…").accelerator, "CmdOrCtrl+,");
    assert.equal(item(file, "Exit").accelerator, "CmdOrCtrl+Q");
  }
  assert.deepEqual(calls.slice(-4), ["show", "settings", "quit", "about"]);
});

test("desktop menu and tray copy resolves every supported language", () => {
  const expected = {
    "en-US": { file: "File", refresh: "Refresh Usage", tray: "Open TiboTattle Dev", status: STATUS_PLACEHOLDER },
    "zh-Hans": { file: "文件", refresh: "刷新使用情况", tray: "打开 TiboTattle Dev", status: "状态不可用" },
    es: { file: "Archivo", refresh: "Actualizar uso", tray: "Abrir TiboTattle Dev", status: "Estado no disponible" },
  };
  for (const [locale, copy] of Object.entries(expected)) {
    assert.equal(resolveDesktopLocale(locale, ["en-US"]), locale);
    const menu = createDesktopMenuTemplate({
      appName: "TiboTattle Dev",
      platform: "win32",
      locale,
    });
    assert.equal(menu[0].label, copy.file);
    const file = menu[0].submenu;
    assert.equal(file[1].label, locale === "en-US" ? "Settings…" : locale === "zh-Hans" ? "设置…" : "Configuración…");
    const view = menu.find(({ label }) => label === (locale === "en-US" ? "View" : locale === "zh-Hans" ? "视图" : "Ver"));
    assert.equal(view.submenu[0].label, copy.refresh);
    const tray = createDesktopTrayTemplate({ appName: "TiboTattle Dev", locale });
    assert.equal(tray.find((entry) => entry.label === copy.tray)?.label, copy.tray);
    assert.equal(tray[1].label, copy.status);
  }
});

test("application menu installation is dependency-injected and optional in plain Node", () => {
  const calls = [];
  const menu = { template: [] };
  const Menu = {
    buildFromTemplate(template) {
      calls.push(["build", template]);
      return menu;
    },
    setApplicationMenu(value) {
      calls.push(["set", value]);
    },
  };
  assert.equal(installDesktopApplicationMenu({ Menu, appName: "TiboTattle" }), menu);
  assert.equal(calls[0][0], "build");
  assert.deepEqual(calls[1], ["set", menu]);
  assert.equal(installDesktopApplicationMenu({ Menu: undefined }), null);
});

test("tray menu exposes truthful status and shared action callbacks", () => {
  const { actions, calls } = actionRecorder();
  const template = createDesktopTrayTemplate({
    appName: "TiboTattle Dev",
    actions,
  });
  assert.deepEqual(template.map(({ label, type }) => type === "separator" ? type : label), [
    "TiboTattle Dev · – allowance",
    STATUS_PLACEHOLDER,
    "separator",
    "Open TiboTattle Dev",
    "Refresh Usage",
    "Retry",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit",
  ]);
  assert.equal(item(template, STATUS_PLACEHOLDER).enabled, false);
  item(template, "Open TiboTattle Dev").click();
  item(template, "Refresh Usage").click();
  item(template, "Retry").click();
  item(template, "Settings…").click();
  item(template, "About TiboTattle Dev").click();
  item(template, "Quit").click();
  assert.deepEqual(calls, ["show", "refresh", "retry", "settings", "about", "quit"]);
  assert.equal(item(template, "Refresh Usage").accelerator, "CmdOrCtrl+R");
  assert.equal(item(template, "Settings…").accelerator, "CmdOrCtrl+,");
  assert.equal(item(template, "Quit").accelerator, "CmdOrCtrl+Q");
});

function nativeImageFixture({
  sourceEmpty = false,
  resizedEmpty = false,
  includeTemplate = true,
} = {}) {
  const calls = {
    createFromPath: [],
    crop: [],
    resize: [],
    template: [],
  };
  const resized = {
    isEmpty: () => resizedEmpty,
  };
  if (includeTemplate) {
    resized.setTemplateImage = (value) => calls.template.push(value);
  }
  const source = {
    isEmpty: () => sourceEmpty,
    getSize: () => ({ width: 1_024, height: 1_024 }),
    crop: (options) => {
      calls.crop.push(options);
      return source;
    },
    resize: (options) => {
      calls.resize.push(options);
      return resized;
    },
  };
  return {
    calls,
    resized,
    nativeImage: {
      createFromPath: (value) => {
        calls.createFromPath.push(value);
        return source;
      },
    },
  };
}

test("tray icon resolution loads the fixed packaged asset and sizes it for macOS", () => {
  const fixture = nativeImageFixture();
  const result = resolveDesktopTrayIcon({
    nativeImage: fixture.nativeImage,
    resourceRoot: "/trusted/app.asar",
    platform: "darwin",
  });
  assert.equal(result, fixture.resized);
  assert.deepEqual(fixture.calls.createFromPath, [
    join("/trusted/app.asar", TRAY_ICON_RELATIVE_PATH),
  ]);
  assert.deepEqual(fixture.calls.crop, [{
    x: Math.floor(1_024 * TRAY_TEMPLATE_CROP_INSET_RATIO),
    y: Math.floor(1_024 * TRAY_TEMPLATE_CROP_INSET_RATIO),
    width: Math.round(1_024 * TRAY_TEMPLATE_CROP_SIZE_RATIO),
    height: Math.round(1_024 * TRAY_TEMPLATE_CROP_SIZE_RATIO),
  }]);
  assert.deepEqual(fixture.calls.resize, [{
    width: 32,
    height: 32,
    quality: "best",
  }]);
  assert.deepEqual(fixture.calls.template, [true]);
});

test("macOS tray icon removes the app plate and keeps only a template mark", () => {
  const bitmap = Buffer.alloc(32 * 32 * 4);
  // One bright app-mark pixel and one dark plate pixel in BGRA order.
  bitmap.set([240, 245, 250, 255], 0);
  bitmap.set([40, 70, 35, 255], 4);
  const calls = { templateBitmap: null, template: [] };
  const finalImage = {
    isEmpty: () => false,
    setTemplateImage: (value) => calls.template.push(value),
  };
  const templateSource = {
    resize: () => finalImage,
  };
  const workingImage = {
    isEmpty: () => false,
    toBitmap: () => bitmap,
    setTemplateImage() {},
  };
  const source = {
    isEmpty: () => false,
    resize: () => workingImage,
  };
  const result = resolveDesktopTrayIcon({
    nativeImage: {
      createFromPath: () => source,
      createFromBitmap: (value, options) => {
        calls.templateBitmap = { value: Buffer.from(value), options };
        return templateSource;
      },
    },
    resourceRoot: "/trusted/app",
    platform: "darwin",
  });
  assert.equal(result, finalImage);
  assert.equal(calls.templateBitmap.value[3], 255);
  assert.equal(calls.templateBitmap.value[7], 0);
  assert.deepEqual(calls.templateBitmap.options, {
    width: 32,
    height: 32,
    scaleFactor: 1,
  });
  assert.deepEqual(calls.template, [true]);
});

test("Windows tray icon resolution uses the same fixed asset without template mode", () => {
  const fixture = nativeImageFixture();
  const result = resolveDesktopTrayIcon({
    nativeImage: fixture.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "win32",
  });
  assert.equal(result, fixture.resized);
  assert.deepEqual(fixture.calls.createFromPath, [
    join("/trusted/app", TRAY_ICON_RELATIVE_PATH),
  ]);
  assert.deepEqual(fixture.calls.template, []);
});

test("tray icon resolution keeps an explicit injected icon seam", () => {
  const icon = { kind: "reviewed-test-icon" };
  assert.equal(resolveDesktopTrayIcon({ icon }), icon);
});

test("tray icon resolution fails closed for missing, empty, and invalid images", () => {
  const emptySource = nativeImageFixture({ sourceEmpty: true });
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: emptySource.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "linux",
  }), undefined);
  assert.deepEqual(emptySource.calls.resize, []);

  const emptyResized = nativeImageFixture({ resizedEmpty: true });
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: emptyResized.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "linux",
  }), undefined);

  assert.equal(resolveDesktopTrayIcon({
    nativeImage: {
      createFromPath() {
        throw new Error("asset missing");
      },
    },
    resourceRoot: "/trusted/app",
  }), undefined);
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: {},
    resourceRoot: "/trusted/app",
  }), undefined);
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: nativeImageFixture().nativeImage,
    resourceRoot: "relative-root",
  }), undefined);
});
