import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createCompanionSupervisor } from "../companion-supervisor.js";
import { createDesktopTrayPopover } from "../desktop-tray-popover.js";
import {
  createAuthorizedCompanionFetch,
  installDesktopLocalAuthorization,
  prepareDesktopBrowserAuthorization,
} from "../desktop-local-authorization.js";

const ORIGIN = "http://127.0.0.1:4545";
const CAPABILITY = "X-TiboTattle-Local-Capability";
const OPERATION = "X-TiboTattle-Operation-Authorization";

test("supervisor sends capability only over FD5 and rotates it on same-port restart", async () => {
  const tokens = [];
  const launches = [];
  const children = [];
  const supervisor = createCompanionSupervisor({
    environment: { USAGE_MONITOR_LOCAL_AUTH_FD: "7", LOCAL_CAPABILITY: "untrusted" },
    spawnChild(_command, _args, options) {
      launches.push(options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let input = "";
      child.stdio = [null, child.stdout, child.stderr, null, null, new Writable({
        write(chunk, _encoding, done) { input += chunk; done(); },
        final(done) { tokens.push(input); done(); },
      })];
      child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
      children.push(child);
      return child;
    },
  });
  assert.throws(() => supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`));
  for (let generation = 0; generation < 2; generation += 1) {
    const started = supervisor.start();
    assert.throws(() => supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`));
    children[generation].stdout.emit("data", `USAGE_MONITOR_READY ${ORIGIN}/\n`);
    const ready = await started;
    const token = tokens[generation].trim();
    assert.match(tokens[generation], /^[A-Za-z0-9_-]{43}\n$/u);
    assert.deepEqual(supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`), {
      [CAPABILITY]: token,
    });
    assert.deepEqual(supervisor.requestAuthorizationHeaders(`${ORIGIN}/reports/weekly`), {
      [CAPABILITY]: token,
    });
    assert.equal(launches[generation].env.USAGE_MONITOR_LOCAL_AUTH_FD, "5");
    assert.equal(launches[generation].env.LOCAL_CAPABILITY, undefined);
    assert.equal(JSON.stringify(launches[generation]).includes(token), false);
    assert.equal(JSON.stringify([ready, supervisor.state]).includes(token), false);
    for (const url of ["https://example.invalid/api/overview", `${ORIGIN}/`,
      "http://127.0.0.1:4546/api/overview", "http://user@127.0.0.1:4545/api/overview"]) {
      assert.throws(() => supervisor.requestAuthorizationHeaders(url));
    }
    const stopped = supervisor.stop();
    assert.throws(() => supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`));
    await stopped;
  }
  assert.notEqual(tokens[0], tokens[1]);
});

