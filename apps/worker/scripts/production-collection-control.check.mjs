import assert from "node:assert/strict";
import {
  chmod,
  link as createHardLink,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openOperation, readOperation } from "../../../scripts/lib/release-operation.mjs";
import {
  COLLECTION_CONTROL_QUERY,
  PRODUCTION_COLLECTION_CONFIRMATION,
  PRODUCTION_COLLECTION_ADMIN_ORIGIN,
  PRODUCTION_RESTORE_CONFIRMATION,
  TELEMETRY_V12_RUNTIME_QUERY,
  parseProductionCollectionControlArguments,
  readProductionCollectionAdminSession,
  readProductionCollectionSuccessorArtifact,
  runProductionCollectionControl,
  validateProductionCollectionAdminSession,
} from "./production-collection-control.mjs";

const ACCOUNT = "a".repeat(32);
const SOURCE = "b".repeat(40);
const VERSION = "11111111-1111-4111-8111-111111111111";
const DATABASE = "22222222-2222-4222-8222-222222222222";
const SESSION = {
  schema: "production-collection-control-admin-session-v1",
  origin: PRODUCTION_COLLECTION_ADMIN_ORIGIN,
  cookie: "CF_Authorization=synthetic-owner-session",
  accessJwt: null,
  csrfToken: null,
};

const runtime = {
  migration_tag: "upload-ingress-budget-v1",
  assets: {
    not_found_handling: "404-page",
    raw_run_worker_first: true,
    serve_directly: false,
  },
  compatibility_date: "2026-07-26",
  compatibility_flags: ["nodejs_compat"],
  usage_model: "standard",
  limits: { cpu_ms: 300000 },
  cache_options: { enabled: true, cross_version_cache: false },
};
const bindings = [
  { name: "USAGE_MONITOR_DB", type: "d1", id: DATABASE, database_id: DATABASE },
  { name: "ASSETS", type: "assets" },
  { name: "PUBLIC_ORIGIN", type: "plain_text", text: "https://synthetic.example" },
  { name: "DEPLOYMENT_SOURCE_COMMIT", type: "plain_text", text: SOURCE },
];
const inventory = {
  capturedAt: "2026-09-22T20:00:00.000Z",
  accountId: ACCOUNT,
  workerName: "synthetic-worker",
  version: {
    id: VERSION,
    resources: { script_runtime: runtime, bindings },
  },
  settings: {
    placement: {},
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags,
    usage_model: runtime.usage_model,
    tags: [],
    tail_consumers: [],
    logpush: false,
    limits: runtime.limits,
    observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true },
    annotations: {},
    cache_options: runtime.cache_options,
    bindings,
  },
  schedules: { schedules: [] },
  subdomain: { enabled: false, previews_enabled: false },
  routes: [],
  domains: [],
  namespaces: [],
};

const operational = () => ({
  schemaVersion: "collection-controls-v0.1",
  state: "operational",
  revision: 1,
  enrollment: true,
  uploadRegistration: true,
  processing: true,
  publication: true,
});
const nonAllTrue = () => ({
  schemaVersion: "collection-controls-v0.1",
  state: "degraded",
  revision: 1,
  enrollment: true,
  uploadRegistration: false,
  processing: true,
  publication: false,
});
const contained = revision => ({
  schemaVersion: "collection-controls-v0.1",
  state: "contained",
  revision,
  enrollment: false,
  uploadRegistration: false,
  processing: false,
  publication: false,
});

function clone(value) {
  return structuredClone(value);
}

