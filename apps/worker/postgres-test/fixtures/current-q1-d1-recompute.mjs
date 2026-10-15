/** Current-code synthetic corpus qualification, deliberately not an export
 * oracle. The immutable corpus retains two conflicted days. Production's
 * strict whole-export oracle must refuse that state; this driver qualifies
 * the other days without deleting or hiding the conflict evidence. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SHA = /^[a-f0-9]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const INITIAL_DAILY_CONVERGENCE_BOUND = 4_096;
const FORCED_DAILY_PER_HEAD_BOUND = 64;
const FORCED_DAILY_CONVERGENCE_BOUND = 168 * FORCED_DAILY_PER_HEAD_BOUND;
const GRAPH_INVOCATION_BOUND = 70 * 4 * 64;
const CACHE_PASS_BOUND = 4_096;
const NATIVE_INVOCATION_BOUND = 128;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = () => { throw Object.assign(new Error("CURRENT_Q1_NOT_SETTLED"), { code: "CURRENT_Q1_NOT_SETTLED" }); };
const requireFact = (condition) => { if (!condition) fail(); };
const GRAPH_CACHES = Object.freeze([
  "analytics_community_graph_results", "analytics_community_graph_execution", "analytics_community_graph_scan",
  "analytics_community_graph_work_selection", "analytics_history_checkpoint_heads",
  "analytics_history_checkpoint_parts", "analytics_history_checkpoint_stages",
]);
const AUTHORITY_KEYS = Object.freeze(["sourceId", "sourceNamespace", "publicAuthorityEpoch", "policyRevision",
  "collectionRevision", "graphInvalidationEpoch", "sourceEpoch", "sequence"]);
const quote = (name) => { requireFact(typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)); return `"${name}"`; };
const typed = (value) => value === null ? ["null"] : typeof value === "string" ? ["text", value]
  : typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? ["number", value]
    : typeof value === "bigint" ? ["integer", value.toString()]
      : ArrayBuffer.isView(value) ? ["blob", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")]
        : Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
          ? ["blob", Buffer.from(value).toString("hex")]
        : fail();

/** Freeze every ingestion table and schema object, including empty and newly
 * introduced tables. Typed bytes distinguish NULL, text, integers and BLOBs.
 * Only the two exact control-operation targets are split out for separately
 * checked full-row transitions. Unknown tables remain in the invariant. */
/** Capture the canonical source invariant together with the closed table
 * digest vector needed to explain the D7 bootstrap transition. Raw table rows
 * and schema SQL remain local to this function; callers receive only the
 * existing invariant projection, per-table typed digests, and its digest. */
