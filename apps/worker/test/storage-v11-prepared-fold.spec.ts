import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadStorageHistoryCheckpoint,
  saveStorageHistoryCheckpoint,
  type StorageHistoryKey,
} from "../src/storage-history-checkpoint";
import { createV11QuotaAcquisitionCheckpoint } from "../src/quota-analysis-v11-reader";
import type { StorageV11HistoryCheckpoint } from "../src/storage-v11-history";
import { STORAGE_V11_PREPARED_FOLD, storageV11FoldsPreparedDays,
  storageV11ModelDropsScalar, storageV11PreparedFoldEnabled,
  storageV11UsageSuccessorResumable } from "../src/storage-v11-history";
import {
  STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,
  STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD,
  STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS,
  STORAGE_GRAPH_METHOD,
  STORAGE_GRAPH_V11_CHECKPOINT_METHOD,
  STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD,
  STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD,
  storageGraphV11CheckpointMethod,
  storageGraphV11CheckpointMethods,
  STORAGE_GRAPH_V11_FITS_CHECKPOINT_METHODS,
} from "../src/storage-community-graph";
import { V11_QUOTA_ACQUISITION_VERSION } from "../src/quota-analysis-v11-reader";
import {
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
  V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
} from "../src/quota-analysis-v11";
import { communityAnalysisCacheVersion } from "../src/community-allowance";
import {
  validateV11UsageReductionCheckpoint,
  type V11UsageReductionCheckpoint,
} from "../src/quota-analysis-v11";
import type { GraphDayProjection } from "../src/graph-day-projection-values";

describe("prepared-day fold rollout gate", () => {
  it("is off, and a caller's prepared days do nothing while it is", () => {
    // The paged acquisition still serves every group. The fold is proven by
    // the parity oracle; the switch is thrown at the start of a graph-only
    // long pass, not by deploying this change.
    expect(STORAGE_V11_PREPARED_FOLD).toBe(false);
    const days = [] as unknown as readonly GraphDayProjection[];
    expect(storageV11FoldsPreparedDays(days)).toBe(false);
    expect(storageV11FoldsPreparedDays(undefined)).toBe(false);
    // Both halves are required: the switch alone folds nothing, and days
    // supplied to a build whose switch is off fold nothing either.
    expect(storageV11FoldsPreparedDays(undefined, true)).toBe(false);
    expect(storageV11FoldsPreparedDays(days, true)).toBe(true);
  });
});

describe("prepared-day fold identity boundary", () => {
  it("moves the acquisition checkpoint namespace and nothing else", () => {
    // The fold is byte-identical, so adopting it must not retire a computed
    // day. Only the checkpoint FORMAT changes, and that namespace exists
    // precisely so an in-flight generation can be abandoned without touching
    // published evidence. These are exact strings on purpose: a reviewer can
    // see from the diff of this file alone which identities moved.
    expect(STORAGE_GRAPH_V11_CHECKPOINT_METHOD).toBe(`${STORAGE_GRAPH_METHOD}:v11-shared-checkpoint-4`);
    // While the fold is off both metrics run the IDENTICAL reduction, so
    // splitting the namespace would only throw away the reuse one shared
    // successor gives them. The split is therefore gated on the same flag, and
    // this deploy is inert: the live method is the shared one.
    const off = storageGraphV11CheckpointMethods(false);
    expect(off.fits).toBe(STORAGE_GRAPH_V11_CHECKPOINT_METHOD);
    expect(off.model).toBe(STORAGE_GRAPH_V11_CHECKPOINT_METHOD);
    expect(off.live).toEqual([STORAGE_GRAPH_V11_CHECKPOINT_METHOD]);
    // Once the fold is on the model metric drops the scalar half, so a model
    // successor is not one a fits claim may resume and the two must not share.
    const on = storageGraphV11CheckpointMethods(true);
    expect(on.fits).toBe(`${STORAGE_GRAPH_V11_CHECKPOINT_METHOD}:fits-1`);
    expect(on.model).toBe(`${STORAGE_GRAPH_V11_CHECKPOINT_METHOD}:model-1`);
    expect(on.live).toEqual([on.fits, on.model]);
    // The module-default constants follow the module default, which is off.
    // Production readers do not use them: the deployment switch names their
    // namespace, and `storageGraphV11CheckpointMethod` is what reads it.
    expect(STORAGE_V11_PREPARED_FOLD).toBe(false);
    expect(STORAGE_GRAPH_V11_FIT_CHECKPOINT_METHOD).toBe(off.fits);
    expect(STORAGE_GRAPH_V11_MODEL_CHECKPOINT_METHOD).toBe(off.model);
    // A reader may only build a key under a registered method; retirement
    // reclaims anything else on sight. BOTH configurations are registered,
    // because the switch is a deployment value that can move in either
    // direction while stages are in flight — registering only the current
    // side would reclaim the other side's in-flight work the moment it moved.
    expect([...STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS]).toEqual([
      STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD, STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,
      STORAGE_GRAPH_V11_CHECKPOINT_METHOD, on.fits, on.model]);
  });

  it("leaves every result identity the fold could have retired unchanged", () => {
    // `V11_QUOTA_ACQUISITION_VERSION` feeds the resumable adapter version,
    // which feeds the per-owner graph dependency digest; `STORAGE_GRAPH_METHOD`
    // feeds every source's. A bump to either would recompute days the oracle
    // proves are already correct.
    expect(V11_QUOTA_ACQUISITION_VERSION).toBe("v11-quota-acquisition-2");
    expect(V11_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION)
      .toBe(`${V11_PLAN_ATTRIBUTION_ADAPTER_VERSION}:${V11_QUOTA_ACQUISITION_VERSION}`);
    expect(STORAGE_GRAPH_METHOD).toBe(`${communityAnalysisCacheVersion()}:separate-results-1`);
    // And the checkpoint namespace is a suffix of the result method, not a
    // component of it: reading one never changes the other.
    expect(STORAGE_GRAPH_V11_CHECKPOINT_METHOD.startsWith(`${STORAGE_GRAPH_METHOD}:`)).toBe(true);
    expect(STORAGE_GRAPH_METHOD.includes("v11-shared-checkpoint")).toBe(false);
  });
});

