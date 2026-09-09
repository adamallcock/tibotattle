import assert from "node:assert/strict";
import test from "node:test";

import {
  WORK_USAGE_COMPONENTS,
  WORK_USAGE_SCHEMA,
  createWorkUsageAccumulator,
} from "../../../src/reporting/index.js";
import { createWorkUsageService } from "../../../src/application/index.js";
import { formatApiMoney, formatSharePercent } from "../public/ui-format.js";
import { translate } from "../public/localization.js";
import {
  mountWorkUsageView,
  validateWorkUsageResponse,
} from "../public/work-usage-view.js";

const NOW = 1_700_000_000_000;
const SNAPSHOT = "snapshot-synthetic";
const BASE_QUERY = Object.freeze({
  schemaVersion: WORK_USAGE_SCHEMA,
  period: "7d",
  grouping: "project",
  sort: "tokens",
  pageSize: 25,
});

function completeComponents(values = {}) {
  return Object.fromEntries(
    WORK_USAGE_COMPONENTS.map((name) => [name, values[name] ?? null]),
  );
}

function syntheticSource({
  components = completeComponents(),
  at = NOW - 1_000,
} = {}) {
  const accumulator = createWorkUsageAccumulator();
  accumulator.add({
    thread: "thread-synthetic",
    project: "project-synthetic",
    worktree: "worktree-synthetic",
    model: "model-synthetic",
    at,
    components,
    price: { amount: null, status: "unpriced" },
  });
  return {
    status: "available",
    generation: { id: 1, status: "complete" },
    scope: "scope-synthetic",
    scopes: [{ id: "scope-synthetic", status: "available", events: 1 }],
    metadata: { observedAt: NOW },
    pricing: { basis: "event_time", fingerprint: "pricing-synthetic" },
    models: ["model-synthetic"],
    threadLookup: {},
    cells: accumulator.finish(),
  };
}

async function availableResponse(options = {}) {
  const service = createWorkUsageService({
    build: async () => syntheticSource(options),
    enrich: async ({ rows }) =>
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          { name: "Synthetic project", method: "fixture" },
        ]),
      ),
    clock: () => NOW,
    newId: () => SNAPSHOT,
  });
  const preparing = await service.query(BASE_QUERY);
  assert.equal(preparing.status, "preparing");
  assert.equal(validateWorkUsageResponse(preparing), preparing);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const response = await service.query({
      ...BASE_QUERY,
      snapshotId: preparing.snapshotId,
    });
    if (response.status === "available") {
      assert.equal(response.snapshotId, SNAPSHOT);
      return response;
    }
  }
  assert.fail(
    "synthetic work-usage service did not produce an available response",
  );
}

function cloneResponse(response) {
  return structuredClone(response);
}

function assertInvalid(response, message) {
  assert.throws(
    () => validateWorkUsageResponse(response),
    (error) => error?.message === "invalid_response",
    message,
  );
}

