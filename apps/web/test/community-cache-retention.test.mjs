import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMUNITY_CACHE_RETENTION_BANDS,
  COMMUNITY_CACHE_RETENTION_SCHEMA_VERSION,
  normalizeCommunityDailySeries,
} from "../public/community-data.js";
import { renderCommunityDailySeries } from "../public/community-view.js";
import { WEB_MESSAGES, translate } from "../public/localization.js";

// Synthetic presentation data only. No published or private session evidence
// reaches this file.
function band(index, overrides = {}) {
  const { band: id, startMs, endMs } = COMMUNITY_CACHE_RETENTION_BANDS[index];
  return {
    band: id,
    startMs,
    ...(endMs === null ? { endMs: null } : { endMs }),
    adjacencies: 1894,
    sessions: 120,
    contributors: 7,
    reusedMoreThanHalfRate: 0.989,
    matchedOrExceededRate: 0.93,
    topContributorShare: 0.42,
    excludedInsufficientEvidence: 0,
    excludedContextContracted: 0,
    unorderedTies: 0,
    ...overrides,
  };
}

// A band the lane published with nothing in it: counts at zero, rates null.
// "No gap was measured" and "the cache was not reused" are different claims.
function emptyBand(index, overrides = {}) {
  return band(index, {
    adjacencies: 0,
    sessions: 0,
    contributors: 0,
    reusedMoreThanHalfRate: null,
    matchedOrExceededRate: null,
    topContributorShare: null,
    ...overrides,
  });
}

function retention(overrides = {}) {
  return {
    schemaVersion: COMMUNITY_CACHE_RETENTION_SCHEMA_VERSION,
    metric: "cache_retention_by_pause",
    methodVersion: "cache-retention-v2",
    measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end",
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) => band(index)),
    ...overrides,
  };
}

function series(block) {
  const day = "2026-09-05";
  return {
    schemaVersion: "community-daily-read-v1.0",
    from: day,
    to: day,
    allowanceState: "updating",
    ...(block === undefined ? {} : { cacheRetention: block }),
    days: [{
      day,
      revision: 1,
      releasedAt: `${day}T00:00:00.000Z`,
      payload: {
        schemaVersion: "community-daily-aggregate-v1.0",
        policyVersion: "community-daily-v1.0",
        immutableRevision: true,
        recomputesOnLateData: true,
        day,
        revision: 1,
        totals: {
          contributingParticipants: 1,
          contributingDevices: 1,
          usageEvents: 2,
          quotaObservations: 0,
          sessionDimensions: 0,
          inputUncachedTokens: 100,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTextTokens: 25,
          outputReasoningTokens: 0,
          outputCombinedTokens: 25,
        },
      },
    }],
  };
}

/** The smallest element shape the renderer actually touches. */
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren() {
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)]
      .filter((value) => value !== "")
      .join(" ");
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function fakeDocument(lang = "en-US") {
  return {
    documentElement: { lang },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (namespace, tag) => new FakeElement(tag),
  };
}

function render(block, lang = "en-US") {
  const documentRef = fakeDocument(lang);
  const container = documentRef.createElement("div");
  renderCommunityDailySeries({ documentRef, container, payload: series(block) });
  return { documentRef, container };
}

// The lane's own disclosure is the last one appended, so the existing day
// breakdown stays the first `details` in the container.
function retentionDisclosure(container) {
  return container.descendants().filter((element) => element.tag === "details").at(-1);
}

function retentionRows(container) {
  const disclosure = retentionDisclosure(container);
  const body = disclosure?.descendants().find((element) => element.tag === "tbody");
  return body?.children ?? [];
}

test("the published cache-retention block is a community-wide field beside the series state, never per day", () => {
  const value = normalizeCommunityDailySeries(series(retention()));
  assert.equal(value.state, "published");
  assert.equal(value.days.length, 1);
  assert.equal(Object.hasOwn(value.days[0], "cacheRetention"), false);
  assert.equal(value.cacheRetention.gapBasis, "response_end_to_response_end");
  assert.equal(value.cacheRetention.measures, "consecutive_requests");
  assert.equal(value.cacheRetention.methodVersion, "cache-retention-v2");
  assert.deepEqual(
    value.cacheRetention.bands.map((entry) => entry.band),
    COMMUNITY_CACHE_RETENTION_BANDS.map((entry) => entry.band),
  );
  assert.deepEqual(value.cacheRetention.bands[0], {
    band: "under_one_minute", startMs: 0, endMs: 60_000,
    adjacencies: 1894, sessions: 120, contributors: 7,
    reusedMoreThanHalfRate: 0.989, matchedOrExceededRate: 0.93,
    topContributorShare: 0.42,
    excludedInsufficientEvidence: 0, excludedContextContracted: 0, unorderedTies: 0,
  });
  // The final band is CLOSED at the seven-day lookback. A null there would
  // claim an unbounded band the lane cannot measure, so it is rejected, and
  // the exact bound has to survive normalization.
  assert.equal(value.cacheRetention.bands.at(-1).endMs, 604_800_000);
});