describe("model-only usage reduction", () => {
  const identity = {
    participantId: "synthetic-mode-participant", inputFingerprint: "c".repeat(64),
    sourceMethodVersion: "synthetic-mode", observedAtCutoff: "2026-05-01T00:00:00.000Z",
    resetsAtCutoff: "2026-05-01T00:00:00.000Z", windowMinutes: 10_080, maxQuotaRows: 60_000,
  };
  const reduction = (scalarReduced: boolean,
    patch: Partial<V11UsageReductionCheckpoint> = {}): V11UsageReductionCheckpoint => ({
    version: 1, identity, days: [], dayIndex: 0, cursorTime: identity.observedAtCutoff,
    cursorOccurrence: "", rowsRead: 0, complete: true, scalarReduced,
    commonRefusal: null, scalarRefusal: scalarReduced ? null : "supported_quota_track_unavailable",
    modelRefusal: null, previous: [], hazards: [], scalarBuckets: [], modelCosts: [], poisoned: [],
    usageEventCount: 0, unpricedUsageEventCount: 0, attributionUnresolved: false, ...patch,
  });

  it("marks which half a successor carries, and refuses one that lies about it", () => {
    // The belt-and-braces guard behind the namespace split: even handed a
    // model-only successor, nothing can mistake it for a scalar reduction.
    expect(validateV11UsageReductionCheckpoint(reduction(true))).toBe(true);
    expect(validateV11UsageReductionCheckpoint(reduction(false))).toBe(true);
    // A model-only reduction never built either scalar component, so a
    // successor carrying one was not built in that mode.
    expect(validateV11UsageReductionCheckpoint(reduction(false, {
      scalarBuckets: [{ key: "k", value: { provider: "openai_codex", scope: null, eraKey: "e",
        placement: 0, costNanousd: 0, fullyPriced: true } }] }))).toBe(false);
    expect(validateV11UsageReductionCheckpoint(reduction(false, {
      hazards: [{ key: "all|openai_codex", intervals: [{ start: 0, end: 1 }] }] }))).toBe(false);
    // And the field itself is required, so an older successor cannot be
    // decoded as either mode by omission.
    const { scalarReduced: _omitted, ...without } = reduction(true);
    expect(validateV11UsageReductionCheckpoint(without)).toBe(false);
  });

  it("drops a successor staged under the other mode instead of wedging on it", () => {
    // The healing half. A key whose scalar mode was not fixed by the key
    // itself could already hold a successor in the wrong mode, and the
    // reducer's fence throws on it rather than resuming — so every pass that
    // claimed that row failed in the same place with nothing able to clear it.
    // Seven such model keys reached production and stopped the model lane for
    // twenty hours, because the fence is a correctness backstop and has no
    // recovery path of its own.
    //
    // The caller therefore decides first: a reduction is derived state, so a
    // mode that disagrees is discarded and re-acquired. Redoing pages is a
    // cost; a lane that can never advance is not.
    const modelWantsScalar = !storageV11ModelDropsScalar("model", true);
    expect(modelWantsScalar).toBe(false);
    // The exact production shape: staged with the scalar half, claimed by a
    // folded model pass that has none.
    expect(storageV11UsageSuccessorResumable(reduction(true), modelWantsScalar)).toBe(false);
    // The same successor is still perfectly resumable by the claim that built
    // it, so healing costs nothing when the modes agree.
    expect(storageV11UsageSuccessorResumable(reduction(true), true)).toBe(true);
    expect(storageV11UsageSuccessorResumable(reduction(false), false)).toBe(true);
    // And the reverse direction, which a flag flipped back would produce.
    expect(storageV11UsageSuccessorResumable(reduction(false), true)).toBe(false);
    // Nothing staged is not a mismatch, it is simply a fresh acquisition.
    expect(storageV11UsageSuccessorResumable(null, false)).toBe(false);
    expect(storageV11UsageSuccessorResumable(undefined, true)).toBe(false);
  });

  it("keeps a fits successor and a model successor in different namespaces once the fold is on", () => {
    // The structural half of the same guarantee. While the fold is off the two
    // metrics run the identical reduction and deliberately SHARE one
    // successor, which is the reuse the split would otherwise throw away.
    const key = (method: string) => JSON.stringify(["source", "namespace", "owner", "2026-05-01", method]);
    const off = storageGraphV11CheckpointMethods(false);
    expect(key(off.fits)).toBe(key(off.model));
    const on = storageGraphV11CheckpointMethods(true);
    expect(on.fits).not.toBe(on.model);
    expect(key(on.fits)).not.toBe(key(on.model));
  });
});