test("unexpected exit revokes authorization before a replacement companion is ready", async () => {
  let child;
  const supervisor = createCompanionSupervisor({
    spawnChild() {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdio = [null, null, null, null, null, new Writable({
        write(_chunk, _encoding, done) { done(); },
      })];
      return child;
    },
  });
  const started = supervisor.start();
  child.stdout.emit("data", `USAGE_MONITOR_READY ${ORIGIN}/\n`);
  await started;
  child.emit("exit", 1);
  assert.throws(() => supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`));
});

test("supervisor cannot become ready without its private authorization pipe", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
  };
  const supervisor = createCompanionSupervisor({ spawnChild: () => child });
  const started = supervisor.start();
  child.stdout.emit("data", `USAGE_MONITOR_READY ${ORIGIN}/\n`);
  await assert.rejects(started, (error) => error.code === "electron_shell_companion_spawn_failed");
  assert.deepEqual(kills, ["SIGKILL"]);
  assert.equal(supervisor.state.state, "stopped");
  assert.throws(() => supervisor.requestAuthorizationHeaders(`${ORIGIN}/api/overview`));
});

function rendererFixture() {
  let handler = null;
  const session = { webRequest: { onBeforeSendHeaders(_filter, value) { handler = value; } } };
  function contents(id) {
    return { id, mainFrame: { url: `${ORIGIN}/` }, getURL: () => `${ORIGIN}/`,
      isDestroyed: () => false };
  }
  const dashboard = contents(1);
  const settings = contents(2);
  const requestAuthorizationHeaders = () => ({ [CAPABILITY]: "a".repeat(43) });
  function install(webContents) {
    return installDesktopLocalAuthorization({ session, webContents, origin: ORIGIN,
      requestAuthorizationHeaders });
  }
  function request(overrides = {}) {
    let result;
    handler({ webContentsId: dashboard.id, webContents: dashboard,
      frame: dashboard.mainFrame, url: `${ORIGIN}/api/overview`, resourceType: "xhr",
      requestHeaders: { Accept: "application/json", [CAPABILITY.toLowerCase()]: "forged",
        [OPERATION.toLowerCase()]: "b".repeat(43) }, ...overrides }, (value) => { result = value; });
    return result;
  }
  return { session, dashboard, settings, requestAuthorizationHeaders, install, request,
    get handler() { return handler; } };
}

test("shared session adds capability only to registered live main-frame API calls", () => {
  const f = rendererFixture();
  const first = f.install(f.dashboard);
  const handler = f.handler;
  const second = f.install(f.settings);
  assert.equal(f.handler, handler);
  assert.deepEqual(f.request().requestHeaders, { Accept: "application/json",
    [CAPABILITY]: "a".repeat(43), [OPERATION]: "b".repeat(43) });
  assert.equal(f.request({ webContentsId: f.settings.id, webContents: f.settings,
    frame: f.settings.mainFrame }).requestHeaders[CAPABILITY], "a".repeat(43));
  for (const path of ["gradient", "weekly", "quality", "multi-surface"]) {
    assert.equal(f.request({ url: `${ORIGIN}/reports/${path}`, resourceType: "mainFrame" })
      .requestHeaders[CAPABILITY], "a".repeat(43));
  }
  for (const overrides of [
    { webContentsId: 3 }, { webContentsId: undefined },
    { webContents: f.settings }, { frame: null }, { frame: undefined },
    { frame: { url: `${ORIGIN}/` } },
    { url: "http://127.0.0.1:4546/api/overview" },
    { url: "https://example.invalid/api/overview" }, { url: `${ORIGIN}/static/app.js` },
    { url: `${ORIGIN}/reports/unknown` },
  ]) {
    assert.deepEqual(f.request(overrides).requestHeaders, { Accept: "application/json" });
  }
  f.dashboard.mainFrame.url = "https://example.invalid/";
  assert.deepEqual(f.request().requestHeaders, { Accept: "application/json" });
  f.dashboard.mainFrame.url = `${ORIGIN}/`;
  f.dashboard.getURL = () => "https://example.invalid/";
  assert.deepEqual(f.request().requestHeaders, { Accept: "application/json" });
  f.dashboard.getURL = () => `${ORIGIN}/`;
  f.dashboard.isDestroyed = () => true;
  assert.deepEqual(f.request().requestHeaders, { Accept: "application/json" });
  first.remove();
  assert.equal(f.handler, handler);
  second.remove();
  assert.equal(f.handler, null);
  second.remove();
});

test("revoked main-process authority cancels trusted requests and conflicting origins fail closed", () => {
  const f = rendererFixture();
  const installed = installDesktopLocalAuthorization({ session: f.session, webContents: f.dashboard,
    origin: ORIGIN, requestAuthorizationHeaders() { throw new Error("revoked"); } });
  assert.deepEqual(f.request(), { cancel: true, requestHeaders: { Accept: "application/json" } });
  assert.throws(() => f.install(f.settings), /session conflict/u);
  installed.remove();
});

test("main-process status requests use current scoped capability and cannot follow redirects", async () => {
  const requests = [];
  let current = "a".repeat(43);
  const fetch = createAuthorizedCompanionFetch({
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    requestAuthorizationHeaders(url) {
      assert.equal(url, `${ORIGIN}/api/desktop/status`);
      if (current === null) throw new Error("revoked");
      return { [CAPABILITY]: current };
    },
  });
  await fetch(`${ORIGIN}/api/desktop/status`, {
    headers: new Headers({ Accept: "application/json", [CAPABILITY]: "forged" }),
    redirect: "follow",
  });
  assert.equal(requests[0].options.headers[CAPABILITY], current);
  assert.equal(requests[0].options.headers.accept, "application/json");
  assert.equal(requests[0].options.redirect, "error");
  current = null;
  assert.throws(() => fetch(`${ORIGIN}/api/desktop/status`), /revoked/u);
  assert.equal(requests.length, 1);
});

test("explicit browser bootstrap uses bounded same-origin POST grant then operation", async () => {
  const requests = [];
  const capability = "a".repeat(43);
  const operation = "b".repeat(43);
  const prepared = await prepareDesktopBrowserAuthorization({ origin: ORIGIN,
    requestAuthorizationHeaders: () => ({ [CAPABILITY]: capability }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(requests.length === 1 ? { authorization: operation } : { available: true });
    },
  });
  assert.equal(prepared, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${ORIGIN}/api/local/authorization`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    method: "POST", path: "/api/local/authorization/browser-bootstrap",
  });
  assert.equal(requests[1].url, `${ORIGIN}/api/local/authorization/browser-bootstrap`);
  assert.equal(requests[1].options.body, "{}");
  assert.equal(requests[0].options.headers[OPERATION], undefined);
  assert.equal(requests[1].options.headers[OPERATION], operation);
  for (const { options } of requests) {
    assert.equal(options.method, "POST");
    assert.equal(options.headers[CAPABILITY], capability);
    assert.equal(options.headers.Origin, ORIGIN);
    assert.equal(options.headers["X-Usage-Monitor-Local"], "1");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, true);
  }
});