test("the browser boundary accepts the real service states and all-null components", async () => {
  const available = await availableResponse();
  assert.equal(validateWorkUsageResponse(available), available);
  assert.deepEqual(available.totals.components, completeComponents());
  assert.deepEqual(available.rows[0].components, completeComponents());

  for (const status of ["missing", "unavailable"]) {
    const response = {
      schemaVersion: WORK_USAGE_SCHEMA,
      status,
      snapshotId: `${status}-snapshot`,
    };
    assert.equal(validateWorkUsageResponse(response), response, status);
  }

  const service = createWorkUsageService({
    build: async () => syntheticSource(),
    clock: () => NOW,
    newId: () => SNAPSHOT,
  });
  const preparing = await service.query(BASE_QUERY);
  const cancelled = await service.query({
    ...BASE_QUERY,
    action: "cancel",
    snapshotId: preparing.snapshotId,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(validateWorkUsageResponse(cancelled), cancelled);
});

test("the browser boundary rejects malformed nullable component values", async () => {
  const valid = await availableResponse();
  for (const component of WORK_USAGE_COMPONENTS) {
    const response = cloneResponse(valid);
    response.rows[0].components[component] = -1;
    assertInvalid(response, `${component} cannot be negative`);
  }
  for (const component of WORK_USAGE_COMPONENTS) {
    const response = cloneResponse(valid);
    response.totals.components[component] = "0";
    assertInvalid(response, `${component} must be an integer or null`);
  }

  const nullTokens = cloneResponse(valid);
  nullTokens.rows[0].tokens = null;
  nullTokens.totals.tokens = null;
  assert.equal(validateWorkUsageResponse(nullTokens), nullTokens);
});

test("the browser boundary rejects invalid timestamps before rendering", async () => {
  const valid = await availableResponse();
  const cases = [
    [
      "fromMs",
      (response) => {
        response.fromMs = -1;
      },
    ],
    [
      "toMs",
      (response) => {
        response.toMs = response.fromMs - 1;
      },
    ],
    [
      "observedAt",
      (response) => {
        response.metadata.observedAt = "not-a-timestamp";
      },
    ],
    [
      "row lastAt",
      (response) => {
        response.rows[0].lastAt = "not-a-timestamp";
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const response = cloneResponse(valid);
    mutate(response);
    assertInvalid(response, `${name} must remain a renderable timestamp`);
  }
});

test("the browser boundary rejects malformed transient display and scope records", async () => {
  const valid = await availableResponse();

  const displayContainer = cloneResponse(valid);
  displayContainer.display = [];
  assertInvalid(displayContainer, "display must be a bounded object");

  const displayEntry = cloneResponse(valid);
  displayEntry.display[displayEntry.rows[0].id] = { name: 42 };
  assertInvalid(displayEntry, "display names must be strings or null");

  const scopesContainer = cloneResponse(valid);
  scopesContainer.scopes = ["scope-synthetic"];
  assertInvalid(
    scopesContainer,
    "scope entries must retain their object shape",
  );

  const scopeId = cloneResponse(valid);
  scopeId.scopes[0].id = "";
  assertInvalid(scopeId, "scope ids must be bounded non-empty strings");
});

/*
 * The work-usage view is intentionally a browser module without a framework
 * runtime. This small DOM double covers the actual element operations used by
 * mountWorkUsageView, so these tests exercise the mounted interaction and
 * request fencing rather than duplicating its rendering implementation.
 */
class MountedElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = Object.create(null);
    this.style = Object.create(null);
    this.listeners = new Map();
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.isConnected = true;
  }

  get textContent() {
    return (
      this._text +
      this.children.map((child) => child.textContent ?? "").join("")
    );
  }

  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value ?? "");
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  get lastChild() {
    return this.children.at(-1) ?? null;
  }

  get options() {
    return this.children.filter((child) => child.tagName === "OPTION");
  }

  get classList() {
    return {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/u).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(" ");
      },
      remove: (...names) => {
        const values = new Set(this.className.split(/\s+/u).filter(Boolean));
        names.forEach((name) => values.delete(name));
        this.className = [...values].join(" ");
      },
      contains: (name) => this.className.split(/\s+/u).includes(name),
    };
  }

  append(...nodes) {
    for (const node of nodes) this.#appendOne(node);
  }

  prepend(...nodes) {
    const old = this.children;
    this.children = [];
    for (const node of nodes) this.#appendOne(node);
    for (const node of old) this.#appendOne(node);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }

  #appendOne(node) {
    if (node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number") {
      this._text += String(node);
      return;
    }
    if (node.parentNode) {
      node.parentNode.children = node.parentNode.children.filter(
        (child) => child !== node,
      );
    }
    node.parentNode = this;
    this.children.push(node);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "id") delete this.id;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (candidate) => candidate !== listener,
      ),
    );
  }

  dispatchEvent(event) {
    const dispatched = event ?? { type: "" };
    if (!dispatched.type) throw new Error("test event needs a type");
    if (!dispatched.preventDefault)
      dispatched.preventDefault = () => {
        dispatched.defaultPrevented = true;
      };
    dispatched.target ??= this;
    dispatched.currentTarget = this;
    for (const listener of this.listeners.get(dispatched.type) ?? [])
      listener(dispatched);
    return !dispatched.defaultPrevented;
  }

  click() {
    return this.dispatchEvent({ type: "click" });
  }

  focus(options) {
    this.ownerDocument.activeElement = this;
    this.focusOptions = options;
  }

  contains(candidate) {
    return (
      candidate === this ||
      this.children.some((child) => child.contains?.(candidate))
    );
  }

  querySelectorAll(selector) {
    const matches = (node) => {
      if (selector.startsWith("."))
        return node.classList.contains(selector.slice(1));
      if (selector.startsWith("#")) return node.id === selector.slice(1);
      const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
      if (attribute) {
        const value = node.getAttribute(attribute[1]);
        return (
          value !== null &&
          (attribute[2] === undefined || value === attribute[2])
        );
      }
      return node.tagName === selector.toUpperCase();
    };
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class MountedDocument {
  constructor() {
    this.activeElement = null;
  }

  createElement(tagName) {
    return new MountedElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return new MountedElement(tagName, this);
  }

  createTextNode(text) {
    const node = new MountedElement("#text", this);
    node._text = String(text);
    return node;
  }
}

class MountedWindow {
  constructor() {
    this.listeners = new Map();
    this.MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (candidate) => candidate !== listener,
      ),
    );
  }
}