describe("a fits claim and a model claim cannot read each other's successor", () => {
  const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
  const target = () => bindings.STORAGE_ANALYTICS_DB;
  const sourceId = "synthetic-metric-split-source", ownerDigest = "a".repeat(64);
  const identity = {
    participantId: "synthetic-metric-split", inputFingerprint: "d".repeat(64),
    sourceMethodVersion: "synthetic-metric-split", observedAtCutoff: "2026-05-01T00:00:00.000Z",
    resetsAtCutoff: "2026-05-01T00:00:00.000Z", windowMinutes: 10_080, maxQuotaRows: 60_000,
  };
  const keyFor = (method: string): StorageHistoryKey => ({ sourceId, ownerDigest, day: "2026-09-05",
    dependencyDigest: "b".repeat(64), sourceNamespace: "synthetic-origin", method });
  const checkpoint = (): StorageV11HistoryCheckpoint => ({ version: 1, source: "v1.1", day: "2026-09-05",
    layout: "typed-v11:synthetic-origin", identity, phase: "acquisition",
    acquisition: createV11QuotaAcquisitionCheckpoint(identity) });

  beforeEach(async () => {
    await reset();
    await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
    await target().prepare("INSERT INTO analytics_owner_state VALUES(?,?,1,1,'active')")
      .bind(sourceId, ownerDigest).run();
  });

  const stage = async (method: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await saveStorageHistoryCheckpoint({ target: target(), key: keyFor(method),
        checkpoint: checkpoint(), expectedHead: null, maxWrites: 4 });
      if (result.status === "saved") return result.headDigest;
    }
    throw new Error("synthetic staging did not finish");
  };
  const read = async (method: string) => {
    for (let attempt = 0; attempt < 140; attempt += 1) {
      const result = await loadStorageHistoryCheckpoint({ target: target(), key: keyFor(method), maxParts: 8 });
      if (result.status !== "deferred") return result;
    }
    throw new Error("synthetic load did not finish");
  };

  it("stages under one metric's method and finds nothing under the other's", async () => {
    // Once the fold is on the model metric's reduction has no scalar half, so
    // its successor must be unreachable from a fits claim and the reverse. The
    // two claims build different keys, so the successor is simply not there —
    // the `scalarReduced` fence behind it never has to fire. Driven from the
    // rule rather than the live constants, which follow the flag.
    const on = storageGraphV11CheckpointMethods(true);
    await stage(on.model);
    expect((await read(on.model)).status).toBe("ready");
    expect((await read(on.fits)).status).toBe("absent");

    await stage(on.fits);
    expect((await read(on.fits)).status).toBe("ready");
    // Staging the fits successor did not disturb the model one.
    expect((await read(on.model)).status).toBe("ready");
    // And nothing is reachable under the shared base they split from.
    expect((await read(STORAGE_GRAPH_V11_CHECKPOINT_METHOD)).status).toBe("absent");
  });
});