test("an absent block leaves the rest of the daily series untouched and renders no lane", () => {
  const value = normalizeCommunityDailySeries(series(undefined));
  assert.equal(value.state, "published");
  assert.equal(value.cacheRetention, null);
  assert.equal(value.days[0].totals.usageEvents, 2);

  const { container } = render(undefined);
  assert.equal(
    container.descendants().filter((element) => element.tag === "details").length,
    1,
    "only the existing day breakdown is rendered",
  );
  assert.doesNotMatch(container.text, /Cache retention by pause length/u);
  // An unpublished lane must not become a claim about cache behaviour.
  assert.doesNotMatch(container.text, /Reused over half|Gaps measured/u);
});

test("a band with no measured gap renders as no evidence, not as a zero reuse rate", () => {
  const empty = retention({
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) =>
      index === 9 ? emptyBand(index) : band(index)),
  });
  const value = normalizeCommunityDailySeries(series(empty));
  assert.equal(value.cacheRetention.bands[9].reusedMoreThanHalfRate, null);
  assert.equal(value.cacheRetention.bands[9].matchedOrExceededRate, null);
  assert.equal(value.cacheRetention.bands[9].topContributorShare, null);

  const { container } = render(empty);
  const rows = retentionRows(container);
  assert.equal(rows.length, 10, "every published band is listed, including the empty one");
  const emptyRow = rows[9];
  assert.equal(emptyRow.children[0].textContent, "24 hours to 7 days");
  assert.equal(emptyRow.children[1].textContent, "—");
  assert.equal(emptyRow.children[2].textContent, "—");
  assert.equal(emptyRow.children[3].textContent, "0", "the measured-gap count is a real zero");
  assert.equal(emptyRow.children[6].textContent, "—");
  assert.doesNotMatch(emptyRow.text, /0%/u, "an unmeasured band never reads as 0% reuse");
  assert.match(
    retentionDisclosure(container).text,
    /A dash means no gap of that length was measured\. It is not a reuse rate of 0%\./u,
  );

  // A measured zero is a different claim and keeps its own glyph.
  const measuredZero = retention({
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) => index === 9
      ? band(index, { reusedMoreThanHalfRate: 0, matchedOrExceededRate: 0 })
      : band(index)),
  });
  assert.equal(retentionRows(render(measuredZero).container)[9].children[1].textContent, "0%");
});

test("thin and concentrated bands stay visible with their source count and largest share", () => {
  const thin = retention({
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) => index === 4
      ? band(index, {
        adjacencies: 6, sessions: 2, contributors: 1,
        reusedMoreThanHalfRate: 0.5, matchedOrExceededRate: 0.5, topContributorShare: 1,
      })
      : band(index)),
  });
  const { container } = render(thin);
  const row = retentionRows(container)[4];
  assert.equal(row.children[0].textContent, "10–30 minutes");
  assert.equal(row.children[3].textContent, "6");
  assert.equal(row.children[5].textContent, "1", "the source count is shown, not suppressed");
  assert.equal(row.children[6].textContent, "100%");
  assert.match(retentionDisclosure(container).text, /Sources counts the distinct participants/u);
});

test("the measurement caveats travel with the rates and never claim a usable short-pause answer", () => {
  const disclosure = retentionDisclosure(render(retention()).container);
  assert.match(
    disclosure.text,
    /Each row groups the gaps between two consecutive requests, not the pauses between your turns\./u,
  );
  assert.match(
    disclosure.text,
    /measured from the end of one response to the end of the next/u,
  );
  assert.match(
    disclosure.text,
    /the bands under ten minutes do not answer how long you can wait; the bands from ten minutes up do/u,
  );
});

test("set-aside evidence is reported rather than folded into the rates", () => {
  const excluded = retention({
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) => index === 0
      ? band(index, {
        excludedInsufficientEvidence: 3,
        excludedContextContracted: 1,
        unorderedTies: 2,
      })
      : band(index)),
  });
  const value = normalizeCommunityDailySeries(series(excluded));
  assert.equal(value.cacheRetention.bands[0].excludedInsufficientEvidence, 3);
  assert.equal(value.cacheRetention.bands[0].unorderedTies, 2);
  assert.match(
    retentionDisclosure(render(excluded).container).text,
    /Excluded before these rates: 3 without enough evidence, 1 where the context contracted, and 2 unordered ties\./u,
  );
  // Nothing to report stays silent rather than printing a row of zeroes.
  assert.doesNotMatch(
    retentionDisclosure(render(retention()).container).text,
    /Excluded before these rates/u,
  );
});

