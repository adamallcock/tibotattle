/**
 * analytics-v2 compute core, community outputs (K-SPLIT): the daily candidates
 * of the queued days and the admin allowance preview, folded from the
 * computed owners' results in owner-digest order. Moved out of compute.ts
 * unchanged in behaviour; compute.ts re-exports the public names.
 *
 * Daily candidates are stamped with the revision a first publication gets
 * (revisionSeed + 1) and releasedAt = nowMs. `payloadSha256` identifies the
 * CONTENT: it is the sha256 of the canonical payload without its revision
 * stamp (aggregateId, revision, releasedAt), so an unchanged day keeps its
 * revision. A-3 restamps a changed day with stampAnalyticsV2DailyPayload.
 *
 * Community aggregate exclusions (N-EXCL, exclusions.ts): an owner excluded on
 * day D is outside D's community cohort, as d43c8f92's weekly builder removed
 * an excluded participant before anything else. It is left out of D's daily
 * fold (values and devices) and out of the preview's day D (its fits in the
 * band, its model result for date D, refused or evaluated); the preview's
 * coverage counts are those of today. Its refusals decide nothing there:
 * D is blocked only by an owner not excluded on D, and an owner without a
 * fit withholds the preview only while it is a member of a day the preview
 * carries (today's cohort for the coverage, each day's cohort for its band
 * and model date). The owner's own rows and refusals are unchanged. With no
 * exclusion the outputs are exactly the fold without them.
 *
 * Saved owner sets (E-OWNERSET, engine v2 design section 6.2; owner decision
 * round 2: past contributions are kept): a queued, unblocked day d folds its
 * saved set S(d) plus every computed owner with non-empty values on d. The
 * computed owners fold exactly as before, in owner-digest order; a member of
 * S(d) this run did not compute, or a computed member whose read for d is
 * empty, folds its current stored contribution in its digest position
 * instead of nothing; a member excluded on d folds nothing. A member whose
 * contribution the run's kernel cannot fold (its values schema or price
 * identity is not current) blocks d (member_contribution_unavailable), which
 * keeps its prior head: never a zero, never a dropped member. With no saved
 * set the fold is byte-for-byte the computed-owners fold. Each candidate
 * carries the day's members after its publication, and, for the first
 * recording of a frozen-window day's set, the bootstrap provenance (owner
 * decision round 7: the participants at GCP's first publication, compared
 * with the frozen export's contributingParticipants).
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityDailyPayload,
  buildCommunityModelCompositionDay,
  publicInputs,
  validCachedAdminCommunityAllowancePreview,
  validateV11DailyProjectionValues,
  type AdminCommunityModelCompositionDay,
  type CachedCommunityModelCompositions,
  type CommunityAllowanceFit,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_OWNER_SET_PROVENANCE,
  type AnalyticsV2DailyCandidate,
  type AnalyticsV2DailyMember,
  type AnalyticsV2Day,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerDigest,
  type AnalyticsV2OwnerSetBootstrap,
  type AnalyticsV2OwnerSetState,
  type AnalyticsV2OwnerSetSummary,
} from "./contract";
import { analyticsV2ExcludedOn, type AnalyticsV2ExclusionInterval } from "./exclusions";

/**
 * Model history dates, newest last: today and the 69 days before it. This is
 * d43c8f92 ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS; the fold checks the built
 * preview against it so a kernel change cannot drift silently.
 */
export const ANALYTICS_V2_MODEL_DATES = 70;

export type AnalyticsV2DailyPublicInputs = ReturnType<typeof publicInputs>;
export type AnalyticsV2DailyPayload = ReturnType<typeof buildCommunityDailyPayload>;

/** A daily candidate plus the revision-free public inputs it was built from. */
export interface AnalyticsV2ComputedDailyCandidate extends AnalyticsV2DailyCandidate {
  readonly payload: AnalyticsV2DailyPayload;
  readonly inputs: AnalyticsV2DailyPublicInputs;
}

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

/**
 * A daily payload's content identity: sha256 of its canonical JSON without the
 * revision stamp (aggregateId, revision, releasedAt). Equal for every stamp of
 * the same content, so A-3 and A-4 can verify a stored row against it.
 */