export async function captureCurrentQ1SourceInvariantDetails(database) {
  const schema = (await database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    ORDER BY type,name,tbl_name`).all()).results;
  requireFact(Array.isArray(schema) && schema.length < 10_000);
  const tableNames = schema.filter((row) => row.type === "table").map((row) => row.name).sort();
  requireFact(tableNames.includes("collection_controls") && tableNames.includes("admin_action_audit")
    && tableNames.includes("sqlite_sequence"));
  const tables = [], tableDigests = [], special = {};
  for (const table of tableNames) {
    const columns = (await database.prepare(`PRAGMA table_info(${quote(table)})`).all()).results;
    requireFact(Array.isArray(columns) && columns.length > 0 && columns.length <= 256);
    const names = columns.map((column) => column.name), keys = columns.filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk).map((column) => column.name);
    const effectiveKeys = table === "sqlite_sequence" ? ["name"] : keys;
    const order = (effectiveKeys.length ? effectiveKeys : ["rowid"]).map(quote).join(",");
    const selectedNames = effectiveKeys.length ? names : ["rowid", ...names];
    const hash = createHash("sha256"), rows = [];
    let countRows = 0, totalBytes = 0;
    for (let offset = 0; ; offset += 256) {
      const page = (await database.prepare(`SELECT ${selectedNames.map(quote).join(",")} FROM ${quote(table)}
        ORDER BY ${order} LIMIT 256 OFFSET ?`).bind(offset).all()).results;
      requireFact(Array.isArray(page) && page.length <= 256);
      for (const row of page) {
        requireFact(exact(row, selectedNames));
        const line = JSON.stringify(selectedNames.map((name) => typed(row[name])));
        totalBytes += Buffer.byteLength(line); countRows++;
        requireFact(countRows <= 1_000_000 && totalBytes <= 256 * 1024 * 1024);
        hash.update(digest(line)).update("\n");
        if (["collection_controls", "admin_action_audit", "sqlite_sequence"].includes(table)) {
          const projected = { ...row }; delete projected.rowid; rows.push(projected);
        }
      }
      if (page.length < 256) break;
    }
    const tableDigest = { table, rows: countRows, sha256: hash.digest("hex") };
    tableDigests.push(tableDigest);
    if (["collection_controls", "admin_action_audit", "sqlite_sequence"].includes(table)) special[table] = rows;
    else tables.push(tableDigest);
  }
  requireFact(special.collection_controls.length === 1 && special.admin_action_audit.length <= 256);
  special.sqlite_sequence.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const otherSequences = special.sqlite_sequence.filter((row) => row.name !== "admin_action_audit");
  const invariant = { sha256: digest({ schema, tables, otherSequences }), schemaSha256: digest(schema),
    controls: special.collection_controls, audit: special.admin_action_audit,
    sequences: special.sqlite_sequence };
  // `tables` remains the original invariant vector so its hash and the
  // public v2 projection stay byte-for-byte compatible. `tableDigests` is a
  // separate all-table vector for the D7 bootstrap-preservation proof; it
  // includes controls, audit and sqlite_sequence without retaining row data.
  const details = { ...invariant, tables, tableDigests };
  return { ...details, fullSourceCaptureSha256: digest(details) };
}

/** Keep the existing v2 public return shape exactly stable by projecting the
 * detail capture through the original invariant fields. */
export async function captureCurrentQ1SourceInvariant(database) {
  const details = await captureCurrentQ1SourceInvariantDetails(database);
  return { sha256: details.sha256, schemaSha256: details.schemaSha256, controls: details.controls,
    audit: details.audit, sequences: details.sequences };
}

export function assertCurrentQ1SourceUnchanged(before, after) {
  requireFact(isDeepStrictEqual(before, after));
}

/** Verify the single public control operation field for field, including its
 * successful audit insert and AUTOINCREMENT delta. No broad mutation class is
 * ignored by the all-table source binding. */
export function assertCurrentQ1ControlTransition({ before, after, controlsBefore, controlsAfter, nowMs, actorDigest }) {
  requireFact(before.sha256 === after.sha256 && before.schemaSha256 === after.schemaSha256
    && before.controls.length === 1 && after.controls.length === 1 && SHA.test(actorDigest));
  const old = before.controls[0], next = after.controls[0], nowIso = new Date(nowMs).toISOString();
  requireFact(isDeepStrictEqual(next, { ...old, revision: old.revision + 1, reason_code: "drill_restore", updated_at: nowIso })
    && controlsAfter.revision === controlsBefore.revision + 1
    && controlsBefore.revision === old.revision && controlsAfter.revision === next.revision
    && ["enrollment", "uploadRegistration", "processing", "publication", "state", "schemaVersion"]
      .every((key) => controlsBefore[key] === controlsAfter[key])
    && after.audit.length === before.audit.length + 1
    && isDeepStrictEqual(after.audit.slice(0, -1), before.audit));
  const row = after.audit.at(-1), priorSeq = before.sequences.find((item) => item.name === "admin_action_audit")?.seq ?? 0;
  requireFact(count(priorSeq) && exact(row, ["id", "operation_id", "action", "actor_identity_digest", "outcome", "details_json", "created_at"])
    && row.id === priorSeq + 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.operation_id)
    && !before.audit.some((item) => item.operation_id === row.operation_id)
    && row.action === "set_collection_controls" && row.actor_identity_digest === actorDigest && row.outcome === "success"
    && row.created_at === nowIso && row.details_json === JSON.stringify({
      expectedRevision: old.revision, revision: next.revision, state: controlsAfter.state,
      flags: { enrollment: controlsBefore.enrollment, uploadRegistration: controlsBefore.uploadRegistration,
        processing: controlsBefore.processing, publication: controlsBefore.publication }, reasonCode: "drill_restore",
    }) && isDeepStrictEqual(after.sequences, [...before.sequences.filter((item) => item.name !== "admin_action_audit"),
      { name: "admin_action_audit", seq: priorSeq + 1 }].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)));
  return { beforeSha256: digest(before), afterSha256: digest(after), auditRowsBefore: before.audit.length,
    auditRowsAfter: after.audit.length, auditSequenceBefore: priorSeq, auditSequenceAfter: priorSeq + 1 };
}

function validDays(days, length) {
  return Array.isArray(days) && days.length === length && days.every((day, n) => DAY.test(day)
    && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
    && (n === 0 || days[n - 1] < day));
}

function validateCorpus(corpus) {
  requireFact(validDays(corpus?.expectedDailyDays, 168) && validDays(corpus?.conflictDays, 2)
    && !corpus.conflictDays.some((day) => corpus.expectedDailyDays.includes(day)));
  const all = [...corpus.expectedDailyDays, ...corpus.conflictDays].sort();
  requireFact(all.length === 170 && all.every((day, n) => day === new Date(Date.parse("2026-04-15")
    + n * 86_400_000).toISOString().slice(0, 10)));
}

/** Real scheduler state machine. An exclusion is earned only by the exact
 * expected conflict's zero-progress refusal. An idle result with exclusions
 * is a pass result, never whole-source idleness. Deferred eligible work,
 * unknown days, wrong reasons and bounded non-convergence all fail closed. */
export async function runCurrentQ1DailyPass({ advance, expectedDailyDays, conflictDays, preferStaleHead,
  bound = 2_048, onIteration = () => {} }) {
  validateCorpus({ expectedDailyDays, conflictDays });
  requireFact(typeof advance === "function" && typeof preferStaleHead === "boolean"
    && count(bound) && bound > 0 && bound <= 10_752 && typeof onIteration === "function");
  const skipped = [], outcomes = { published: 0, unchanged: 0, progress: 0, conflicts: 0 };
  for (let iteration = 1; iteration <= bound; iteration++) {
    onIteration(iteration);
    const step = await advance({ preferStaleHead, skipDays: [...skipped] });
    requireFact(object(step) && count(step.ownersAdvanced));
    if (step.state === "idle") {
      requireFact(exact(step, ["state", "ownersAdvanced"]) && step.ownersAdvanced === 0);
      // Re-prove every retained conflict rather than accepting a forged early
      // idle or a selector that ignored one queued candidate.
      requireFact(isDeepStrictEqual([...skipped].sort(), conflictDays));
      return { iterations: iteration, outcomes, filteredIdle: true };
    }
    requireFact(DAY.test(step.day) && !skipped.includes(step.day)
      && (expectedDailyDays.includes(step.day) || conflictDays.includes(step.day)));
    if (step.state === "deferred") {
      requireFact(exact(step, ["state", "reason", "ownersAdvanced", "day"])
        && conflictDays.includes(step.day) && step.reason === "projection_pending" && step.ownersAdvanced === 0);
      skipped.push(step.day); outcomes.conflicts++;
    } else if (step.state === "progress") {
      requireFact((exact(step, ["state", "ownersAdvanced", "day"])
          || exact(step, ["state", "reason", "ownersAdvanced", "day"]) && step.reason === "projection_pending")
        && step.ownersAdvanced > 0 && step.ownersAdvanced <= 4);
      outcomes.progress++;
    } else {
      requireFact(exact(step, ["state", "ownersAdvanced", "day"])
        && expectedDailyDays.includes(step.day) && ["published", "unchanged"].includes(step.state)
        && step.ownersAdvanced <= 4);
      outcomes[step.state]++;
    }
  }
  fail();
}

function validAuthority(value) {
  return exact(value, AUTHORITY_KEYS) && typeof value.sourceId === "string" && typeof value.sourceNamespace === "string"
    && AUTHORITY_KEYS.slice(2).every((key) => count(value[key])) && value.policyRevision > 0 && value.collectionRevision > 0;
}

export function validateCurrentQ1CorpusConvergence(value, corpus) {
  validateCorpus(corpus);
  requireFact(exact(value, ["schemaVersion", "beforeRecompute", "afterRecompute"])
    && value.schemaVersion === "current-q1-d1-corpus-convergence-v1");
  for (const snapshot of [value.beforeRecompute, value.afterRecompute]) {
    requireFact(exact(snapshot, ["publishedDays", "retainedQueue", "conflictEvidence", "admissionSha256",
      "sourceInvariantSha256", "fence", "selector", "dailyPasses"])
      && isDeepStrictEqual(snapshot.publishedDays, corpus.expectedDailyDays)
      && Array.isArray(snapshot.retainedQueue) && snapshot.retainedQueue.length === 2
      && isDeepStrictEqual(snapshot.retainedQueue.map((row) => row?.day), corpus.conflictDays)
      && snapshot.retainedQueue.every((row) => exact(row, ["day", "revision"]) && count(row.revision) && row.revision > 0)
      && Array.isArray(snapshot.conflictEvidence) && snapshot.conflictEvidence.length === 2
      && isDeepStrictEqual(snapshot.conflictEvidence.map((row) => row?.day), corpus.conflictDays)
      && snapshot.conflictEvidence.every((row) => exact(row, ["day", "rows", "conflictRows", "sha256"])
        && count(row.rows) && row.rows > 0 && count(row.conflictRows) && row.conflictRows === 1 && SHA.test(row.sha256))
      && SHA.test(snapshot.admissionSha256) && SHA.test(snapshot.sourceInvariantSha256)
      && Array.isArray(snapshot.dailyPasses) && snapshot.dailyPasses.length === 2
      && snapshot.dailyPasses.every((pass) => exact(pass, ["iterations", "outcomes", "filteredIdle"])
        && count(pass.iterations) && pass.iterations > 0 && pass.iterations <= FORCED_DAILY_CONVERGENCE_BOUND && pass.filteredIdle === true
        && exact(pass.outcomes, ["published", "unchanged", "progress", "conflicts"])
        && Object.values(pass.outcomes).every(count) && pass.outcomes.conflicts === 2
        && pass.iterations === 1 + Object.values(pass.outcomes).reduce((n, value) => n + value, 0)));
    const fence = snapshot.fence, selector = snapshot.selector;
    requireFact(exact(fence, ["authority", "journalMax", "cursorSequence", "cursorReceipt", "sourceTerminalEpoch",
      "deliveredTerminalEpoch", "pendingErasureJobs", "cacheIdle"])
      && validAuthority(fence.authority) && count(fence.journalMax) && fence.journalMax > 0
      && fence.cursorSequence === fence.journalMax && fence.authority.sequence === fence.journalMax
      && fence.cursorReceipt === true && count(fence.sourceTerminalEpoch) && count(fence.deliveredTerminalEpoch)
      && fence.deliveredTerminalEpoch >= fence.sourceTerminalEpoch && fence.pendingErasureJobs === 0 && fence.cacheIdle === true
      && exact(selector, ["filteredIdle", "unfiltered"]) && selector.filteredIdle === true
      && exact(selector.unfiltered, ["state", "reason", "ownersAdvanced", "day"])
      && selector.unfiltered.state === "deferred" && selector.unfiltered.reason === "projection_pending"
      && selector.unfiltered.ownersAdvanced === 0 && corpus.conflictDays.includes(selector.unfiltered.day));
  }
  const before = value.beforeRecompute, after = value.afterRecompute;
  requireFact(isDeepStrictEqual(before.retainedQueue, after.retainedQueue)
    && isDeepStrictEqual(before.conflictEvidence, after.conflictEvidence)
    && before.admissionSha256 === after.admissionSha256 && before.sourceInvariantSha256 === after.sourceInvariantSha256
    && before.dailyPasses.reduce((n, pass) => n + pass.iterations, 0) <= INITIAL_DAILY_CONVERGENCE_BOUND
    && after.dailyPasses.reduce((n, pass) => n + pass.iterations, 0) <= corpus.expectedDailyDays.length * FORCED_DAILY_PER_HEAD_BOUND
    && isDeepStrictEqual(after.fence.authority, { ...before.fence.authority,
      collectionRevision: before.fence.authority.collectionRevision + 1 })
    && isDeepStrictEqual({ ...before.fence, authority: null }, { ...after.fence, authority: null }));
  return value;
}

export function validateCurrentQ1StrictExportRefusal(value) {
  requireFact(exact(value, ["schemaVersion", "actual", "code", "reasons", "queueRows"])
    && value.schemaVersion === "current-q1-d1-strict-export-refusal-v1" && value.actual === true
    && value.code === "ANALYTICS_EXPORT_NOT_QUIESCENT" && isDeepStrictEqual(value.reasons, ["queue_rows"])
    && value.queueRows === 2);
  return value;
}

export function validateCurrentQ1Recomputation(value, corpus) {
  validateCorpus(corpus);
  requireFact(exact(value, ["schemaVersion", "actual", "liveCohort", "importSelection", "dailyForced", "graphForced",
    "cacheRetention", "collectionRevision", "sourceInvariantSha256", "invocations", "controlTransition", "graphExecution"])
    && value.schemaVersion === "current-q1-d1-recomputation-v1" && value.actual === true
    && exact(value.liveCohort, ["members", "sha256"]) && value.liveCohort.members === 4 && SHA.test(value.liveCohort.sha256)
    && exact(value.collectionRevision, ["before", "after"]) && count(value.collectionRevision.before)
    && value.collectionRevision.before > 0 && value.collectionRevision.after === value.collectionRevision.before + 1
    && exact(value.sourceInvariantSha256, ["before", "after"]) && SHA.test(value.sourceInvariantSha256.before)
    && value.sourceInvariantSha256.after === value.sourceInvariantSha256.before
    && exact(value.invocations, ["daily", "graph", "cacheResume", "cacheRebuild"])
    && Object.values(value.invocations).every((n) => count(n) && n > 0)
    && value.invocations.daily <= corpus.expectedDailyDays.length * FORCED_DAILY_PER_HEAD_BOUND
    && value.invocations.graph <= GRAPH_INVOCATION_BOUND
    && value.invocations.cacheResume <= CACHE_PASS_BOUND && value.invocations.cacheRebuild <= CACHE_PASS_BOUND
    && exact(value.controlTransition, ["beforeSha256", "afterSha256", "auditRowsBefore", "auditRowsAfter",
      "auditSequenceBefore", "auditSequenceAfter"])
    && SHA.test(value.controlTransition.beforeSha256) && SHA.test(value.controlTransition.afterSha256)
    && value.controlTransition.beforeSha256 !== value.controlTransition.afterSha256
    && count(value.controlTransition.auditRowsBefore) && value.controlTransition.auditRowsAfter === value.controlTransition.auditRowsBefore + 1
    && count(value.controlTransition.auditSequenceBefore)
    && value.controlTransition.auditSequenceAfter === value.controlTransition.auditSequenceBefore + 1);
  requireFact(exact(value.graphExecution, ["state", "reason", "iterations", "quiet", "rotation"])
    && value.graphExecution.iterations === value.invocations.graph && value.graphExecution.iterations <= GRAPH_INVOCATION_BOUND
    && value.graphExecution.rotation === 30
    && count(value.graphExecution.quiet) && value.graphExecution.quiet <= value.graphExecution.iterations
    && ((value.graphExecution.state === "converged" && value.graphExecution.reason === "quiet_rotation"
      && value.graphExecution.quiet === value.graphExecution.rotation)
      || (value.graphExecution.state === "unresolved" && value.graphExecution.reason === "invocations"
        && value.graphExecution.iterations === 70 * 4 * 64 && value.graphExecution.quiet < value.graphExecution.rotation)));
  requireFact(exact(value.importSelection, ["daily", "modelDays", "preview"])
    && Array.isArray(value.importSelection.daily)
    && isDeepStrictEqual(value.importSelection.daily.map((row) => row?.day), corpus.expectedDailyDays)
    && value.importSelection.daily.every((row) => exact(row, ["day", "revision", "sha256"])
      && count(row.revision) && row.revision > 0 && SHA.test(row.sha256))
    && Array.isArray(value.importSelection.modelDays)
    && value.importSelection.modelDays.every((row) => exact(row, ["day", "sha256"]) && DAY.test(row.day) && SHA.test(row.sha256))
    && (value.importSelection.preview === null || exact(value.importSelection.preview, ["sha256"])
      && SHA.test(value.importSelection.preview.sha256)));
  requireFact(Array.isArray(value.dailyForced) && isDeepStrictEqual(value.dailyForced.map((row) => row?.day), corpus.expectedDailyDays)
    && value.dailyForced.every((row, n) => exact(row, ["day", "cohortDigest", "recomputedSha256", "importedSha256", "d1Drift"])
      && SHA.test(row.cohortDigest) && SHA.test(row.recomputedSha256)
      && row.importedSha256 === value.importSelection.daily[n].sha256
      && row.d1Drift === (row.importedSha256 !== row.recomputedSha256)));
  requireFact(exact(value.graphForced, ["modelDays", "previewSha256"])
    && Array.isArray(value.graphForced.modelDays) && value.graphForced.modelDays.length === 70
    && value.graphForced.modelDays.every((row, n) => exact(row, ["day", "recomputedSha256"])
      && row.day === new Date(Date.parse("2026-10-01") - (69 - n) * 86_400_000).toISOString().slice(0, 10)
      && (row.recomputedSha256 === null || SHA.test(row.recomputedSha256)))
    && (value.graphForced.previewSha256 === null || SHA.test(value.graphForced.previewSha256)));
  requireFact(exact(value.cacheRetention, ["fromDay", "resumeSeriesSha256", "rebuildSeriesSha256", "rebuildTableSha256"])
    && value.cacheRetention.fromDay === null && SHA.test(value.cacheRetention.resumeSeriesSha256)
    && SHA.test(value.cacheRetention.rebuildSeriesSha256)
    && exact(value.cacheRetention.rebuildTableSha256, ["analytics_cache_retention_day_marks", "analytics_cache_retention_day_progress",
      "analytics_cache_retention_day_values", "analytics_cache_retention_day_bands", "analytics_cache_retention_day_carry"])
    && Object.values(value.cacheRetention.rebuildTableSha256).every((sha) => SHA.test(sha)));
  return value;
}

const bindings = (ctx) => ({ source: ctx.ingestion, target: ctx.analytics, sourceId: ctx.sourceId,
  sourceNamespace: ctx.sourceNamespace });

export async function runCurrentQ1DailyConvergence(ctx, corpus, totalBound = 4_096) {
  requireFact(totalBound === INITIAL_DAILY_CONVERGENCE_BOUND || totalBound === FORCED_DAILY_CONVERGENCE_BOUND);
  const dailyPasses = [];
  let remaining = totalBound;
  for (const preferStaleHead of [false, true]) {
    const pass = await runCurrentQ1DailyPass({
    ...corpus, preferStaleHead, advance: (options) => ctx.P.advanceNextStorageCommunityDaily({ ...bindings(ctx),
      ...options, nowMs: ctx.nowMs }), bound: remaining - (preferStaleHead ? 0 : 3),
    onIteration: (iteration) => ctx.progress.counts({ iteration }),
    });
    dailyPasses.push(pass); remaining -= pass.iterations;
  }
  return dailyPasses;
}

/** The retained synthetic fixture cap, not a production scheduled-invocation
 * measurement. This is no larger than initial settle and strictly lower than
 * the historical strict export oracle's 100,000-statement forced-work cap. */
export async function advanceCurrentQ1CachePass(ctx) {
  return ctx.P.advanceCacheRetentionDayLane({ target: ctx.analytics, sourceId: ctx.sourceId,
    build: ctx.P.createCacheRetentionDaySourceBuild({ ...bindings(ctx), now: () => ctx.nowMs }),
    deadlineMs: ctx.nowMs + 1, remainingQueries: 5_000, sourceQueries: 5_000,
    maxDays: 64, maxWrites: 64, now: () => ctx.nowMs, shardIndex: 0, shardCount: 1 });
}

async function completeCache(ctx) {
  for (let iteration = 1; iteration <= CACHE_PASS_BOUND; iteration++) {
    ctx.progress.counts({ iteration });
    const lane = await advanceCurrentQ1CachePass(ctx);
    requireFact(object(lane));
    if (lane.state === "idle") return iteration;
  }
  fail();
}

async function currentSelection(ctx) {
  return ctx.P.readD1AnalyticsImportSelection({ ...bindings(ctx), pinnedNowMs: ctx.nowMs });
}

/** Actual forced work through the current public controls, daily, graph,
 * publication and cache facades. Only derived scratch caches are cleared.
 * Source facts, queue rows, admission proofs and legacy pins are untouched. */
export async function runCurrentQ1Recomputation(ctx, corpus, sourceInvariantSha256) {
  const P = ctx.P, b = bindings(ctx);
  const liveCohort = await P.readD1AnalyticsLiveCohort(ctx.ingestion);
  requireFact(liveCohort.members === 4);
  const selection = await currentSelection(ctx), cacheResume = await completeCache(ctx);
  const resumeSeriesSha256 = await P.sha256Hex(P.canonicalJson(await P.readCacheRetentionCommunitySeries({
    target: ctx.analytics, sourceId: ctx.sourceId, nowMs: ctx.nowMs })));
  const before = await P.readCollectionControls(ctx.ingestion);
  const after = await P.setCollectionControls(ctx.ingestion, "current-q1-reference-scratch", {
    enrollment: before.enrollment, uploadRegistration: before.uploadRegistration,
    processing: before.processing, publication: before.publication,
  }, "drill_restore", before.revision, ctx.nowMs);
  requireFact(after.revision === before.revision + 1 && ["enrollment", "uploadRegistration", "processing", "publication", "state"]
    .every((key) => before[key] === after[key]));
  const controlTransition = await ctx.assertControlTransition(before, after);
  await ctx.analytics.prepare("DELETE FROM analytics_community_daily_owners WHERE source_id=?").bind(ctx.sourceId).run();
  ctx.progress.phase("settle_daily");
  const heads = await ctx.analytics.prepare("SELECT count(*) AS n FROM analytics_community_daily_heads WHERE source_id=?")
    .bind(ctx.sourceId).first("n");
  requireFact(heads === corpus.expectedDailyDays.length);
  const dailyPasses = await runCurrentQ1DailyConvergence(ctx, corpus, Math.max(1, heads) * 64);
  const current = await currentSelection(ctx), imported = new Map(selection.daily.map((row) => [row.day, row.sha256]));
  const rows = (await ctx.analytics.prepare(`SELECT h.day,h.cohort_digest,p.payload_json,p.payload_sha256
    FROM analytics_community_daily_heads h JOIN analytics_community_daily_publications p
    ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision WHERE h.source_id=? ORDER BY h.day`)
    .bind(ctx.sourceId).all()).results;
  requireFact(isDeepStrictEqual(rows.map((row) => row.day), corpus.expectedDailyDays)
    && isDeepStrictEqual(current.daily.map((row) => row.day), corpus.expectedDailyDays));
  const dailyForced = [];
  for (const row of rows) {
    requireFact(SHA.test(row.cohort_digest) && await P.sha256Hex(row.payload_json) === row.payload_sha256);
    const recomputedSha256 = await P.normalizedDailyPayloadSha256(row.payload_json), importedSha256 = imported.get(row.day);
    dailyForced.push({ day: row.day, cohortDigest: row.cohort_digest, recomputedSha256, importedSha256,
      d1Drift: importedSha256 !== recomputedSha256 });
  }
  for (const table of GRAPH_CACHES) requireFact(await ctx.analytics.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").bind(table).first() !== null);
  await ctx.analytics.batch(GRAPH_CACHES.map((table) => ctx.analytics.prepare(`DELETE FROM ${table}`)));
  ctx.progress.phase("oracle");
  const rotation = 6 * liveCohort.members + 6;
  let quiet = 0, graphIterations = 0;
  for (let iteration = 1; iteration <= GRAPH_INVOCATION_BOUND; iteration++) {
    graphIterations = iteration; ctx.progress.counts({ iteration });
    const graph = await P.advanceStorageCommunityGraphWork({ ...b, nowMs: ctx.nowMs, preparedFold: false });
    let changed = graph.state !== "reused" && graph.state !== "idle";
    if (graph.state === "complete" || graph.state === "reused") {
      if (graph.metric === "model" && graph.day) {
        if ((await P.publishStorageCommunityModelDay(b, { day: graph.day, nowMs: ctx.nowMs })).state === "published") changed = true;
      }
      if ((await P.publishStorageCommunityGraphPreview(b, { nowMs: ctx.nowMs })).state === "published") changed = true;
    }
    if (await P.retireStorageCommunityGraphPublications(b, ctx.nowMs) > 0) changed = true;
    quiet = changed ? 0 : quiet + 1;
    if (quiet >= rotation) break;
  }
  // Keep a non-qualifying record when the original bound is exhausted. Native
  // probes may explain missing scopes but cannot waive this convergence gate.
  const graphExecution = { state: quiet >= rotation ? "converged" : "unresolved",
    reason: quiet >= rotation ? "quiet_rotation" : "invocations", iterations: graphIterations, quiet, rotation };
  const graphSelection = await currentSelection(ctx), models = new Map(graphSelection.modelDays.map((row) => [row.day, row.sha256]));
  const graphForced = { modelDays: P.analyticsHistoryGraphWindow(ctx.nowMs).map((day) => ({ day,
    recomputedSha256: models.get(day) ?? null })), previewSha256: graphSelection.preview?.sha256 ?? null };
  for (const table of P.ANALYTICS_HISTORY_CACHE_RETENTION_TABLES) requireFact(await ctx.analytics.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").bind(table).first() !== null);
  await ctx.analytics.batch(P.ANALYTICS_HISTORY_CACHE_RETENTION_TABLES.map((table) => ctx.analytics.prepare(`DELETE FROM ${table}`)));
  ctx.progress.phase("settle_cache");
  const cacheRebuild = await completeCache(ctx), rebuildTableSha256 = {};
  for (const table of P.ANALYTICS_HISTORY_CACHE_RETENTION_TABLES) {
    rebuildTableSha256[table] = (await P.canonicalD1TableDigest(ctx.analytics, table)).sha256;
  }
  const rebuilt = await P.readCacheRetentionCommunitySeries({ target: ctx.analytics, sourceId: ctx.sourceId, nowMs: ctx.nowMs });
  const afterSourceSha256 = await ctx.sourceInvariant();
  const recomputation = { schemaVersion: "current-q1-d1-recomputation-v1", actual: true, liveCohort,
    importSelection: { daily: selection.daily, modelDays: selection.modelDays, preview: selection.preview },
    dailyForced, graphForced, graphExecution, cacheRetention: { fromDay: null, resumeSeriesSha256,
      rebuildSeriesSha256: await P.sha256Hex(P.canonicalJson(rebuilt)), rebuildTableSha256 },
    collectionRevision: { before: before.revision, after: after.revision }, controlTransition,
    sourceInvariantSha256: { before: sourceInvariantSha256, after: afterSourceSha256 },
    invocations: { daily: dailyPasses.reduce((n, pass) => n + pass.iterations, 0), graph: graphIterations,
      cacheResume, cacheRebuild } };
  validateCurrentQ1Recomputation(recomputation, corpus);
  return { recomputation, dailyPasses };
}

/** Strict export negative proof is an actual invocation. Any success, other
 * code/reason, or callback beyond the fence phase is a failed qualification. */
export async function proveCurrentQ1StrictExportRefusal(ctx, moduleDigest) {
  const steps = [];
  try {
    await ctx.P.runD1AnalyticsExportOracle({ ingestion: ctx.ingestion, analytics: ctx.analytics, ledger: ctx.ledger,
      pinnedNowMs: ctx.nowMs, sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace,
      cacheRetentionFromDay: null, foldHistory: [{ value: "disabled", fromMs: 1_700_000_000_000, untilMs: null }],
      moduleDigest, onStep: (step) => { steps.push(step); } });
  } catch (error) {
    requireFact(error instanceof ctx.P.D1AnalyticsExportOracleError
      && error.code === "ANALYTICS_EXPORT_NOT_QUIESCENT" && isDeepStrictEqual(error.reasons, ["queue_rows"])
      && isDeepStrictEqual(steps, ["fence"]));
    return validateCurrentQ1StrictExportRefusal({ schemaVersion: "current-q1-d1-strict-export-refusal-v1",
      actual: true, code: error.code, reasons: [...error.reasons], queueRows: 2 });
  }
  fail();
}

export const currentQ1SyntheticProofDigest = digest;