describe("the fold's namespace follows the same input as the fold's behaviour", () => {
  it("splits the namespace exactly when the model metric drops the scalar half", () => {
    // THE REGRESSION THIS FILE MISSED. Every other assertion here drives the
    // rule with a literal argument and then checks the module constant, so a
    // deployment that turns the fold on through the ENVIRONMENT satisfied all
    // of them while running the one configuration none of them described:
    // `scalarRequested` followed the runtime flag, the namespace followed the
    // module default, and a model-only successor was staged under the key a
    // fits claim resumes. The scalar-mode fence then failed that resume
    // closed, and the finisher degraded the fits claim to a refusal under an
    // unchanged result identity.
    //
    // So the invariant is stated over the two rules together: for ANY input,
    // the namespace splits if and only if the metrics' reductions diverge.
    for (const foldEnabled of [false, true]) {
      const modelDropsScalar = storageV11ModelDropsScalar("model", foldEnabled);
      const namespacesSplit =
        storageGraphV11CheckpointMethod("fits", foldEnabled)
          !== storageGraphV11CheckpointMethod("model", foldEnabled);
      expect(namespacesSplit).toBe(modelDropsScalar);
      // The fits metric keeps its scalar half under every configuration, so
      // its mode cannot be what splits the namespace.
      expect(storageV11ModelDropsScalar("fits", foldEnabled)).toBe(false);
    }
  });

  it("does not let a pass's prepared-day availability decide the scalar mode", () => {
    // THE SECOND REGRESSION, and the one that reached production. The rule
    // above was already stated, but it was driven with a DEFINED day array, so
    // the one input that breaks it was never supplied: `preparedDays` is
    // `undefined` whenever the builder has not produced that window yet
    // (`incomplete`) or the pass ran short (`budget`). The namespace followed
    // the switch alone while the mode followed the switch AND that per-pass
    // availability, so a model key staged scalar-on before its days existed
    // and resumed scalar-off once they did. The fence then failed every later
    // resume closed and the model lane stopped for good.
    //
    // So the mode must be a function of the same two inputs as the key, and
    // nothing else. Availability is allowed to change how a group is READ, and
    // never which reduction it is.
    const built = [] as unknown as readonly GraphDayProjection[];
    for (const foldEnabled of [false, true]) {
      const expected = storageV11ModelDropsScalar("model", foldEnabled);
      for (const days of [undefined, built]) {
        expect(storageV11ModelDropsScalar("model", foldEnabled)).toBe(expected);
        // The fold gate still reads availability — that is its job — which is
        // exactly why the two rules must not be the same call.
        expect(storageV11FoldsPreparedDays(days, foldEnabled))
          .toBe(foldEnabled && days !== undefined);
      }
    }
  });

  it("reads the deployment switch, not the module default", () => {
    // The env value is the one production sets, so it is the one the namespace
    // rule must be composed with.
    expect(storageV11PreparedFoldEnabled({ GRAPH_DAY_PROJECTION_FOLD: "enabled" })).toBe(true);
    expect(storageV11PreparedFoldEnabled({})).toBe(STORAGE_V11_PREPARED_FOLD);
    const deployed = storageV11PreparedFoldEnabled({ GRAPH_DAY_PROJECTION_FOLD: "enabled" });
    expect(storageGraphV11CheckpointMethod("fits", deployed))
      .not.toBe(storageGraphV11CheckpointMethod("model", deployed));
  });

  it("keeps both configurations' methods live so a flip abandons no stage", () => {
    // Retirement reclaims any stage under an unregistered method ON SIGHT. The
    // switch can move in either direction while stages are in flight, so the
    // methods of BOTH configurations stay registered and those stages age out
    // through the ordinary result-backed path instead.
    for (const foldEnabled of [false, true]) {
      for (const metric of ["fits", "model"] as const) {
        expect(STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS)
          .toContain(storageGraphV11CheckpointMethod(metric, foldEnabled));
      }
    }
    // And a fits stage written under either configuration is still a fits
    // stage when retirement maps its method back to a metric.
    expect([...STORAGE_GRAPH_V11_FITS_CHECKPOINT_METHODS].sort())
      .toEqual([storageGraphV11CheckpointMethod("fits", false),
        storageGraphV11CheckpointMethod("fits", true)].sort());
    expect(STORAGE_GRAPH_V11_FITS_CHECKPOINT_METHODS)
      .not.toContain(storageGraphV11CheckpointMethod("model", true));
  });
});