function mountedRoot() {
  const documentRef = new MountedDocument();
  const root = documentRef.createElement("section");
  root.id = "projects";
  root.inert = false;
  return { documentRef, root, windowRef: new MountedWindow() };
}

function findMounted(root, predicate, seen = new Set()) {
  if (seen.size > 1000)
    throw new Error(`mounted tree too large near ${root.tagName}`);
  if (seen.has(root)) return [];
  seen.add(root);
  return root.children.flatMap((child) => [
    ...(predicate(child) ? [child] : []),
    ...findMounted(child, predicate, seen),
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function mountedRow({
  id,
  kind,
  tokens,
  cost,
  events,
  share,
  lastAt = NOW - 1_000,
  activeThreads = 1,
  activeProjects = 1,
}) {
  return {
    id,
    kind,
    tokens,
    events,
    lastAt,
    incompleteEvents: 0,
    priceStatus: cost === null ? "unpriced" : "complete",
    share,
    costUsdExact: cost,
    activeThreads,
    activeProjects,
    components: completeComponents({ input_uncached_tokens: tokens }),
  };
}

function mountedResponse({
  rows,
  display,
  totalTokens = 100,
  totalCost = "10.00",
  snapshotId = "snapshot-mounted",
}) {
  return {
    schemaVersion: WORK_USAGE_SCHEMA,
    status: "available",
    snapshotId,
    scope: "scope-mounted",
    fromMs: NOW - 86_400_000,
    toMs: NOW,
    metadata: { observedAt: NOW },
    offset: 0,
    rowCount: rows.length,
    nextCursor: null,
    models: ["model-mounted"],
    scopes: [{ id: "scope-mounted", status: "available", events: 3 }],
    display,
    totals: mountedRow({
      id: "total",
      kind: "total",
      tokens: totalTokens,
      cost: totalCost,
      events: 3,
      share: 1,
      lastAt: NOW,
    }),
    rows,
  };
}

function httpResponse(value) {
  return { ok: true, json: async () => value };
}

function mountedTranslator(key, values) {
  return translate(key, values, "en-US");
}

const PROJECT_A = mountedRow({
  id: "project-a",
  kind: "project",
  tokens: 60,
  cost: "6.00",
  events: 2,
  share: 0.6,
});
const PROJECT_B = mountedRow({
  id: "project-b",
  kind: "project",
  tokens: 40,
  cost: "4.00",
  events: 1,
  share: 0.4,
});
const PROJECT_ROWS_RESPONSE = mountedResponse({
  rows: [PROJECT_A, PROJECT_B],
  display: {
    "project-a": { name: "Project A" },
    "project-b": { name: "Project B" },
  },
});
const THREAD_A = mountedRow({
  id: "thread-a",
  kind: "thread",
  tokens: 25,
  cost: "2.50",
  events: 1,
  share: 25 / 60,
});
const THREAD_B = mountedRow({
  id: "thread-b",
  kind: "thread",
  tokens: 35,
  cost: "3.50",
  events: 1,
  share: 35 / 60,
});
const THREAD_A_RESPONSE = mountedResponse({
  rows: [THREAD_A, THREAD_B],
  display: {
    "thread-a": {
      name: "Thread A",
      shortId: "thread-a",
      codexUrl: "codex://threads/11111111-1111-4111-8111-111111111111",
    },
    "thread-b": {
      name: "Thread B",
      shortId: "thread-b",
      codexUrl: "codex://threads/22222222-2222-4222-8222-222222222222",
    },
  },
  totalTokens: 60,
  totalCost: "6.00",
});
const THREAD_B_RESPONSE = mountedResponse({
  rows: [THREAD_B],
  display: {
    "thread-b": {
      name: "Thread B",
      shortId: "thread-b",
      codexUrl: "codex://threads/22222222-2222-4222-8222-222222222222",
    },
  },
  totalTokens: 40,
  totalCost: "4.00",
});

async function settleMountedView() {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
  }
}

test("mounted project expansion pins the snapshot/model and renders linked child values against global totals", async () => {
  const { root, windowRef } = mountedRoot();
  const calls = [];
  const fetchRef = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return httpResponse(
      body.grouping === "thread" ? THREAD_A_RESPONSE : PROJECT_ROWS_RESPONSE,
    );
  };
  const view = mountWorkUsageView({
    root,
    t: mountedTranslator,
    windowRef,
    fetchRef,
  });
  await settleMountedView();

  const table = findMounted(root, (node) => node.tagName === "TABLE")[0];
  assert.ok(table);
  const header = findMounted(table, (node) => node.tagName === "TH");
  assert.equal(header.length, 6);
  const model = findMounted(
    root,
    (node) =>
      node.tagName === "SELECT" &&
      node.options.some((option) => option.value === "model-mounted"),
  )[0];
  assert.ok(model);
  model.value = "model-mounted";
  model.dispatchEvent({ type: "change" });
  await settleMountedView();

  const projectButton = findMounted(
    root,
    (node) =>
      node.classList.contains("work-usage-project-toggle") &&
      node.textContent.includes("Project A"),
  )[0];
  assert.ok(projectButton);
  projectButton.click();
  await settleMountedView();

  assert.equal(calls.length, 3);
  assert.equal(calls[2].snapshotId, PROJECT_ROWS_RESPONSE.snapshotId);
  assert.equal(calls[2].model, "model-mounted");
  assert.equal(calls[2].grouping, "thread");
  assert.equal(calls[2].project, "project-a");

  const childGroup = findMounted(root, (node) =>
    node.classList.contains("work-usage-children"),
  )[0];
  assert.ok(childGroup);
  assert.strictEqual(
    findMounted(root, (node) => node.tagName === "TABLE").length,
    1,
  );
  assert.equal(childGroup.parentNode?.tagName, "TABLE");
  const childRows = findMounted(childGroup, (node) =>
    node.classList.contains("work-usage-thread-row"),
  );
  assert.equal(childRows.length, 2);
  assert.deepEqual(
    childRows.map((row) => row.children.length),
    [6, 6],
  );
  const links = findMounted(childGroup, (node) =>
    node.classList.contains("cache-drop-thread-link"),
  );
  assert.deepEqual(
    links.map((link) => [link.textContent, link.href]),
    [
      ["Thread A", "codex://threads/11111111-1111-4111-8111-111111111111"],
      ["Thread B", "codex://threads/22222222-2222-4222-8222-222222222222"],
    ],
  );
  assert.deepEqual(
    childRows.map((row) => [
      row.children[1].textContent,
      row.children[2].textContent,
      row.children[3].textContent,
      row.children[4].textContent,
      row.children[5].textContent,
    ]),
    [
      [
        "1",
        "25",
        formatSharePercent(25, 100),
        formatApiMoney("2.50"),
        formatSharePercent(2.5, 10),
      ],
      [
        "1",
        "35",
        formatSharePercent(35, 100),
        formatApiMoney("3.50"),
        formatSharePercent(3.5, 10),
      ],
    ],
  );
  assert.equal(
    findMounted(
      root,
      (node) =>
        node.classList.contains("work-usage-project-toggle") &&
        node.textContent.includes("Project A"),
    )[0].getAttribute("aria-expanded"),
    "true",
  );
  view.destroy();
});

test("mounted project expansion keeps one group open, ignores stale children, and collapses cleanly", async () => {
  const { root, windowRef } = mountedRoot();
  const calls = [];
  const pendingA = deferred();
  const pendingB = deferred();
  const fetchRef = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) return httpResponse(PROJECT_ROWS_RESPONSE);
    if (body.project === "project-a") return pendingA.promise;
    if (body.project === "project-b") return pendingB.promise;
    throw new Error(`unexpected mounted request: ${body.project}`);
  };
  const view = mountWorkUsageView({
    root,
    t: mountedTranslator,
    windowRef,
    fetchRef,
  });
  await settleMountedView();

  const projectButton = (name) =>
    findMounted(
      root,
      (node) =>
        node.classList.contains("work-usage-project-toggle") &&
        node.textContent.includes(name),
    )[0];
  projectButton("Project A").click();
  projectButton("Project B").click();
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(1).map((request) => request.project),
    ["project-a", "project-b"],
  );
  assert.equal(
    findMounted(root, (node) => node.classList.contains("work-usage-children"))
      .length,
    1,
  );

  pendingB.resolve(httpResponse(THREAD_B_RESPONSE));
  await settleMountedView();
  const childGroup = findMounted(root, (node) =>
    node.classList.contains("work-usage-children"),
  )[0];
  assert.equal(
    findMounted(childGroup, (node) =>
      node.classList.contains("work-usage-thread-row"),
    ).length,
    1,
  );
  assert.equal(
    findMounted(childGroup, (node) =>
      node.classList.contains("cache-drop-thread-link"),
    )[0].textContent,
    "Thread B",
  );

  pendingA.resolve(httpResponse(THREAD_A_RESPONSE));
  await settleMountedView();
  assert.equal(
    findMounted(root, (node) => node.classList.contains("work-usage-children"))
      .length,
    1,
  );
  assert.equal(
    findMounted(
      root,
      (node) =>
        node.classList.contains("cache-drop-thread-link") &&
        node.textContent === "Thread A",
    ).length,
    0,
  );

  projectButton("Project B").click();
  assert.equal(
    findMounted(root, (node) => node.classList.contains("work-usage-children"))
      .length,
    0,
  );
  assert.equal(
    projectButton("Project B").getAttribute("aria-expanded"),
    "false",
  );
  view.destroy();
});