test("browser bootstrap refuses malformed, oversized, rejected or unavailable replies", async () => {
  for (const grant of [null, [], { authorization: "short" },
    { authorization: "b".repeat(43), extra: true }, { authorization: "b".repeat(500) }]) {
    let calls = 0;
    await assert.rejects(prepareDesktopBrowserAuthorization({ origin: ORIGIN,
      requestAuthorizationHeaders: () => ({ [CAPABILITY]: "a".repeat(43) }),
      fetchImpl: async () => { calls += 1; return Response.json(grant); },
    }), (error) => error.code === "electron_shell_desktop_dashboard_browser_unavailable");
    assert.equal(calls, 1);
  }
  for (const status of [200, 403, 302]) {
    let calls = 0;
    await assert.rejects(prepareDesktopBrowserAuthorization({ origin: ORIGIN,
      requestAuthorizationHeaders: () => ({ [CAPABILITY]: "a".repeat(43) }),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? Response.json({ authorization: "b".repeat(43) })
          : Response.json({ available: false }, { status });
      },
    }), (error) => error.code === "electron_shell_desktop_dashboard_browser_unavailable");
    assert.equal(calls, 2);
  }
});

test("browser bootstrap deadline aborts stalled preparation and prevents a late operation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let calls = 0;
  let signal;
  const preparation = prepareDesktopBrowserAuthorization({ origin: ORIGIN,
    requestAuthorizationHeaders: () => ({ [CAPABILITY]: "a".repeat(43) }),
    fetchImpl: (_url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const rejected = assert.rejects(preparation,
    (error) => error.code === "electron_shell_desktop_dashboard_browser_unavailable");
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(signal.aborted, true);
  release(Response.json({ authorization: "b".repeat(43) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("browser bootstrap deadline bounds a stalled reply with nonsettling cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancellations = 0;
  let calls = 0;
  const preparation = prepareDesktopBrowserAuthorization({ origin: ORIGIN,
    requestAuthorizationHeaders: () => ({ [CAPABILITY]: "a".repeat(43) }),
    fetchImpl: async () => {
      calls += 1;
      return new Response(new ReadableStream({
        pull() {},
        cancel() { cancellations += 1; return new Promise(() => {}); },
      }));
    },
  });
  const rejected = assert.rejects(preparation,
    (error) => error.code === "electron_shell_desktop_dashboard_browser_unavailable");
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
});

test("tray popup private session authorizes its main-frame HTTP requests and releases on close", async (t) => {
  const secret = "c".repeat(43);
  const server = createServer((request, response) => {
    response.writeHead(request.headers[CAPABILITY.toLowerCase()] === secret ? 200 : 403);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let handler;
  let candidate;
  class TrayWindow extends EventEmitter {
    constructor(options) {
      super();
      assert.equal(options.webPreferences.partition, "in-memory");
      this.webContents = new EventEmitter();
      this.webContents.id = 17;
      this.webContents.mainFrame = { url: "" };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = () => {};
      this.webContents.session = { webRequest: {
        onBeforeSendHeaders(_filter, value) { handler = value; },
      } };
      candidate = this;
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    isDestroyed() { return false; }
    isVisible() { return false; }
    destroy() { this.emit("closed"); }
  }
  const popover = createDesktopTrayPopover({
    BrowserWindow: TrayWindow,
    preloadPath: fileURLToPath(new URL("../tray-popover-preload.cjs", import.meta.url)),
    pageURL: `${origin}/electron-tray-popup.html`, origin, onAction() {},
    requestAuthorizationHeaders: () => ({ [CAPABILITY]: secret }),
  });
  t.after(() => popover.destroy());
  assert.equal(popover.show(), true);
  await Promise.resolve();
  const details = { webContentsId: candidate.webContents.id,
    frame: candidate.webContents.mainFrame, url: `${origin}/api/overview`,
    requestHeaders: { [CAPABILITY]: "forged" } };
  function injected(overrides) {
    let headers;
    handler({ ...details, ...overrides }, (result) => { headers = result.requestHeaders; });
    return headers;
  }
  assert.equal((await fetch(details.url, { headers: injected() })).status, 200);
  assert.equal((await fetch(details.url, { headers: injected({ frame: { url: origin } }) })).status, 403);
  assert.equal((await fetch(details.url, { headers: injected({ webContentsId: 18 }) })).status, 403);
  candidate.emit("closed");
  assert.equal(handler, null);
});