export async function analyticsV2DailyContentSha256(payload: AnalyticsV2DailyPayload): Promise<string> {
  const { aggregateId: _aggregateId, revision: _revision, releasedAt: _releasedAt, ...content } = payload;
  return sha256Hex(canonicalJson(content));
}

/**
 * The payload A-3 publishes for `candidate` under a given revision and
 * release time. The content (and so payloadSha256) is unchanged; only the
 * kernel's revision stamp (aggregateId, revision, releasedAt) differs.
 */
export async function stampAnalyticsV2DailyPayload(candidate: AnalyticsV2ComputedDailyCandidate,
  stamp: { revision: number; releasedAt: string }): Promise<AnalyticsV2DailyPayload> {
  if (!Number.isSafeInteger(stamp.revision) || stamp.revision < 1 || typeof stamp.releasedAt !== "string"
    || !Number.isFinite(Date.parse(stamp.releasedAt))
    || new Date(Date.parse(stamp.releasedAt)).toISOString() !== stamp.releasedAt) {
    throw new TypeError("ANALYTICS_V2_DAILY_STAMP_INVALID");
  }
  const payload = buildCommunityDailyPayload({ day: candidate.day, revision: stamp.revision,
    releasedAt: stamp.releasedAt, ...candidate.inputs });
  if (await analyticsV2DailyContentSha256(payload) !== candidate.payloadSha256) {
    throw new Error("ANALYTICS_V2_DAILY_CONTENT_CHANGED");
  }
  return payload;
}

/** The community fold's inputs: every computed owner's results, merged in owner-digest order. */
export interface AnalyticsV2CommunityInput {
  readonly nowMs: number;
  readonly revisionSeed: number;
  readonly queued: readonly AnalyticsV2Day[];
  /**
   * queued day -> every owner that blocks it (a refused owner-day, the memory
   * budget, non-effective typed evidence), whether or not it is excluded.
   */
  readonly blockers: ReadonlyMap<AnalyticsV2Day, ReadonlySet<AnalyticsV2OwnerDigest>>;
  /** queued day -> computed owner -> unfinalized daily values (owners in digest order). */
  readonly dailyValues: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>;
  /** Effective owners that were computed (admitted by the memory budget), in digest order. */
  readonly computedOwners: readonly AnalyticsV2Owner[];
  readonly effectiveDigests: readonly AnalyticsV2OwnerDigest[];
  readonly devicesByDay: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, number>>;
  readonly fitsByOwner: ReadonlyMap<AnalyticsV2OwnerDigest, readonly CommunityAllowanceFit[]>;
  readonly modelDates: readonly AnalyticsV2Day[];
  readonly compositionsByDate: ReadonlyMap<AnalyticsV2Day,
    ReadonlyArray<{ readonly ownerDigest: string; readonly result: V1ModelCompositionResult }>>;
  /**
   * model date -> effective owners whose evaluation the kernels refused, in
   * digest order. (A memory-refused owner has no fit, so the preview that
   * carries the model dates is withheld for the run; it is never listed here.)
   */
  readonly modelRefusedByDate: ReadonlyMap<AnalyticsV2Day, readonly AnalyticsV2OwnerDigest[]>;
  /** computed owner -> its active community aggregate exclusions (N-EXCL; absent: none). */
  readonly exclusions: ReadonlyMap<AnalyticsV2OwnerDigest, readonly AnalyticsV2ExclusionInterval[]>;
  /**
   * E-OWNERSET: every queued day's saved set and the frozen counts
   * (owner-sets.ts), and the stored values of the contributions this fold
   * needs, keyed by analyticsV2ContributionKey (a needed key that is absent
   * makes its day unavailable).
   */
  readonly ownerSets: AnalyticsV2OwnerSetState;
  readonly savedValues: ReadonlyMap<string, unknown>;
}

/** analyticsV2ContributionKey without the I/O module (owner-sets.ts holds the same construction). */
export function analyticsV2SavedValueKey(day: AnalyticsV2Day, ownerDigest: AnalyticsV2OwnerDigest,
  version: number): string {
  return `${day}\u0001${ownerDigest}\u0001${version}`;
}

/** True when the values carry at least one record (publicInputs counts the owner as a participant). */
export function analyticsV2ValuesNonEmpty(value: V11DailyProjectionValues): boolean {
  return value.counts.usage + value.counts.quota + value.counts.session > 0;
}