test("nested workers reuse parent and bracketed subworker links without a further drill-down", async () => {
  const children = structuredClone(THREAD_A_RESPONSE);
  children.display["thread-a"].thread = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Worker task",
    nickname: "Luna",
    parent: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Parent project task",
    },
  };
  const { root, windowRef } = mountedRoot();
  const view = mountWorkUsageView({
    root,
    windowRef,
    t: mountedTranslator,
    fetchRef: async (_url, init) =>
      httpResponse(
        JSON.parse(init.body).grouping === "thread"
          ? children
          : PROJECT_ROWS_RESPONSE,
      ),
  });
  await settleMountedView();
  findMounted(root, (n) =>
    n.classList.contains("work-usage-project-toggle"),
  )[0].click();
  await settleMountedView();
  const rows = findMounted(root, (n) =>
    n.classList.contains("work-usage-thread-row"),
  );
  const links = findMounted(rows[0], (n) => n.tagName === "A");
  assert.deepEqual(
    links.map((n) => [n.textContent, n.href]),
    [
      [
        "Parent project task",
        "codex://threads/33333333-3333-4333-8333-333333333333",
      ],
      [
        "Luna subworker",
        "codex://threads/11111111-1111-4111-8111-111111111111",
      ],
    ],
  );
  assert.equal(
    rows[0].children[0].textContent,
    "Parent project task [Luna subworker]",
  );
  assert.equal(findMounted(rows[0], (n) => n.tagName === "BUTTON").length, 0);
  assert.equal(findMounted(rows[1], (n) => n.tagName === "BUTTON").length, 0);
  assert.equal(rows[0].children.length, 6);
  view.destroy();
});

