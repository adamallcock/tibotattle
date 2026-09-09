import {
  formatNumber,
  formatLocal,
  formatModelName,
  formatCodexThreadParts,
  formatApiMoney,
  formatSharePercent,
} from "./ui-format.js";
const SCHEMA = "local-work-usage-v1";
const COMPONENTS = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];
const COMPONENT_LABELS = [
  "uncached",
  "cacheRead",
  "cacheWrite",
  "outputText",
  "reasoning",
  "combined",
];
const safeNumber = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const timestamp = (v) => count(v) && v <= 8_640_000_000_000_000;
const shortText = (v, maximum = 200) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const codexThreadId = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
const nullableName = (value, maximum = 512) =>
  value === null || shortText(value, maximum);
function validThreadDecoration(thread, url) {
  return (
    thread &&
    typeof thread === "object" &&
    !Array.isArray(thread) &&
    codexThreadId(thread.id) &&
    url?.toLowerCase() === `codex://threads/${thread.id.toLowerCase()}` &&
    nullableName(thread.name) &&
    nullableName(thread.nickname, 80) &&
    (thread.parent === null ||
      (thread.parent &&
        typeof thread.parent === "object" &&
        !Array.isArray(thread.parent) &&
        codexThreadId(thread.parent.id) &&
        thread.parent.id.toLowerCase() !== thread.id.toLowerCase() &&
        nullableName(thread.parent.name)))
  );
}
export function validateWorkUsageResponse(value) {
  if (
    !value ||
    value.schemaVersion !== SCHEMA ||
    !["available", "preparing", "missing", "unavailable", "cancelled"].includes(
      value.status,
    )
  )
    throw new Error("invalid_response");
  if (value.status === "cancelled") return value;
  if (!shortText(value.snapshotId)) throw new Error("invalid_response");
  if (value.status !== "available") return value;
  if (
    !timestamp(value.fromMs) ||
    !timestamp(value.toMs) ||
    value.toMs < value.fromMs ||
    !value.metadata ||
    !timestamp(value.metadata.observedAt) ||
    !count(value.offset) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 100 ||
    !value.totals ||
    !safeNumber(value.totals.tokens) ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 0 ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.scopes) ||
    value.models.length > 1000 ||
    value.scopes.length > 1000 ||
    !value.display ||
    typeof value.display !== "object" ||
    Array.isArray(value.display) ||
    !value.models.every((id) => shortText(id)) ||
    !value.scopes.every(
      (scope) => scope && shortText(scope.id) && shortText(scope.status),
    ) ||
    (value.nextCursor !== null && !shortText(value.nextCursor)) ||
    !count(value.totals.activeThreads) ||
    !count(value.totals.activeProjects)
  )
    throw new Error("invalid_response");
  for (const row of value.rows) {
    if (row.subworkerCount !== undefined && !count(row.subworkerCount)) throw new Error("invalid_response");
    if (row.contributions !== undefined && (!Array.isArray(row.contributions) || row.contributions.length > 2
      || row.contributions.some(part => part?.kind !== "contribution" || !["primary", "subworkers"].includes(part.id)))) throw new Error("invalid_response");
    if (row.modelBreakdown !== undefined && (row.kind !== "thread" || !Array.isArray(row.modelBreakdown)
        || row.modelBreakdown.length > 50_000 || row.modelBreakdown.some(model => model?.kind !== "model"))) throw new Error("invalid_response");
  }
  for (const row of [value.totals, ...value.rows, ...value.rows.flatMap(row => [...(row.modelBreakdown ?? []), ...(row.contributions ?? [])])]) {
    if (
      !row ||
      !safeNumber(row.tokens) ||
      !shortText(row.id) ||
      !["total", "project", "worktree", "thread", "model", "contribution"].includes(row.kind) ||
      (row.lastAt !== null && !timestamp(row.lastAt)) ||
      !count(row.incompleteEvents) ||
      !count(row.events) ||
      !["complete", "partial", "unpriced"].includes(row.priceStatus) ||
      (row.share !== null &&
        (typeof row.share !== "number" ||
          !Number.isFinite(row.share) ||
          row.share < 0 ||
          row.share > 1)) ||
      !row.components ||
      !COMPONENTS.every((key) => safeNumber(row.components[key])) ||
      (row.costUsdExact !== null &&
        (typeof row.costUsdExact !== "string" ||
          !/^\d+(?:\.\d+)?$/u.test(row.costUsdExact) ||
          row.costUsdExact.length > 100))
    )
      throw new Error("invalid_response");
  }
  for (const decoration of Object.values(value.display)) {
    if (
      !decoration ||
      typeof decoration !== "object" ||
      Array.isArray(decoration) ||
      (decoration.name != null && !shortText(decoration.name, 1000)) ||
      (decoration.thread != null &&
        !validThreadDecoration(decoration.thread, decoration.codexUrl)) ||
      (decoration.shortId != null && !shortText(decoration.shortId)) ||
      (decoration.codexUrl != null &&
        !/^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          decoration.codexUrl,
        ))
    )
      throw new Error("invalid_response");
  }
  return value;
}
export function mountWorkUsageView({
  root,
  t,
  windowRef = window,
  fetchRef = (input, init) => windowRef.fetch(input, init),
}) {
  const documentRef = root.ownerDocument;
  const tr = (key, values) => t(`workUsage.${key}`, values);
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let query = {
    schemaVersion: SCHEMA,
    period: "7d",
    grouping: "project",
    sort: "tokens",
    pageSize: 25,
  };
  let response = null;
  let serial = 0;
  let controller = null;
  let timer = null;
  let started = false;
  let ancestors = [];
  let pages = [];
  let selectedTitle = null;
  let pendingFocus = null;
  let nested = null;
  let expandedThread = null;
  let nextNestedId = 0;
  let statusKey = "preparing";
  let statusValues;
  const setStatus = (key, values) => {
    statusKey = key;
    statusValues = values;
    message.textContent = tr(key, values);
  };
  const button = (label, action, className = "button button-secondary") => {
    const b = el("button", className, label);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const heading = el("div", "work-usage-heading");
  const headingText = el("div");
  const title = el("h2", null, tr("title"));
  title.id = "work-usage-title";
  headingText.append(title, el("p", "section-description", tr("subtitle")));
  const period = el("div", "work-usage-period");
  period.setAttribute("role", "group");
  period.setAttribute("aria-label", tr("period"));
  for (const id of ["24h", "7d", "30d", "all"]) {
    const b = button(id === "all" ? tr("all") : id, () => {
      query = { ...query, period: id };
      delete query.scope;
      refresh(response?.snapshotId);
    });
    b.dataset.period = id;
    period.append(b);
  }
  heading.append(headingText, period);
  const toolbar = el("div", "work-usage-toolbar");
  const views = el("div", "work-usage-period");
  for (const id of ["project", "thread"]) {
    const viewButton = button(
      tr(id === "project" ? "projects" : "threads"),
      () => {
        ancestors = [];
        selectedTitle = null;
        input.value = "";
        delete query.project;
        delete query.worktree;
        delete query.thread;
        delete query.findThread;
        query.grouping = id;
        resetPage();
        load();
      },
    );
    viewButton.dataset.grouping = id;
    views.append(viewButton);
  }
  const select = (label, options, change) => {
    const wrapper = el("label", "work-usage-select");
    wrapper.append(el("span", null, label));
    const control = el("select");
    for (const [value, text] of options) {
      const o = el("option", null, text);
      o.value = value;
      control.append(o);
    }
    control.addEventListener("change", () => change(control.value));
    wrapper.append(control);
    return { wrapper, control };
  };
  const sort = select(
    tr("measure"),
    [
      ["tokens", tr("tokens")],
      ["cost", tr("cost")],
      ["recent", tr("recent")],
    ],
    (value) => {
      query.sort = value;
      resetPage();
      load();
    },
  );
  const model = select(tr("model"), [["", tr("allModels")]], (value) => {
    if (value) query.model = value;
    else delete query.model;
    resetPage();
    load();
  });
  const scope = select(tr("scope"), [], (value) => {
    query.scope = value;
    refresh(response?.snapshotId);
  });
  scope.wrapper.hidden = true;
  const refreshButton = button(tr("refresh"), refresh);
  toolbar.append(
    views,
    sort.wrapper,
    model.wrapper,
    scope.wrapper,
    refreshButton,
  );
  const form = el("form", "work-usage-find");
  const input = el("input");
  input.type = "text";
  input.maxLength = 100;
  input.placeholder = tr("findHint");
  input.setAttribute("aria-label", tr("findHint"));
  const find = button(tr("find"), () => {});
  find.type = "submit";
  form.append(input, find);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (
      !/^(?:codex:\/\/threads\/)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )
    ) {
      setStatus("invalid");
      return;
    }
    ancestors = [];
    selectedTitle = null;
    delete query.project;
    delete query.worktree;
    delete query.thread;
    query.findThread = value;
    query.grouping = "thread";
    resetPage();
    load();
  });
  const message = el("p", "work-usage-status");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const cancel = button(tr("cancel"), async () => {
    serial++;
    clearNested();
    controller?.abort();
    clearTimeout(timer);
    if (query.snapshotId) {
      try {
        await fetchRef("/api/local/work-usage/query", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-usage-monitor-local": "1",
          },
          body: JSON.stringify({
            schemaVersion: SCHEMA,
            action: "cancel",
            snapshotId: query.snapshotId,
          }),
        });
      } catch {}
    }
    delete query.snapshotId;
    cancel.hidden = true;
    root.removeAttribute("aria-busy");
    body.inert = false;
    setStatus("cancelled");
  });
  cancel.hidden = true;
  const body = el("div");
  const footnote = el("div", "work-usage-notes");
  footnote.append(
    el("p", null, tr("mapping")),
    el("p", null, tr("transient")),
    el("p", null, tr("priceNote")),
  );
  const eyebrow = el("p", "eyebrow", tr("local"));
  root.replaceChildren(
    heading,
    eyebrow,
    toolbar,
    form,
    message,
    cancel,
    body,
    footnote,
  );
  function resetPage() {
    delete query.cursor;
    pages = [];
  }
  function refresh(sourceSnapshotId = null) {
    delete query.snapshotId;
    delete query.sourceSnapshotId;
    if (typeof sourceSnapshotId === "string") query.sourceSnapshotId = sourceSnapshotId;
    resetPage();
    load();
  }
  function descend(row, grouping = null) {
    ancestors.push({
      query: { ...query },
      pages: [...pages],
      title: selectedTitle,
      rowId: row.id,
    });
    selectedTitle = label(row);
    pendingFocus = "heading";
    resetPage();
    if (row.kind === "project") {
      query.project = row.id;
      query.grouping = "thread";
    } else if (row.kind === "worktree") {
      query.worktree = row.id;
      query.grouping = "thread";
    } else query.thread = row.id;
    if (grouping) query.grouping = grouping;
    load();
  }
  function label(row, report = response) {
    const display = report?.display[row.id];
    return row.id === "unassigned"
      ? tr("unassigned")
      : (display?.name ??
          `${tr(row.kind === "project" ? "projects" : row.kind === "worktree" ? "worktrees" : "threads")} · ${display?.shortId ?? row.id.slice(-10)}`);
  }
  const quantity = (n) => (n === null ? "—" : formatNumber(n));
  const quietButton = (text, action) =>
    button(text, action, "button button-quiet compact");
  function clearNested() {
    expandedThread = null;
    nested?.controller?.abort();
    nested = null;
  }
  function toggleProject(row) {
    if (nested?.project === row.id) clearNested();
    else {
      clearNested();
      nested = {
        project: row.id,
        regionId: `${root.id || "work-usage"}-children-${++nextNestedId}`,
        pages: [],
        cursor: null,
        status: "preparing",
      };
      loadNested(nested);
    }
    pendingFocus = row.id;
    render();
  }
  async function loadNested(entry) {
    expandedThread = null;
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    entry.status = "preparing";
    const token = serial;
    const childQuery = { ...query, grouping: "thread", project: entry.project };
    delete childQuery.cursor;
    if (entry.cursor) childQuery.cursor = entry.cursor;
    try {
      const http = await fetchRef("/api/local/work-usage/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-usage-monitor-local": "1",
        },
        cache: "no-store",
        body: JSON.stringify(childQuery),
        signal: controller.signal,
      });
      if (!http.ok)
        throw new Error(http.status === 409 ? "expired" : "unavailable");
      const result = validateWorkUsageResponse(await http.json());
      if (
        result.status !== "available" ||
        result.snapshotId !== response.snapshotId ||
        result.scope !== response.scope ||
        result.fromMs !== response.fromMs ||
        result.toMs !== response.toMs
      )
        throw new Error("unavailable");
      if (token !== serial || nested !== entry || controller.signal.aborted)
        return;
      entry.response = result;
      entry.status = "available";
    } catch (error) {
      if (token !== serial || nested !== entry || controller.signal.aborted)
        return;
      entry.status = error.message === "expired" ? "expired" : "unavailable";
    }
    if (nested === entry && token === serial) {
      pendingFocus = documentRef.activeElement?.classList?.contains(
        "work-usage-project-toggle",
      )
        ? entry.focusFirst
          ? entry.response?.rows[0]?.id
          : entry.project
        : null;
      entry.focusFirst = false;
      render();
    }
  }
  function render() {
    body.replaceChildren();
    let focusTarget;
    if (ancestors.length)
      body.append(
        button(`← ${tr("back")}`, () => {
          const previous = ancestors.pop();
          query = previous.query;
          pages = previous.pages;
          selectedTitle = previous.title;
          pendingFocus = previous.rowId;
          load();
        }),
      );
    if (selectedTitle) {
      const detailTitle = el("h3", "work-usage-detail-title", selectedTitle);
      detailTitle.tabIndex = -1;
      body.append(detailTitle);
      if (pendingFocus === "heading") focusTarget = detailTitle;
    }
    const summaries = el("div", "work-usage-summary");
    for (const [label, n] of [
      [tr("tokens"), response.totals.tokens],
      [tr("activeProjects"), response.totals.activeProjects],
      [tr("activeThreads"), response.totals.activeThreads],
    ]) {
      const card = el("div", "work-usage-card");
      card.append(el("span", null, label), el("strong", null, quantity(n)));
      summaries.append(card);
    }
    body.append(summaries);
    if (response.totals.incompleteEvents)
      body.append(
        el(
          "p",
          "notice notice-warning",
          tr("unknownNote", {
            count: quantity(response.totals.incompleteEvents),
          }),
        ),
      );
    body.append(
      el(
        "p",
        "work-usage-caption",
        `${formatLocal(new Date(response.fromMs).toISOString())} — ${formatLocal(new Date(response.toMs).toISOString())}`,
      ),
    );
    if (query.project && !query.thread && !query.worktree)
      body.append(
        button(
          tr(query.grouping === "worktree" ? "threads" : "worktrees"),
          () => {
            query.grouping =
              query.grouping === "worktree" ? "thread" : "worktree";
            pendingFocus = "heading";
            resetPage();
            load();
          },
        ),
      );
    if (query.thread) {
      const details = el("dl", "work-usage-components");
      COMPONENTS.forEach((key, i) => {
        const group = el("div");
        group.append(
          el("dt", null, tr(COMPONENT_LABELS[i])),
          el("dd", null, quantity(response.totals.components[key])),
        );
        details.append(group);
      });
      body.append(el("h3", null, tr("details")), details);
      const link = response.display[query.thread]?.codexUrl;
      if (/^codex:\/\/threads\/[0-9a-f-]{36}$/iu.test(link ?? "")) {
        const a = el("a", "button button-secondary", tr("open"));
        a.href = link;
        a.rel = "noreferrer";
        body.append(a);
      }
    }
    const panel = el("div", "accounting-models-panel work-usage-table-panel");
    const wrap = el("div", "table-wrap");
    const table = el("table", "work-usage-table");
    table.setAttribute("aria-label", tr("title"));
    const head = el("thead");
    const header = el("tr");
    const columns = [
      tr("nameColumn"),
      tr("changes"),
      tr("tokenColumn"),
      tr("tokenShare"),
      tr("cost"),
      tr("valueShare"),
    ];
    columns.forEach((name, index) => {
      const isShare = index === 3 || index === 5;
      const th = el(
        "th",
        isShare ? "model-share-head" : null,
        isShare ? tr("shareColumn") : name,
      );
      if (isShare) th.setAttribute("aria-label", name);
      th.scope = "col";
      if (index === 3 || index === 5) th.title = tr("shareNote");
      header.append(th);
    });
    head.append(header);
    table.append(head);
    let tbody = el("tbody");
    const addRow = (row, report, child = false) => {
      const trNode = el(
        "tr",
        child ? "model-component-row work-usage-thread-row" : null,
      );
      const identity = el(
        "td",
        `model-identity cache-drop-thread-cell${child ? " model-component-identity" : ""}`,
      );
      identity.setAttribute("data-label", columns[0]);
      const display = report.display[row.id];
      const name = label(row, report);
      let control;
      if (row.kind === "project" && !query.project) {
        const open = nested?.project === row.id;
        control = button(
          name,
          () => toggleProject(row),
          "work-usage-project-toggle",
        );
        control.setAttribute("aria-expanded", String(open));
        control.setAttribute(
          "aria-label",
          tr(open ? "collapseProject" : "expandProject", { name }),
        );
        if (open) control.setAttribute("aria-controls", nested.regionId);
        const caret = el("span", "model-disclosure-caret", "›");
        caret.setAttribute("aria-hidden", "true");
        control.prepend(caret);
      } else if (row.kind === "thread" && display?.codexUrl) {
        const parts = formatCodexThreadParts(
          display.thread ?? { id: display.codexUrl.split("/").at(-1), name },
          t,
        );
        const content = el("span", "cache-drop-thread-content");
        for (const part of parts) {
          if (part.href === null) {
            control = el("span", "cache-drop-thread-unavailable",
              `${part.name}: ${t("accounting.cacheDropThread.unavailable")}`);
            content.append(control);
            continue;
          }
          const link = el("a", "cache-drop-thread-link", part.name);
          link.title = part.name;
          link.href = part.href;
          link.rel = "noreferrer";
          link.setAttribute(
            "aria-label",
            tr("openThread", { name: part.name }),
          );
          if (part.worker) {
            const worker = el("span", "cache-drop-subworker");
            worker.append(
              documentRef.createTextNode("["),
              link,
              documentRef.createTextNode("]"),
            );
            if (parts.length > 1)
              content.append(documentRef.createTextNode(" "));
            content.append(worker);
          } else {
            content.append(link);
            if (part.autoReview) {
              content.append(el("span", "cache-drop-subworker", " [Auto review]"));
            }
          }
          control = link;
        }
        identity.append(content);
      } else if (row.kind === "thread") {
        control = el("span", "cache-drop-thread-unavailable", name);
        control.tabIndex = -1;
      } else control = button(name, () => descend(row), "work-usage-row-link");
      if (!identity.contains(control)) identity.append(control);
      const lastActive =
        row.lastAt === null
          ? "—"
          : formatLocal(new Date(row.lastAt).toISOString());
      control.title = `${control.title ? `${control.title}\n` : ""}${tr("recent")}: ${lastActive}`;
      if (display?.shortId) control.title += ` · ${display.shortId}`;
      if (row.kind === "project" && display?.shortId)
        identity.append(el("small", "muted", ` · ${display.shortId}`));
      if (row.subworkerCount > 0) identity.append(el("small", "work-usage-muted work-usage-family-count", tr("subworkersIncluded", {count:quantity(row.subworkerCount)})));
      if (row.kind === "thread" && row.modelBreakdown?.length) {
        const open = expandedThread === row.id;
        const toggle = button("", () => {
          expandedThread = open ? null : row.id;
          pendingFocus = row.id;
          render();
        }, "work-usage-project-toggle work-usage-model-toggle");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", tr(open ? "collapseModels" : "expandModels", { name }));
        if (open) toggle.setAttribute("aria-controls", `${root.id}-model-breakdown`);
        const caret = el("span", "model-disclosure-caret", "›");
        caret.setAttribute("aria-hidden", "true");
        toggle.append(caret);
        identity.prepend(toggle);
        const primary = row.modelBreakdown[0];
        identity.append(el("small", "work-usage-muted work-usage-primary-model",
          tr("primaryModel", { model: formatModelName(primary.id), extra: row.modelBreakdown.length > 1 ? ` +${row.modelBreakdown.length - 1}` : "" })));
        control = toggle;
      }
      if (
        pendingFocus === row.id ||
        (pendingFocus === "first-row" && !focusTarget)
      )
        focusTarget = control;
      const numericCell = (value, index, className = "numeric-cell") => {
        const cell = el("td", className, value);
        cell.setAttribute("data-label", columns[index]);
        return cell;
      };
      const tokens = numericCell(quantity(row.tokens), 2);
      if (row.incompleteEvents)
        tokens.append(el("small", "work-usage-muted", tr("partial")));
      const cost = numericCell(
        formatApiMoney(row.costUsdExact),
        4,
        "numeric-cell model-api-equivalent",
      );
      if (row.priceStatus === "partial")
        cost.append(el("small", "work-usage-muted", tr("partial")));
      const share = (part, whole) => formatSharePercent(part, whole) ?? "—";
      const costNumber =
        row.costUsdExact === null ? null : Number(row.costUsdExact);
      const totalCost =
        response.totals.costUsdExact === null
          ? null
          : Number(response.totals.costUsdExact);
      trNode.append(
        identity,
        numericCell(quantity(row.events), 1),
        tokens,
        numericCell(
          share(row.tokens, response.totals.tokens),
          3,
          "numeric-cell model-share",
        ),
        cost,
        numericCell(
          share(costNumber, totalCost),
          5,
          "numeric-cell model-share",
        ),
      );
      return trNode;
    };
    const appendRow = (group, row, report, child = false) => {
      group.append(addRow(row, report, child));
      if (row.kind !== "thread" || expandedThread !== row.id || !row.modelBreakdown?.length) return;
      const detailRow = el("tr", "work-usage-model-detail");
      const cell = el("td");
      cell.colSpan = 6;
      const region = el("div", "work-usage-model-breakdown");
      region.id = `${root.id}-model-breakdown`;
      const detail = el("table", "work-usage-model-table");
      detail.setAttribute("aria-label", tr("modelBreakdown", { name: label(row, report) }));
      const components = [
        ["input_cache_read_tokens", "cacheRead"],
        ["input_uncached_tokens", "uncached"],
        ["output_text_tokens", "outputText"],
        ["output_reasoning_tokens", "reasoning"],
      ];
      if (row.modelBreakdown.some(model => (model.components.input_cache_write_tokens ?? 0) > 0)) components.splice(2,0,["input_cache_write_tokens", "cacheWrite"]);
      if (row.modelBreakdown.some(model => model.components.output_combined_tokens !== null)) components.push(["output_combined_tokens", "combined"]);
      const headers = [tr("model"), ...components.map(([,key])=>tr(key)), tr("cost")];
      const head = el("thead"); const header = el("tr");
      headers.forEach((name,i) => { const th=el("th", i ? "numeric-cell" : null, name); th.scope="col"; header.append(th); });
      head.append(header); detail.append(head);
      const body = el("tbody");
      for (const model of row.modelBreakdown) {
        const line = el("tr"); line.append(el("td",null,formatModelName(model.id)));
        for (const [key] of components) line.append(el("td","numeric-cell",quantity(model.components[key])));
        const cost = el("td","numeric-cell model-api-equivalent",formatApiMoney(model.costUsdExact));
        if (model.priceStatus === "partial") cost.append(el("small","work-usage-muted",tr("partial")));
        line.append(cost); body.append(line);
      }
      detail.append(body); region.append(detail);
      if (row.subworkerCount > 0) {
        const totals = el("table", "work-usage-contributions");
        totals.setAttribute("aria-label", tr("contributions"));
        const head=el("thead"); const heading=el("tr");
        [tr("contributions"),tr("tokenColumn"),tr("cost")].forEach((text,i)=>{const th=el("th",i ? "numeric-cell" : null,text);th.scope="col";heading.append(th);});head.append(heading);totals.append(head);
        const rows=el("tbody");
        for (const part of row.contributions ?? []) {
          const line=el("tr");const cost=el("td","numeric-cell",formatApiMoney(part.costUsdExact));
          if (part.priceStatus === "partial") cost.append(el("small","work-usage-muted",tr("partial")));
          line.append(el("td",null,tr(part.id === "primary" ? "primaryThread" : "subworkers")),el("td","numeric-cell",quantity(part.tokens)),cost);rows.append(line);
        }
        totals.append(rows); region.prepend(totals);
      }
      region.append(el("p","annotation",tr("modelBreakdownNote")));
      if (row.incompleteEvents) region.append(el("p","annotation",tr("unknownNote", {count:quantity(row.incompleteEvents)})));
      cell.append(region); detailRow.append(cell); group.append(detailRow);
    };
    for (const row of response.rows) {
      appendRow(tbody, row, response);
      if (nested?.project !== row.id) continue;
      const entry = nested;
      const childGroup = el("tbody", "work-usage-children");
      childGroup.id = entry.regionId;
      // Keep all six columns in the parent table; each expansion is its own
      // semantic row group, never a second table with a different column grid.
      table.append(tbody);
      if (entry.status === "available") {
        for (const child of entry.response.rows)
          appendRow(childGroup, child, entry.response, true);
      }
      const controlsRow = el("tr", "model-component-row");
      const controlsCell = el("td", "work-usage-child-controls");
      controlsCell.colSpan = 6;
      if (entry.status !== "available") {
        const status = el("span", "annotation", tr(entry.status));
        status.setAttribute("role", "status");
        controlsCell.append(status);
        if (entry.status === "expired")
          controlsCell.append(quietButton(tr("refresh"), refresh));
        else if (entry.status !== "preparing")
          controlsCell.append(
            quietButton(tr("retry"), () => {
              loadNested(entry);
              pendingFocus = row.id;
              render();
            }),
          );
      } else {
        const page = el("div", "table-pagination");
        const previous = quietButton(tr("previous"), () => {
          entry.cursor = entry.pages.pop() ?? null;
          entry.focusFirst = true;
          loadNested(entry);
          pendingFocus = row.id;
          render();
        });
        previous.disabled = !entry.pages.length;
        const next = quietButton(tr("next"), () => {
          entry.pages.push(entry.cursor);
          entry.cursor = entry.response.nextCursor;
          entry.focusFirst = true;
          loadNested(entry);
          pendingFocus = row.id;
          render();
        });
        next.disabled = !entry.response.nextCursor;
        for (const button of [previous, next])
          button.setAttribute("aria-controls", entry.regionId);
        page.append(
          previous,
          el(
            "span",
            "table-pagination-status",
            tr("rows", {
              from: entry.response.rowCount ? entry.response.offset + 1 : 0,
              to: Math.min(
                entry.response.offset + query.pageSize,
                entry.response.rowCount,
              ),
              total: entry.response.rowCount,
            }),
          ),
          next,
        );
        controlsCell.append(page);
      }
      controlsCell.append(
        quietButton(tr("worktrees"), () => descend(row, "worktree")),
      );
      controlsRow.append(controlsCell);
      childGroup.append(controlsRow);
      table.append(childGroup);
      tbody = el("tbody");
    }
    // Parent rows following the expansion need a fresh row group so their
    // visual order stays project -> children -> next project.
    if (!tbody.parentNode) table.append(tbody);
    wrap.append(table);
    panel.append(wrap);
    body.append(panel);
    body.append(el("p", "annotation", tr("shareNote")));
    if (!response.rowCount)
      body.append(el("p", "work-usage-empty", tr("empty")));
    const pagination = el("div", "table-pagination");
    const previous = quietButton(tr("previous"), () => {
      pendingFocus = "first-row";
      const cursor = pages.pop();
      if (cursor) query.cursor = cursor;
      else delete query.cursor;
      load();
    });
    previous.disabled = !pages.length;
    const next = quietButton(tr("next"), () => {
      pendingFocus = "first-row";
      pages.push(query.cursor ?? null);
      query.cursor = response.nextCursor;
      load();
    });
    next.disabled = !response.nextCursor;
    pagination.append(
      previous,
      el(
        "span",
        "table-pagination-status",
        tr("rows", {
          from: response.rowCount ? response.offset + 1 : 0,
          to: Math.min(response.offset + query.pageSize, response.rowCount),
          total: response.rowCount,
        }),
      ),
      next,
    );
    body.append(pagination);
    body.append(
      el(
        "p",
        "work-usage-caption",
        tr("observed", {
          date: formatLocal(
            new Date(response.metadata.observedAt).toISOString(),
          ),
        }),
      ),
    );
    focusTarget?.focus();
    pendingFocus = null;
  }
  async function load() {
    started = true;
    clearNested();
    const token = ++serial;
    controller?.abort();
    clearTimeout(timer);
    controller = new AbortController();
    setStatus("preparing");
    body.inert = true;
    body.hidden = true;
    cancel.hidden = false;
    root.setAttribute("aria-busy", "true");
    for (const b of views.children)
      b.setAttribute(
        "aria-pressed",
        String(
          b.dataset.grouping === (query.project ? "project" : query.grouping),
        ),
      );
    for (const b of period.children)
      b.setAttribute("aria-pressed", String(b.dataset.period === query.period));
    sort.control.value = query.sort;
    try {
      const http = await fetchRef("/api/local/work-usage/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-usage-monitor-local": "1",
        },
        cache: "no-store",
        body: JSON.stringify(query),
        signal: controller.signal,
      });
      if (!http.ok)
        throw new Error(http.status === 409 ? "expired" : "unavailable");
      const result = validateWorkUsageResponse(await http.json());
      if (token !== serial) return;
      query.snapshotId = result.snapshotId;
      delete query.sourceSnapshotId;
      if (result.status === "preparing") {
        timer = setTimeout(load, 750);
        return;
      }
      if (result.status !== "available") {
        setStatus(result.status === "missing" ? "missing" : "unavailable");
        return;
      }
      response = result;
      setStatus("snapshot", {
        date: formatLocal(new Date(result.toMs).toISOString()),
      });
      model.control.replaceChildren(
        ...[
          ["", tr("allModels")],
          ...result.models.map((id) => [id, formatModelName(id)]),
        ].map(([value, text]) => {
          const option = el("option", null, text);
          option.value = value;
          return option;
        }),
      );
      model.control.value = query.model ?? "";
      scope.control.replaceChildren(
        ...result.scopes.map((s, i) => {
          const option = el(
            "option",
            null,
            s.status === "unavailable"
              ? tr("unknownScope")
              : tr("account", { number: i + 1 }),
          );
          option.value = s.id;
          return option;
        }),
      );
      scope.control.value = result.scope;
      scope.wrapper.hidden = result.scopes.length < 2;
      body.hidden = false;
      body.inert = false;
      render();
    } catch (error) {
      if (token !== serial || error.name === "AbortError") return;
      setStatus(error.message === "expired" ? "expired" : "unavailable");
    } finally {
      if (token === serial) {
        cancel.hidden =
          timer !== null && message.textContent === tr("preparing")
            ? false
            : true;
        if (cancel.hidden) root.removeAttribute("aria-busy");
      }
    }
  }
  const observer = new windowRef.MutationObserver(() => {
    if (!root.inert && !started) load();
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["aria-hidden"],
  });
  if (!root.inert) load();
  function relocalize() {
    eyebrow.textContent = tr("local");
    title.textContent = tr("title");
    headingText.lastChild.textContent = tr("subtitle");
    period.setAttribute("aria-label", tr("period"));
    period.lastChild.textContent = tr("all");
    for (const b of views.children)
      b.textContent = tr(
        b.dataset.grouping === "project" ? "projects" : "threads",
      );
    sort.wrapper.firstChild.textContent = tr("measure");
    [...sort.control.options].forEach((o) => {
      o.textContent = tr(o.value);
    });
    model.wrapper.firstChild.textContent = tr("model");
    scope.wrapper.firstChild.textContent = tr("scope");
    if (model.control.options[0])
      model.control.options[0].textContent = tr("allModels");
    [...scope.control.options].forEach((option, i) => {
      option.textContent =
        response?.scopes[i]?.status === "unavailable"
          ? tr("unknownScope")
          : tr("account", { number: i + 1 });
    });
    refreshButton.textContent = tr("refresh");
    input.placeholder = tr("findHint");
    input.setAttribute("aria-label", tr("findHint"));
    find.textContent = tr("find");
    cancel.textContent = tr("cancel");
    footnote.replaceChildren(
      ...["mapping", "transient", "priceNote"].map((key) =>
        el("p", null, tr(key)),
      ),
    );
    if (statusKey === "snapshot" && response)
      statusValues = {
        date: formatLocal(new Date(response.toMs).toISOString()),
      };
    setStatus(statusKey, statusValues);
    if (response && !body.hidden) render();
  }
  windowRef.addEventListener("tibotattle:locale-change", relocalize);
  return {
    refresh,
    destroy() {
      serial++;
      clearNested();
      controller?.abort();
      clearTimeout(timer);
      observer.disconnect();
      windowRef.removeEventListener("tibotattle:locale-change", relocalize);
    },
  };
}