/**
 * A stored contribution the run's kernel can fold for `day`: the current
 * daily-values contract (schema, pricing method and price registry, which
 * validateV11DailyProjectionValues pins), the same day, and at least one
 * record. Anything else is unavailable (K-REPRICE reprices it after cutover).
 */
function foldableContribution(value: unknown, day: AnalyticsV2Day): V11DailyProjectionValues | null {
  try {
    validateV11DailyProjectionValues(value);
  } catch {
    return null;
  }
  const values = value as V11DailyProjectionValues;
  return values.day === day && analyticsV2ValuesNonEmpty(values) ? values : null;
}

/**
 * The saved contributions a fold of `queued` needs: per day, every member of
 * S(d) not excluded on d that this run did not compute, or computed with
 * empty values on d. Shared by computeAnalyticsV2 (to load them) and the fold.
 */
export function analyticsV2NeededContributions(input: {
  readonly queued: readonly AnalyticsV2Day[];
  readonly ownerSets: AnalyticsV2OwnerSetState;
  readonly computedOwners: readonly AnalyticsV2Owner[];
  readonly dailyValues: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>;
  readonly exclusions: ReadonlyMap<AnalyticsV2OwnerDigest, readonly AnalyticsV2ExclusionInterval[]>;
}): Array<{ readonly day: AnalyticsV2Day; readonly ownerDigest: AnalyticsV2OwnerDigest; readonly version: number }> {
  const computed = new Set(input.computedOwners.map((owner) => owner.ownerDigest));
  const needed: Array<{ day: AnalyticsV2Day; ownerDigest: AnalyticsV2OwnerDigest; version: number }> = [];
  for (const day of input.queued) {
    const saved = input.ownerSets.days.get(day);
    if (saved === undefined) continue;
    for (const [ownerDigest, member] of [...saved.members].sort(([left], [right]) => (left < right ? -1 : 1))) {
      if (analyticsV2ExcludedOn(input.exclusions.get(ownerDigest), day)) continue;
      if (computed.has(ownerDigest)) {
        const fresh = input.dailyValues.get(day)?.get(ownerDigest);
        if (fresh !== undefined && analyticsV2ValuesNonEmpty(fresh)) continue;
      }
      needed.push({ day, ownerDigest, version: member.version });
    }
  }
  return needed;
}

/**
 * The queued days' daily candidates, the days the community could not publish
 * (blockedDays, ascending) and the preview (or null when it is withheld).
 */