test("thread ancestry rejects invalid, mismatched and self-linked identities", () => {
  const valid = structuredClone(THREAD_A_RESPONSE);
  valid.display["thread-a"].thread = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Task",
    nickname: "Luna",
    parent: { id: "33333333-3333-4333-8333-333333333333", name: "Parent" },
  };
  assert.equal(validateWorkUsageResponse(valid), valid);
  for (const mutate of [
    (t) => {
      t.parent.id = "https://example.test";
    },
    (t) => {
      t.parent.id = t.id;
    },
    (t) => {
      t.id = "44444444-4444-4444-8444-444444444444";
    },
    (t) => {
      t.nickname = "x".repeat(81);
    },
    (t) => {
      t.parent.name = "bad\nname";
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid.display["thread-a"].thread);
    assertInvalid(invalid, "untrusted ancestry must not become a link");
  }
});

test("threads expand model components inline without fetching or changing totals and collapse on project changes", async () => {
  const children=structuredClone(THREAD_A_RESPONSE);
  const model=mountedRow({id:'gpt-5',kind:'model',tokens:25,cost:'2.50',events:1,share:1});
  model.components=completeComponents({input_uncached_tokens:10,input_cache_read_tokens:8,input_cache_write_tokens:2,output_text_tokens:null,output_reasoning_tokens:null,output_combined_tokens:5});
  // This fixture deliberately uses combined output: no invented split.
  model.components.output_text_tokens=null; model.components.output_reasoning_tokens=null;
  children.rows[0].modelBreakdown=[model];
  const {root,windowRef}=mountedRoot();let calls=0;
  const view=mountWorkUsageView({root,windowRef,t:mountedTranslator,fetchRef:async(_url,init)=>{calls++;return httpResponse(JSON.parse(init.body).grouping==='thread'?children:PROJECT_ROWS_RESPONSE);}});
  await settleMountedView();
  findMounted(root,n=>n.classList.contains('work-usage-project-toggle'))[0].click();await settleMountedView();
  const before=calls;
  const toggle=findMounted(root,n=>n.classList.contains('work-usage-model-toggle'))[0];
  toggle.click();
  assert.equal(calls,before,'model expansion uses the same immutable response');
  const detail=findMounted(root,n=>n.classList.contains('work-usage-model-detail'))[0];
  assert.ok(detail);
  assert.match(detail.textContent,/Cache write/u);
  assert.match(detail.textContent,/Combined output/u);
  const data=findMounted(detail,n=>n.tagName==='TBODY')[0].children[0];
  assert.deepEqual(data.children.slice(1,-1).map(n=>n.textContent),['8','10','2','—','—','5']);
  assert.equal(data.children.at(-1).textContent,formatApiMoney('2.50'));
  const thread=findMounted(root,n=>n.classList.contains('work-usage-thread-row'))[0];
  assert.equal(thread.children[2].textContent,'25');
  assert.equal(findMounted(thread,n=>n.tagName==='A')[0].href,children.display['thread-a'].codexUrl);
  findMounted(root,n=>n.classList.contains('work-usage-model-toggle'))[0].click();
  assert.equal(findMounted(root,n=>n.classList.contains('work-usage-model-detail')).length,0);
  findMounted(root,n=>n.classList.contains('work-usage-model-toggle'))[0].click();
  findMounted(root,n=>n.classList.contains('work-usage-project-toggle')&&!n.classList.contains('work-usage-model-toggle'))[0].click();
  assert.equal(findMounted(root,n=>n.classList.contains('work-usage-model-detail')).length,0);
  view.destroy();
});