async function harness({
  initial = operational(),
  transport = "browser",
  captureVariants: initialCaptureVariants = null,
  captureFailureAt = null,
  operationSaveFailureAt = null,
  publicationCrashAfterLink = false,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "production-collection-control-")));
  const operationDirectory = join(root, "operation");
  let controls = clone(initial);
  let captureVariants = initialCaptureVariants;
  let captureCount = 0;
  let captureFailure = captureFailureAt;
  let operationSaveFailure = operationSaveFailureAt;
  let publicationCrash = publicationCrashAfterLink;
  const calls = [];
  let held = null;
  let postMode = "apply";
  let runtimeState = "staged";
  const lock = {
    createOwner: () => "c".repeat(40),
    status: () => held,
    acquire: owner => {
      calls.push({ type: "lock-acquire", owner });
      if (held !== null) throw Object.assign(new Error("busy"), { code: "BUSY" });
      held = owner;
    },
    assertOwned: owner => {
      if (held !== owner) throw Object.assign(new Error("not owner"), { code: "NOT_OWNER" });
    },
    release: owner => {
      calls.push({ type: "lock-release", owner });
      if (held !== owner) throw Object.assign(new Error("not owner"), { code: "NOT_OWNER" });
      held = null;
    },
  };
  const provider = {
    capture: async () => {
      if (captureFailure === captureCount) {
        captureCount += 1;
        throw new Error("synthetic capture failure");
      }
      const variant = captureVariants?.[captureCount] ?? captureVariants?.at(-1);
      captureCount += 1;
      return clone(variant ?? inventory);
    },
  };
  const d1Read = async ({ query }) => {
    calls.push({ type: "d1", query });
    if (query === COLLECTION_CONTROL_QUERY) return clone(controls);
    if (query === TELEMETRY_V12_RUNTIME_QUERY) return { state: runtimeState };
    throw new Error("unexpected query");
  };
  const adminRead = async () => {
    calls.push({ type: "overview" });
    return clone(controls);
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ type: "fetch", url: parsed.href, options });
    if (parsed.pathname.endsWith("/overview")) {
      return Response.json({ schemaVersion: "admin-overview-v0.5", collection: clone(controls) });
    }
    if (parsed.pathname.endsWith("/action")) {
      const request = JSON.parse(options.body);
      if (postMode === "conflict") return Response.json({ error: { code: "ADMIN_ACTION_CONFLICT" } }, { status: 409 });
      if (postMode === "lost-before") throw new Error("socket closed");
      const next = {
        schemaVersion: "collection-controls-v0.1",
        state: Object.values(request).filter(value => value === true).length === 4
          ? "operational"
          : Object.values(request).filter(value => value === true).length === 0
            ? "contained" : "degraded",
        revision: controls.revision + 1,
        enrollment: request.enrollment,
        uploadRegistration: request.uploadRegistration,
        processing: request.processing,
        publication: request.publication,
      };
      controls = next;
      if (postMode === "lost-after") throw new Error("socket closed");
      return Response.json({
        schemaVersion: "admin-action-v0.1",
        action: "set_collection_controls",
        collection: clone(next),
      });
    }
    throw new Error("unexpected request");
  };
  const operationFactory = async options => {
    const operation = await openOperation(options);
    return {
      get record() { return operation.record; },
      async save(state) {
        const failureAt = operationSaveFailure;
        const shouldFail = failureAt === "release_intent"
          ? state.coordination === "release_intent"
          : failureAt === "released"
            ? state.coordination === "released"
            : failureAt === "acquire_intent"
              ? state.coordination === "acquire_intent" && state.before === null
              : failureAt === "held"
                ? state.coordination === "held" && state.before === null
                : failureAt === "before"
                  ? state.coordination === "held" && state.before !== null
                    && state.intent === null && state.phase === "containing"
                  : false;
        if (shouldFail) {
          operationSaveFailure = null;
          if (failureAt === "release_intent") {
            throw new Error("synthetic save failure before release intent");
          }
          if (failureAt === "acquire_intent" || failureAt === "held") {
            await operation.save(state);
            throw new Error(`synthetic save failure after ${failureAt}`);
          }
          if (failureAt === "before") {
            throw new Error("synthetic save failure before before-snapshot");
          }
          // A release failure is deliberately raised before persisting the
          // released marker. The lock has already been released, so resume
          // must adopt the exact terminal state without overwriting it.
          throw new Error("synthetic save failure before released marker");
        }
        return operation.save(state);
      },
      close: () => operation.close(),
    };
  };
  const run = (options = {}) => runProductionCollectionControl({
    accountId: ACCOUNT,
    workerName: "synthetic-worker",
    repositoryRoot: root,
    operationDirectory,
    transport,
    provider,
    lockFactory: () => lock,
    operationFactory,
    onPublicationLinked: async details => {
      if (!publicationCrash) return;
      publicationCrash = false;
      calls.push({ type: "publication-linked", ...details });
      throw new Error("synthetic publication crash after link");
    },
    d1Read,
    adminRead,
    fetchImpl,
    environment: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" },
    ...options,
  });
  return {
    root,
    operationDirectory,
    controls: () => controls,
    setControls: value => { controls = clone(value); },
    setCaptureVariants: value => {
      captureVariants = value;
      captureCount = 0;
      captureFailure = null;
    },
    setCaptureFailureAt: value => { captureFailure = value; },
    setOperationSaveFailureAt: value => { operationSaveFailure = value; },
    setPublicationCrashAfterLink: value => { publicationCrash = value; },
    setPostMode: value => { postMode = value; },
    setRuntimeState: value => { runtimeState = value; },
    held: () => held,
    calls,
    run,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function establishContained(f) {
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  return f.run({ action: "reconcile", reconcileOnly: true });
}

async function prepareSuccessor(f, successor = null) {
  if (successor !== null) f.setCaptureVariants([successor]);
  const successorPath = join(f.root, "successor.json");
  const prepared = await f.run({
    action: "prepare-successor",
    successorOutput: successorPath,
  });
  const artifact = await readProductionCollectionSuccessorArtifact(successorPath);
  return { artifact, prepared };
}

test("CLI defaults to read-only browser inspection and keeps confirmations closed", () => {
  const args = parseProductionCollectionControlArguments([
    "--account-id", ACCOUNT,
    "--worker-name", "synthetic-worker",
    "--repository-root", "/private/checkout",
    "--operation-directory", "/private/operation",
  ]);
  assert.equal(args.action, "inspect");
  assert.equal(args.transport, "browser");
  assert.equal(args.resume, false);
  const noJournalInspection = parseProductionCollectionControlArguments([
    "--account-id", ACCOUNT,
    "--worker-name", "synthetic-worker",
    "--repository-root", "/private/checkout",
  ]);
  assert.equal(noJournalInspection.action, "inspect");
  assert.equal(noJournalInspection.operationDirectory, undefined);
  assert.throws(() => parseProductionCollectionControlArguments([
    "--mode", "contain", "--account-id", ACCOUNT, "--worker-name", "synthetic-worker",
    "--repository-root", "/private/checkout", "--operation-directory", "/private/operation",
  ]), { code: "PRODUCTION_COLLECTION_CONTROL_CONFIRMATION_REQUIRED" });
  assert.throws(() => parseProductionCollectionControlArguments([
    "--mode", "contain", "--transport", "session", "--account-id", ACCOUNT,
    "--worker-name", "synthetic-worker", "--repository-root", "/private/checkout",
    "--operation-directory", "/private/operation", "--confirm", PRODUCTION_COLLECTION_CONFIRMATION,
  ]), { code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_SESSION_REQUIRED" });
  assert.throws(() => parseProductionCollectionControlArguments([
    "--mode", "contain", "--transport", "browser", "--account-id", ACCOUNT,
    "--worker-name", "synthetic-worker", "--repository-root", "/private/checkout",
    "--operation-directory", "/private/operation", "--admin-session-file", "/private/session.json",
    "--confirm", PRODUCTION_COLLECTION_CONFIRMATION,
  ]), { code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_SESSION_UNEXPECTED" });
});

test("inspection reads exact D1 controls without opening the shared lock or mutating", async t => {
  const f = await harness();
  t.after(f.cleanup);
  const result = await f.run();
  assert.equal(result.status, "inspected");
  assert.equal(result.productionWritesPerformed, false);
  assert.equal(f.held(), null);
  assert.equal(f.calls.some(call => call.type === "lock-acquire"), false);
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

test("programmatic browser transport refuses owner session material", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await assert.rejects(f.run({ session: SESSION }), {
    code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_SESSION_UNEXPECTED",
  });
  assert.equal(f.calls.length, 0);
});

test("browser containment arms a durable action without POST and reconciles exact target", async t => {
  const f = await harness();
  t.after(f.cleanup);
  const armed = await f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(armed.status, "action_required");
  assert.equal(armed.expectedRevision, 1);
  assert.deepEqual(armed.target, {
    enrollment: false,
    uploadRegistration: false,
    processing: false,
    publication: false,
  });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
  assert.doesNotMatch(JSON.stringify(armed), /synthetic-owner-session|synthetic-provider-token/u);
  const intentBytes = await readFile(join(f.operationDirectory, "contain-intent.json"));
  assert.equal((await stat(join(f.operationDirectory, "contain-intent.json"))).mode & 0o777, 0o600);
  assert.doesNotMatch(intentBytes.toString(), /synthetic-provider-token|CF_Authorization/u);
  f.setControls(contained(2));
  const result = await f.run({ action: "reconcile", reconcileOnly: true });
  assert.equal(result.status, "completed");
  assert.equal(result.state, "contained");
  assert.equal(f.held(), null);
});

test("restore uses the captured non-all-true tuple and the verified contained revision", async t => {
  const f = await harness({ initial: nonAllTrue() });
  t.after(f.cleanup);
  await establishContained(f);
  const journal = await readOperation(f.operationDirectory);
  assert.deepEqual(journal.state.before.controls, nonAllTrue());
  const successorInventory = clone(inventory);
  successorInventory.version.id = "33333333-3333-4333-8333-333333333333";
  successorInventory.settings.bindings = successorInventory.version.resources.bindings;
  const { artifact, prepared: successor } = await prepareSuccessor(f, successorInventory);
  assert.equal(successor.approvedSuccessorSha256, artifact.proofSha256);
  const armed = await f.run({
    action: "restore",
    successorArtifact: artifact,
    approvedSuccessorSha256: artifact.proofSha256,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  });
  assert.equal(armed.status, "action_required");
  assert.equal(armed.expectedRevision, 2);
  assert.deepEqual(armed.target, {
    enrollment: true,
    uploadRegistration: false,
    processing: true,
    publication: false,
  });
  f.setControls({ ...nonAllTrue(), revision: 3 });
  const restored = await f.run({
    action: "reconcile",
    reconcileOnly: true,
  });
  assert.equal(restored.status, "completed");
  assert.equal(restored.state, "degraded");
  assert.equal(restored.revision, 3);
  assert.equal(f.held(), null);
});

test("session transport sends exact origin, CSRF and closed revision body", async t => {
  const f = await harness({ transport: "session" });
  t.after(f.cleanup);
  const result = await f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(result.status, "completed");
  const action = f.calls.find(call => call.type === "fetch" && call.url.endsWith("/action"));
  assert.ok(action);
  assert.equal(action.options.method, "POST");
  assert.equal(action.url, `${PRODUCTION_COLLECTION_ADMIN_ORIGIN}/api/v1/admin/action`);
  assert.equal(action.options.headers.origin, PRODUCTION_COLLECTION_ADMIN_ORIGIN);
  assert.equal(action.options.headers.cookie, SESSION.cookie);
  assert.equal(action.options.headers.accept, "application/json");
  assert.equal(action.options.headers["content-type"], "application/json");
  assert.equal(action.options.headers["sec-fetch-site"], "same-origin");
  assert.equal(action.options.headers["x-usage-monitor-admin"], "1");
  assert.deepEqual(JSON.parse(action.options.body), {
    action: "set_collection_controls",
    expectedRevision: 1,
    enrollment: false,
    uploadRegistration: false,
    processing: false,
    publication: false,
    reasonCode: "maintenance",
  });
  const overviews = f.calls.filter(call => call.type === "fetch"
    && call.url.endsWith("/overview"));
  assert.ok(overviews.length >= 4);
  for (const overview of overviews) {
    assert.equal(overview.url, `${PRODUCTION_COLLECTION_ADMIN_ORIGIN}/api/v1/admin/overview`);
    assert.equal(overview.options.method, "GET");
    assert.equal(overview.options.headers.cookie, SESSION.cookie);
    assert.equal(overview.options.body, undefined);
  }
});

test("lost response before commit is pending and explicit same-lock resume may retry", async t => {
  const f = await harness({ transport: "session" });
  t.after(f.cleanup);
  f.setPostMode("lost-before");
  const pending = await f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(pending.status, "pending");
  assert.equal(f.held(), "c".repeat(40));
  f.setPostMode("apply");
  const resumed = await f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    resume: true,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(f.held(), null);
});

test("lost response after commit is recovered by exact target readback", async t => {
  const f = await harness({ transport: "session" });
  t.after(f.cleanup);
  f.setPostMode("lost-after");
  const result = await f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(result.status, "completed");
  assert.equal(f.held(), null);
});

test("409 is a stop with no blind retry and keeps the shared lock", async t => {
  const f = await harness({ transport: "session" });
  t.after(f.cleanup);
  f.setPostMode("conflict");
  await assert.rejects(f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_ACTION_CONFLICT" });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.filter(call => call.type === "fetch" && call.url.endsWith("/action")).length, 1);
});

test("drift after an uncertain response remains ambiguous and retains the lock", async t => {
  const f = await harness({ transport: "session" });
  t.after(f.cleanup);
  f.setPostMode("lost-before");
  const original = f.controls();
  f.setPostMode("apply");
  const post = async () => {
    f.setControls({ ...original, revision: 3, state: "degraded", processing: false });
    throw Object.assign(new Error("lost"), { code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_RESPONSE_UNCERTAIN" });
  };
  await assert.rejects(f.run({
    action: "contain",
    transport: "session",
    session: SESSION,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
    post,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_ACTION_AMBIGUOUS" });
  assert.equal(f.held(), "c".repeat(40));
});

test("deployment source/config drift blocks mutation after lock acquisition", async t => {
  const changed = clone(inventory);
  changed.version.id = "33333333-3333-4333-8333-333333333333";
  changed.settings.bindings = changed.version.resources.bindings;
  const f = await harness({ captureVariants: [inventory, changed] });
  t.after(f.cleanup);
  await assert.rejects(f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_LIVE_DEPLOYMENT_DRIFT" });
  assert.equal(f.held(), "c".repeat(40));
});

test("deployment drift during the bracketed D1 read retains the lock", async t => {
  const changed = clone(inventory);
  changed.version.id = "33333333-3333-4333-8333-333333333333";
  changed.settings.bindings = changed.version.resources.bindings;
  const f = await harness({ captureVariants: [inventory, inventory, changed] });
  t.after(f.cleanup);
  await assert.rejects(f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_LIVE_DEPLOYMENT_DRIFT" });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

test("post-read identity capture failure retains the lock", async t => {
  const f = await harness({ captureFailureAt: 2 });
  t.after(f.cleanup);
  await assert.rejects(f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_LIVE_READ_FAILED" });
  assert.equal(f.held(), "c".repeat(40));
});

for (const boundary of ["acquire_intent", "held", "before"]) {
  test(`fresh containment resumes safely after ${boundary} journal crash`, async t => {
    const f = await harness({ operationSaveFailureAt: boundary });
    t.after(f.cleanup);
    await assert.rejects(f.run({
      action: "contain",
      confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
    }), /synthetic save failure/u);
    const interrupted = await readOperation(f.operationDirectory);
    assert.equal(interrupted.state.phase, "containing");
    assert.equal(interrupted.state.before, null);
    assert.ok(interrupted.state.initialIdentity);
    assert.equal(f.held(), boundary === "acquire_intent" ? null : "c".repeat(40));
    const armed = await f.run({
      action: "contain",
      resume: true,
      confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
    });
    assert.equal(armed.status, "action_required");
    assert.equal(f.held(), "c".repeat(40));
    f.setControls(contained(2));
    const result = await f.run({ action: "reconcile", reconcileOnly: true });
    assert.equal(result.status, "completed");
    assert.equal(f.held(), null);
  });
}

test("fresh containment resumes after a failed initial identity capture", async t => {
  const f = await harness({ captureFailureAt: 1 });
  t.after(f.cleanup);
  await assert.rejects(f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_LIVE_READ_FAILED" });
  const interrupted = await readOperation(f.operationDirectory);
  assert.equal(interrupted.state.coordination, "held");
  assert.equal(interrupted.state.before, null);
  f.setCaptureFailureAt(null);
  const armed = await f.run({
    action: "contain",
    resume: true,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  });
  assert.equal(armed.status, "action_required");
  f.setControls(contained(2));
  const result = await f.run({ action: "reconcile", reconcileOnly: true });
  assert.equal(result.status, "completed");
});

test("incomplete containment cannot be advanced by reconcile or restore", async t => {
  const f = await harness({ operationSaveFailureAt: "held" });
  t.after(f.cleanup);
  await assert.rejects(f.run({
    action: "contain",
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), /synthetic save failure/u);
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), {
    code: "PRODUCTION_COLLECTION_CONTROL_CONTAIN_RESUME_REQUIRED",
  });
  await assert.rejects(f.run({
    action: "restore",
    resume: true,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_RESTORE_STATE_INVALID" });
  assert.equal(f.held(), "c".repeat(40));
});

test("browser reconcile refuses receipt when its post-read identity capture fails", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  // Reconcile starts at capture 0 after this reset; the final capture in the
  // bracket is intentionally unavailable.
  f.setCaptureVariants([inventory, inventory]);
  f.setCaptureFailureAt(1);
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), {
    code: "PRODUCTION_COLLECTION_CONTROL_LIVE_READ_FAILED",
  });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(await readOperation(f.operationDirectory).then(record => record.state.intent.action), "contain");
});

test("owner Access session requires exact private 0600 file and never leaks its secret", async t => {
  const f = await harness();
  t.after(f.cleanup);
  const sessionPath = join(f.root, "admin-session.json");
  await writeFile(sessionPath, JSON.stringify(SESSION), { mode: 0o600 });
  const session = await readProductionCollectionAdminSession(sessionPath);
  assert.equal(session.origin, PRODUCTION_COLLECTION_ADMIN_ORIGIN);
  await chmod(sessionPath, 0o644);
  await assert.rejects(readProductionCollectionAdminSession(sessionPath), {
    code: "PRODUCTION_COLLECTION_CONTROL_PRIVATE_FILE_INVALID",
  });
  await chmod(sessionPath, 0o600);
  const hardPath = join(f.root, "admin-session-hardlink.json");
  await createHardLink(sessionPath, hardPath);
  await assert.rejects(readProductionCollectionAdminSession(hardPath), {
    code: "PRODUCTION_COLLECTION_CONTROL_PRIVATE_FILE_INVALID",
  });
  const symlinkPath = join(f.root, "admin-session-symlink.json");
  await symlink(sessionPath, symlinkPath);
  await assert.rejects(readProductionCollectionAdminSession(symlinkPath), {
    code: "PRODUCTION_COLLECTION_CONTROL_PRIVATE_FILE_INVALID",
  });
  assert.throws(() => validateProductionCollectionAdminSession({
    ...SESSION,
    origin: "https://tibotattle.com",
  }), { code: "PRODUCTION_COLLECTION_CONTROL_ADMIN_SESSION_INVALID" });
  assert.doesNotMatch(JSON.stringify(session), /provider-token/u);
});

test("resume of a browser intent is still action-only and receipt is no-clobber", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  const path = join(f.operationDirectory, "contain-intent.json");
  const before = await readFile(path);
  const resumed = await f.run({ action: "contain", resume: true, confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  assert.equal(resumed.status, "action_required");
  assert.deepEqual(await readFile(path), before);
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

test("requested contain cannot resume a pending restore intent", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await establishContained(f);
  const { artifact } = await prepareSuccessor(f);
  await f.run({
    action: "restore",
    successorArtifact: artifact,
    approvedSuccessorSha256: artifact.proofSha256,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  });
  await assert.rejects(f.run({
    action: "contain",
    resume: true,
    confirmation: PRODUCTION_COLLECTION_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_ACTION_MISMATCH" });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

test("requested restore cannot resume a pending contain intent", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  await assert.rejects(f.run({
    action: "restore",
    resume: true,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_ACTION_MISMATCH" });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

test("successor restore is bound to the reviewed successor identity", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await establishContained(f);
  const successor = clone(inventory);
  successor.version.id = "33333333-3333-4333-8333-333333333333";
  successor.settings.bindings = successor.version.resources.bindings;
  const { artifact } = await prepareSuccessor(f, successor);
  const unrelated = clone(successor);
  unrelated.version.id = "44444444-4444-4444-8444-444444444444";
  unrelated.settings.bindings = unrelated.version.resources.bindings;
  f.setCaptureVariants([unrelated]);
  await assert.rejects(f.run({
    action: "restore",
    successorArtifact: artifact,
    approvedSuccessorSha256: artifact.proofSha256,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_LIVE_DEPLOYMENT_DRIFT" });
  assert.equal(f.held(), "c".repeat(40));
  assert.equal(f.calls.some(call => call.type === "fetch" && call.url.endsWith("/action")), false);
});

for (const action of ["contain", "restore"]) {
  for (const boundary of ["release_intent", "released"]) {
    test(`${action} crash at ${boundary} resumes from durable intent`, async t => {
      const f = await harness();
      t.after(f.cleanup);
      if (action === "contain") {
        await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
      } else {
        await establishContained(f);
        const { artifact } = await prepareSuccessor(f);
        await f.run({
          action: "restore",
          successorArtifact: artifact,
          approvedSuccessorSha256: artifact.proofSha256,
          confirmation: PRODUCTION_RESTORE_CONFIRMATION,
        });
      }
      f.setControls(action === "contain" ? contained(2) : { ...operational(), revision: 3 });
      f.setOperationSaveFailureAt(boundary);
      await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), /synthetic save failure/u);
      if (boundary === "release_intent") {
        await assert.rejects(readFile(join(
          f.operationDirectory,
          action === "contain" ? "contained-result.json" : "restored-result.json",
        )));
        assert.equal(f.held(), "c".repeat(40));
      } else {
        await readFile(join(
          f.operationDirectory,
          action === "contain" ? "contained-result.json" : "restored-result.json",
        ));
        assert.equal(f.held(), null);
      }
      const resumed = await f.run({ action: "reconcile", reconcileOnly: true });
      assert.equal(resumed.status, "completed");
      assert.equal(f.held(), null);
    });
  }
}

test("terminal receipt mismatch is never clobbered during recovery", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  f.setOperationSaveFailureAt("released");
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), /synthetic save failure/u);
  const receiptPath = join(f.operationDirectory, "contained-result.json");
  await writeFile(receiptPath, "{\"tampered\":true}\n", { mode: 0o600 });
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), {
    code: "PRODUCTION_COLLECTION_CONTROL_RECEIPT_EXISTS",
  });
  assert.equal(f.held(), null);
  assert.equal((await readOperation(f.operationDirectory)).state.coordination, "release_intent");
});

test("linked receipt temp publication is journal-bound and crash-recoverable", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  f.setPublicationCrashAfterLink(true);
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), /synthetic publication crash/u);
  const interrupted = await readOperation(f.operationDirectory);
  const publication = interrupted.state.publication;
  assert.equal(publication.schema, "production-collection-control-publication-v1");
  assert.equal(publication.destination, join(f.operationDirectory, "contained-result.json"));
  assert.equal(publication.bytesLength > 0, true);
  assert.match(publication.bytesSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await lstat(publication.destination)).nlink, 2);
  assert.equal((await lstat(publication.tempPath)).nlink, 2);
  const resumed = await f.run({ action: "reconcile", reconcileOnly: true });
  assert.equal(resumed.status, "completed");
  await assert.rejects(lstat(publication.tempPath));
  assert.equal((await lstat(publication.destination)).nlink, 1);
});

test("arbitrary receipt hardlinks remain rejected", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  f.setOperationSaveFailureAt("released");
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), /synthetic save failure/u);
  const receiptPath = join(f.operationDirectory, "contained-result.json");
  const hardPath = join(f.operationDirectory, "unrelated-receipt-hardlink.json");
  await createHardLink(receiptPath, hardPath);
  await assert.rejects(f.run({ action: "reconcile", reconcileOnly: true }), {
    code: "PRODUCTION_COLLECTION_CONTROL_RECEIPT_INVALID",
  });
  assert.equal((await readOperation(f.operationDirectory)).state.coordination, "release_intent");
});

test("restoration refuses when the typed usage runtime is not staged", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  f.setControls(contained(2));
  await f.run({ action: "reconcile", reconcileOnly: true });
  const successorPath = join(f.root, "successor.json");
  const prepared = await f.run({
    action: "prepare-successor",
    successorOutput: successorPath,
  });
  const artifact = await readProductionCollectionSuccessorArtifact(successorPath);
  f.setRuntimeState("active");
  await assert.rejects(f.run({
    action: "restore",
    successorArtifact: artifact,
    approvedSuccessorSha256: prepared.approvedSuccessorSha256,
    confirmation: PRODUCTION_RESTORE_CONFIRMATION,
  }), { code: "PRODUCTION_COLLECTION_CONTROL_RUNTIME_NOT_STAGED" });
  assert.equal(f.held(), "c".repeat(40));
});

test("operation journal remains bounded and contains no session material", async t => {
  const f = await harness();
  t.after(f.cleanup);
  await f.run({ action: "contain", confirmation: PRODUCTION_COLLECTION_CONFIRMATION });
  const operation = await readOperation(f.operationDirectory);
  const serialized = JSON.stringify(operation);
  assert.ok(serialized.length < 20_000);
  assert.doesNotMatch(serialized, /CF_Authorization|synthetic-owner-session|synthetic-provider-token/u);
});