export async function buildAnalyticsV2Community(input: AnalyticsV2CommunityInput): Promise<{
  readonly dailyCandidates: AnalyticsV2ComputedDailyCandidate[];
  readonly blockedDays: AnalyticsV2Day[];
  readonly preview: unknown;
  readonly ownerSets: AnalyticsV2OwnerSetSummary;
}> {
  const nowIso = new Date(input.nowMs).toISOString();
  const computedOwners = input.computedOwners;
  const excluded = (ownerDigest: AnalyticsV2OwnerDigest, day: AnalyticsV2Day): boolean =>
    analyticsV2ExcludedOn(input.exclusions.get(ownerDigest), day);
  // A day is blocked for the community only by an owner of its cohort: an
  // owner excluded on it (N-EXCL) keeps its own refusals but decides nothing.
  const blockedDays = input.queued.filter((day) =>
    [...input.blockers.get(day) ?? []].some((ownerDigest) => !excluded(ownerDigest, day)));
  const blocked = new Set(blockedDays);
  const dailyCandidates: AnalyticsV2ComputedDailyCandidate[] = [];
  const computedDigests = new Set(computedOwners.map((owner) => owner.ownerDigest));
  const memberContributionUnavailableDays: AnalyticsV2Day[] = [];
  let contributionRetainedEvidenceAbsent = 0;
  let savedMembersFolded = 0;
  for (const day of input.queued) {
    if (blocked.has(day)) continue;
    const byOwner = input.dailyValues.get(day)!;
    const saved = input.ownerSets.days.get(day)?.members ?? new Map();
    // A memory-refused owner blocks every queued day it has evidence on, so
    // on an unblocked day it has none or is excluded: either way it adds
    // nothing (publicInputs adds nothing for an owner without records), and
    // if it is a member of S(d) it folds its saved contribution. An owner
    // excluded on the day (N-EXCL) is left out of its fold, so an excluded
    // owner that blocked it, and so has no values, is never read.
    const digests = [...new Set([...computedDigests, ...saved.keys()])].sort();
    const counted = input.devicesByDay.get(day);
    const values: V11DailyProjectionValues[] = [];
    const devices: number[] = [];
    const members: AnalyticsV2DailyMember[] = [];
    let unavailable = false;
    let retained = 0, folded = 0;
    const foldSaved = (ownerDigest: AnalyticsV2OwnerDigest): boolean => {
      const member = saved.get(ownerDigest)!;
      const stored = foldableContribution(
        input.savedValues.get(analyticsV2SavedValueKey(day, ownerDigest, member.version)), day);
      if (stored === null) return false;
      values.push(stored);
      devices.push(member.devices);
      return true;
    };
    for (const ownerDigest of digests) {
      const member = saved.get(ownerDigest);
      if (excluded(ownerDigest, day)) {
        if (member !== undefined) {
          members.push(Object.freeze({ ownerDigest, origin: "excluded", values: null, devices: null, savedVersion: null }));
        }
        continue;
      }
      if (computedDigests.has(ownerDigest)) {
        const value = byOwner.get(ownerDigest)!;
        if (analyticsV2ValuesNonEmpty(value)) {
          if (counted === undefined) return invalid("devicesByDay.missingDay");
          const owned = counted.get(ownerDigest) ?? 1;
          values.push(value);
          devices.push(owned);
          members.push(Object.freeze({ ownerDigest, origin: "computed", values: value, devices: owned, savedVersion: null }));
        } else if (member !== undefined) {
          // Its read for d is empty: its last contribution is kept, never a zero.
          if (!foldSaved(ownerDigest)) { unavailable = true; break; }
          retained++;
          members.push(Object.freeze({ ownerDigest, origin: "retained", values: null, devices: null,
            savedVersion: member.version }));
        } else {
          // Not a member and nothing on d: folded as before (adds nothing).
          values.push(value);
          devices.push(0);
        }
        continue;
      }
      // A member this run did not compute: its current contribution.
      if (!foldSaved(ownerDigest)) { unavailable = true; break; }
      folded++;
      members.push(Object.freeze({ ownerDigest, origin: "saved", values: null, devices: null,
        savedVersion: member!.version }));
    }
    if (unavailable) {
      memberContributionUnavailableDays.push(day);
      continue;
    }
    contributionRetainedEvidenceAbsent += retained;
    savedMembersFolded += folded;
    const inputs = publicInputs(values, devices);
    const payload = buildCommunityDailyPayload({ day, revision: input.revisionSeed + 1, releasedAt: nowIso, ...inputs });
    // The first recording of a frozen-window day's set (round 7): every
    // member is new, and its count is compared with Cloudflare's.
    let bootstrap: AnalyticsV2OwnerSetBootstrap | null = null;
    const frozen = input.ownerSets.frozen;
    if (saved.size === 0 && input.ownerSets.days.get(day)?.bootstrapped !== true && frozen !== null
        && day >= frozen.fromDay && day <= frozen.throughDay) {
      const frozenParticipants = frozen.participants.get(day) ?? null;
      bootstrap = Object.freeze({
        provenance: frozenParticipants === members.length ? ANALYTICS_V2_OWNER_SET_PROVENANCE.cutoverVerified
          : ANALYTICS_V2_OWNER_SET_PROVENANCE.cutoverDisclosed,
        frozenParticipants,
        frozenExportSha256: frozen.exportSha256,
      });
    }
    dailyCandidates.push(Object.freeze({ day, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
      inputs, members: Object.freeze(members), bootstrap }));
  }
  const ownerSets: AnalyticsV2OwnerSetSummary = Object.freeze({ contributionRetainedEvidenceAbsent, savedMembersFolded,
    memberContributionUnavailableDays: Object.freeze(memberContributionUnavailableDays) });
  const allBlockedDays = memberContributionUnavailableDays.length === 0 ? blockedDays
    : [...blockedDays, ...memberContributionUnavailableDays].sort();

  // d43c8f92 publishStorageCommunityGraphPreview defers (cache_pending)
  // unless every member has a current fits result. An effective owner
  // without one, refused by the kernels or by the memory budget, withholds
  // the preview while it is a member of any day the preview carries: a
  // partial cohort would state coverage counts, a band or a model date that
  // silently omit it. An owner excluded on a day is not that day's member
  // (N-EXCL), so one excluded on every such day withholds nothing.
  const withoutFits = input.effectiveDigests.filter((ownerDigest) => !input.fitsByOwner.has(ownerDigest));
  const memberWithoutFits = (day: AnalyticsV2Day): boolean =>
    withoutFits.some((ownerDigest) => !excluded(ownerDigest, day));
  const today = nowIso.slice(0, 10);
  if (memberWithoutFits(today) || input.modelDates.some(memberWithoutFits)) {
    return { dailyCandidates, blockedDays: allBlockedDays, preview: null, ownerSets };
  }
  const modelDays: AdminCommunityModelCompositionDay[] = [];
  for (const day of input.modelDates) {
    // An owner excluded on this date (N-EXCL) is outside its composition,
    // evaluated or refused.
    const evaluated = input.compositionsByDate.get(day)!.filter(({ ownerDigest }) => !excluded(ownerDigest, day));
    // An effective owner the kernels refused for this date is still a member
    // of its cohort: it is counted as refused, never dropped, even when no
    // owner could be evaluated (owner decision 2026-10-01, D7). A date with
    // no effective member at all is not published.
    const refused = input.modelRefusedByDate.get(day)!.filter((ownerDigest) => !excluded(ownerDigest, day)).length;
    if (evaluated.length === 0 && refused === 0) continue;
    const collection: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: refused,
      unsupportedSourceParticipantCount: 0, refusedParticipantCount: refused, storeAvailable: true };
    for (const { ownerDigest, result } of evaluated) {
      collection.v1ParticipantCount++;
      if (result.status === "ready") collection.compositions.push({ participantId: ownerDigest, composition: result });
      else collection.refusedParticipantCount++;
    }
    modelDays.push(buildCommunityModelCompositionDay(collection, day));
  }
  const models: Parameters<typeof buildAdminCommunityAllowancePreview>[3] = {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays };
  // The preview over the owners not excluded on `day`: its coverage and every
  // band day are computed from that cohort's fits.
  const excludedKey = (day: AnalyticsV2Day): string => computedOwners
    .filter((owner) => excluded(owner.ownerDigest, day)).map((owner) => owner.ownerDigest).join(",");
  const builds = new Map<string, ReturnType<typeof buildAdminCommunityAllowancePreview>>();
  const buildFor = (key: string) => {
    let built = builds.get(key);
    if (built === undefined) {
      const left = new Set(key === "" ? [] : key.split(","));
      const cohortOwners = computedOwners.filter((owner) => !left.has(owner.ownerDigest));
      built = buildAdminCommunityAllowancePreview(
        cohortOwners.flatMap((owner) => input.fitsByOwner.get(owner.ownerDigest)!), input.nowMs,
        cohortOwners.map((owner) => owner.ownerDigest), models);
      if (built.days.length !== ANALYTICS_V2_MODEL_DATES) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
      builds.set(key, built);
    }
    return built;
  };
  // The coverage is today's (the preview's last day), as d43c8f92 counts it.
  const base = buildFor(excludedKey(today));
  // Every band day's cohort has its fits (checked before any of them is built).
  if (base.days.some((previewDay) => memberWithoutFits(previewDay.day))) {
    return { dailyCandidates, blockedDays: allBlockedDays, preview: null, ownerSets };
  }
  // Each band day is its own day's aggregate: an owner excluded on that day
  // only is left out of that day's band. Without exclusions every day comes
  // from the one build, exactly as before.
  const days = base.days.map((previewDay, index) => {
    const own = buildFor(excludedKey(previewDay.day)).days[index]!;
    if (own.day !== previewDay.day) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
    return own;
  });
  const built = days.every((day, index) => day === base.days[index]) ? base
    : Object.freeze({ ...base, days: Object.freeze(days) });
  const preview = validCachedAdminCommunityAllowancePreview(built, built.generatedAt, input.nowMs) ? built : null;
  return { dailyCandidates, blockedDays: allBlockedDays, preview, ownerSets };
}