test("a grouped family displays included workers and a conserved contributor breakdown inline", async () => {
  const children=structuredClone(THREAD_A_RESPONSE);
  children.rows=[children.rows[0]];children.rowCount=1;
  const row=children.rows[0];row.subworkerCount=3;
  row.modelBreakdown=[mountedRow({id:'gpt-5',kind:'model',tokens:25,cost:'2.50',events:4,share:1})];
  row.contributions=[
    mountedRow({id:'primary',kind:'contribution',tokens:10,cost:'1.00',events:1,share:.4}),
    mountedRow({id:'subworkers',kind:'contribution',tokens:15,cost:'1.50',events:3,share:.6}),
  ];
  const {root,windowRef}=mountedRoot();
  const view=mountWorkUsageView({root,windowRef,t:mountedTranslator,fetchRef:async(_url,init)=>httpResponse(JSON.parse(init.body).grouping==='thread'?children:PROJECT_ROWS_RESPONSE)});
  await settleMountedView();findMounted(root,n=>n.classList.contains('work-usage-project-toggle'))[0].click();await settleMountedView();
  assert.equal(findMounted(root,n=>n.classList.contains('work-usage-thread-row')).length,1);
  assert.equal(findMounted(root,n=>n.classList.contains('work-usage-family-count'))[0].textContent,'Includes 3 subworkers');
  findMounted(root,n=>n.classList.contains('work-usage-model-toggle'))[0].click();
  const parts=findMounted(root,n=>n.classList.contains('work-usage-contributions'))[0];
  const data=findMounted(parts,n=>n.tagName==='TBODY')[0].children;
  assert.deepEqual(data.map(n=>n.children.map(c=>c.textContent)),[['Primary thread','10',formatApiMoney('1')],['Subworkers','15',formatApiMoney('1.5')]]);
  view.destroy();
});