test("a malformed block is refused whole and never partially trusted", () => {
  const reordered = retention().bands.slice();
  [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  const invalid = [
    null,
    [],
    "cache-retention",
    retention({ schemaVersion: "community-cache-retention-v2.0" }),
    retention({ metric: "cache_retention_by_turn" }),
    retention({ measures: "user_turns" }),
    retention({ gapBasis: "request_start_to_request_start" }),
    retention({ methodVersion: "unknown" }),
    retention({ methodVersion: 2 }),
    retention({ bands: reordered }),
    retention({ bands: retention().bands.slice(0, 9) }),
    retention({ bands: [...retention().bands, band(9)] }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 1 ? { ...entry, startMs: 61_000 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 1 ? { ...entry, endMs: 130_000 } : entry) }),
    // No band may omit or null its end, the last one included.
    retention({ bands: retention().bands.map((entry, index) =>
      index === 1 ? { ...entry, endMs: null } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 9 ? { ...entry, endMs: 172_800_000 } : entry) }),
    // Rates are null exactly when nothing was measured; neither side may drift.
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, reusedMoreThanHalfRate: null } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...emptyBand(index), reusedMoreThanHalfRate: 0 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, matchedOrExceededRate: 1.2 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, reusedMoreThanHalfRate: "0.9" } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, matchedOrExceededRate: Number.NaN } : entry) }),
    // Counts are whole, non-negative, and cannot describe more participants
    // than sessions or evidence-free bands with contributors.
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, adjacencies: -1 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, sessions: 1.5 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, contributors: 121 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...emptyBand(index), contributors: 1 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, excludedContextContracted: -1 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, unorderedTies: undefined } : entry) }),
    // A largest share cannot be zero, exceed the whole, or exist with nobody.
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, topContributorShare: 0 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...entry, topContributorShare: 1.01 } : entry) }),
    retention({ bands: retention().bands.map((entry, index) =>
      index === 0 ? { ...emptyBand(index), topContributorShare: 0.5 } : entry) }),
  ];
  for (const block of invalid) {
    const value = normalizeCommunityDailySeries(series(block));
    assert.equal(value.state, "published", JSON.stringify(block)?.slice(0, 80));
    assert.equal(value.cacheRetention, null, JSON.stringify(block)?.slice(0, 80));
    assert.equal(value.days[0].totals.inputUncachedTokens, 100);
    assert.equal(
      render(block).container.descendants().filter((element) => element.tag === "details").length,
      1,
    );
  }
});

test("the lane uses a fresh public allowlist and never returns private canaries", () => {
  const canary = "synthetic-private-canary";
  const block = retention({
    privateDiagnostic: { account: canary },
    bands: COMMUNITY_CACHE_RETENTION_BANDS.map((_, index) =>
      band(index, { sourceThreadPath: canary })),
  });
  const value = normalizeCommunityDailySeries(series(block));
  assert.deepEqual(value.cacheRetention, normalizeCommunityDailySeries(series(retention())).cacheRetention);
  assert.equal(JSON.stringify(value).includes(canary), false);
  assert.equal(render(block).container.text.includes(canary), false);
});

test("the lane's disclosure keeps its open state across refreshes and drops it when the series goes away", () => {
  const documentRef = fakeDocument();
  const container = documentRef.createElement("div");
  const draw = (payload = series(retention())) =>
    renderCommunityDailySeries({ documentRef, container, payload });
  draw();
  const first = retentionDisclosure(container);
  assert.equal(first.open, false);
  first.open = true;
  draw();
  assert.notEqual(retentionDisclosure(container), first);
  assert.equal(retentionDisclosure(container).open, true);
  assert.equal(draw(null), "service_unavailable");
  draw();
  assert.equal(retentionDisclosure(container).open, false, "an unavailable view does not revive old state");
});

test("every band, column and caveat string is translated in all three shipped locales", () => {
  const keys = Object.keys(WEB_MESSAGES)
    .filter((key) => key.startsWith("community.cacheRetention."));
  // An exact count, so a key added without its two translations is caught
  // here rather than shipping as English in every locale.
  assert.equal(keys.length, 25);
  for (const { band: id } of COMMUNITY_CACHE_RETENTION_BANDS) {
    const key = `community.cacheRetention.band.${id.replace(/_(.)/gu, (_, letter) => letter.toUpperCase())}`;
    assert.equal(Object.hasOwn(WEB_MESSAGES, key), true, key);
  }
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    for (const key of keys) {
      const copy = translate(key, { insufficient: "1", contracted: "1", ties: "1" }, locale);
      assert.equal(copy.trim().length > 0, true, `${key} ${locale}`);
      assert.doesNotMatch(copy, /\{[A-Za-z]/u, `${key} ${locale} leaves no placeholder unfilled`);
    }
  }
  const { container } = render(retention(), "es");
  assert.match(retentionDisclosure(container).text, /Retención de caché por duración de la pausa/u);
  assert.match(retentionDisclosure(container).text, /Menos de 1 minuto/u);
  const chinese = render(retention(), "zh-Hans").container;
  assert.match(retentionDisclosure(chinese).text, /按暂停时长划分的缓存保留情况/u);
});