test("mounted auto review rows link only the parent or remain non-linkable", async () => {
  const { root, windowRef } = mountedRoot();
  const response = structuredClone(THREAD_A_RESPONSE);
  const parentId = "33333333-3333-4333-8333-333333333333";
  for (const [index, decoration] of Object.values(response.display).entries()) {
    decoration.thread = {
      id: decoration.codexUrl.split("/").at(-1),
      name: "Internal review session",
      nickname: null,
      origin: "auto_review",
      parent: index === 0 ? { id: parentId, name: "Synthetic parent" } : null,
    };
  }
  const view = mountWorkUsageView({
    root, t: mountedTranslator, windowRef,
    fetchRef: async (_url, init) => httpResponse(
      JSON.parse(init.body).grouping === "thread" ? response : PROJECT_ROWS_RESPONSE,
    ),
  });
  await settleMountedView();
  findMounted(root, node => node.classList.contains("work-usage-project-toggle"))[0].click();
  await settleMountedView();
  const rows = findMounted(root, node => node.classList.contains("work-usage-thread-row"));
  assert.equal(rows.length, 2);
  const links = findMounted(rows[0], node => node.classList.contains("cache-drop-thread-link"));
  assert.deepEqual(links.map(link => [link.textContent, link.href]), [
    ["Synthetic parent", `codex://threads/${parentId}`],
  ]);
  assert.match(rows[0].textContent, /Synthetic parent \[Auto review\]/u);
  assert.equal(findMounted(rows[1], node => node.tagName === "A").length, 0);
  assert.match(rows[1].textContent, /Auto review: Thread unavailable/u);
  assert.equal(rows.some(row => row.textContent.includes("Internal review session")), false);
  view.destroy();
});

test("period switches reuse the available report anchor, polling drops it, and refresh starts fresh", async () => {
  const { root, windowRef } = mountedRoot();
  const calls = [];
  const view = mountWorkUsageView({ root, windowRef, t: mountedTranslator,
    fetchRef: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (calls.length === 2) return httpResponse({ schemaVersion: WORK_USAGE_SCHEMA, status: "preparing", snapshotId: "related-report" });
      return httpResponse({ ...PROJECT_ROWS_RESPONSE, snapshotId: calls.length > 1 ? "related-report" : PROJECT_ROWS_RESPONSE.snapshotId });
    },
  });
  try {
    await settleMountedView();
    findMounted(root, node => node.dataset?.period === "all")[0].click();
    await settleMountedView();
    assert.equal(calls[1].sourceSnapshotId, PROJECT_ROWS_RESPONSE.snapshotId);
    assert.equal(calls[1].snapshotId, undefined);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(calls[2].snapshotId, "related-report");
    assert.equal(calls[2].sourceSnapshotId, undefined);
    view.refresh();
    await settleMountedView();
    assert.equal(calls.at(-1).snapshotId, undefined);
    assert.equal(calls.at(-1).sourceSnapshotId, undefined);
  } finally { view.destroy(); }
});


test("assumptions stay distinct from missing data and the non-project bucket is localized", async () => {
  const response = structuredClone(PROJECT_ROWS_RESPONSE);
  response.rows[0].id = "non-project";
  response.rows[0].assumedEvents = 1;
  response.totals.assumedEvents = 1;
  response.totals.incompleteEvents = 1;
  assert.equal(validateWorkUsageResponse(response), response);
  const malformed = structuredClone(response);
  malformed.rows[0].assumedEvents = -1;
  assertInvalid(malformed, "negative assumption count");
  const { root, windowRef } = mountedRoot();
  const view = mountWorkUsageView({ root, windowRef, t: mountedTranslator,
    fetchRef: async () => httpResponse(response) });
  await settleMountedView();
  assert.match(root.textContent, /Non-project tasks/);
  assert.match(root.textContent, /Includes assumed counts/);
  assert.match(root.textContent, /Missing cache-write counts are assumed to be 0 for 1 usage records/);
  assert.match(root.textContent, /Token counts are missing or incomplete for 1 usage records/);
  view.destroy();
});
