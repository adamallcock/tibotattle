import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  COMMUNITY_DAILY_READ_SCHEMA_VERSION,
  COMMUNITY_DAILY_WINDOW_DAYS,
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  PublicCommunityClient,
  communityDailyWindow,
  normalizeCommunityDailySeries,
  normalizeCommunitySnapshot,
} from "../public/community-data.js";
import {
  buildCommunityAllowanceChartModel,
  buildCommunityDailyChartModel,
  communityDailyColumnFormatter,
  renderCommunityAllowanceSection,
  renderCommunityDailySeries,
} from "../public/community-view.js";
import {
  configuredInstallerRelease,
  formatInstallerSize,
  renderInstallerJourney,
} from "../public/install-cta.js";

const SITE_HTML = new URL("../public/community.html", import.meta.url);
const SITE_SOURCE = new URL("../public/community.js", import.meta.url);
const DOCS_HTML = new URL("../public/docs.html", import.meta.url);
const PRIVACY_HTML = new URL("../public/privacy.html", import.meta.url);
const APP_HTML = new URL("../public/index.html", import.meta.url);
const APP_SOURCE = new URL("../public/app.js", import.meta.url);

/**
 * The smallest element shape the two shared renderers actually use. Keeping it
 * this small makes it obvious that the renderers touch nothing else, and lets
 * these assertions exercise real rendering rather than matching source text.
 */
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.hidden = false;
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

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "href") delete this.href;
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

function fakeDocument(metaContent = {}) {
  const byId = new Map();
  return {
    documentElement: { lang: "en-US" },
    createElement(tag) {
      return new FakeElement(tag);
    },
    createElementNS(namespace, tag) {
      return new FakeElement(tag);
    },
    querySelector(selector) {
      const meta = selector.match(/^meta\[name="([^"]+)"\]$/u);
      if (meta) {
        const content = metaContent[meta[1]];
        return content === undefined
          ? null
          : { getAttribute: () => content };
      }
      const id = selector.match(/^#([\w-]+)$/u);
      if (!id) throw new Error(`unexpected selector: ${selector}`);
      if (!byId.has(id[1])) byId.set(id[1], new FakeElement("div"));
      return byId.get(id[1]);
    },
    byId,
  };
}

function publishedSnapshot(overrides = {}) {
  const releasedTokens = {
    status: "released",
    value: 100_000,
    unit: "tokens_rounded_down",
  };
  return {
    schemaVersion: COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
    releaseStatus: "published",
    snapshotId: "community-week:2026-07-13",
    period: {
      startAt: "2026-07-13T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z",
    },
    ingestionCutoffAt: "2026-07-22T00:00:00.000Z",
    releasedAt: "2026-07-22T00:00:00.000Z",
    immutable: true,
    nonOverlapping: true,
    cohortEligibility: "provider_account_gated_open_cohort",
    privacyPolicy: {
      version: "community-weekly-v0.1",
      minimumProviderAccountParticipants: 20,
      maturity: {
        appliesTo: "open_provider_account_cohort",
        maturityDays: 7,
        minimumAcceptedCollectionDays: 2,
        acceptedCollectionDayBasis: "telemetry_contribution_created_at_before_cutoff",
      },
    },
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      metrics: {
        usageEvents: {
          status: "released",
          value: 30,
          unit: "events_rounded_down",
        },
        inputUncachedTokens: releasedTokens,
        inputCacheReadTokens: releasedTokens,
        inputCacheWriteTokens: releasedTokens,
        outputTextTokens: releasedTokens,
        outputReasoningTokens: releasedTokens,
        outputCombinedTokens: releasedTokens,
        toolUnits: {
          status: "released",
          value: 10,
          unit: "tool_units_rounded_down",
        },
      },
    }],
    ...overrides,
  };
}

test("the public site presents only the install call to action and the community view", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");

  assert.match(html, /<script type="module" src="\.\/community\.js">/u);
  assert.match(html, /id="installer-link"/u);
  assert.match(html, /id="installer-unavailable-action"/u);
  assert.match(html, /id="installer-details"/u);
  assert.match(html, /id="installer-unavailable"/u);
  assert.doesNotMatch(html, /open-installed-app|usage-monitor-semantic-open-target|usagemonitor:\/\//u);
  assert.match(html, /id="community-daily-result"/u);
  assert.match(html, /id="community-daily-state"/u);
  assert.match(html, /id="community-daily-status"/u);
  assert.match(html, /id="community-daily-panel-state"/u);
  assert.match(html, /id="community-daily-hero"/u);

  // The legacy sealed-snapshot presentation is retired: the page carries no
  // snapshot banner, no provenance expander, and no snapshot copy at all.
  for (
    const retiredSnapshotSurface of [
      'id="community-result"',
      'id="community-service-state"',
      'id="community-snapshot-status"',
      'id="community-snapshot-panel-state"',
      'id="community-snapshot-provenance"',
      'id="community-snapshot-service-detail"',
      "Published activity",
      "Snapshot and source details",
    ]
  ) {
    assert.equal(html.includes(retiredSnapshotSurface), false, retiredSnapshotSurface);
  }
  assert.doesNotMatch(html, /snapshot/iu);

  // Every control that cannot work without the local companion is absent from
  // the website. These are the dead controls the split exists to remove.
  for (
    const companionOnly of [
      'id="refresh-button"',
      'id="quota-cards"',
      'id="weekly-chart"',
      'id="timeline-chart"',
      'id="accounting-summary"',
      'id="contribution-form"',
      'id="contribution-file"',
      'id="prepare-contribution"',
      'id="connect-community"',
      'id="identity-signin"',
      'id="identity-google-signin"',
      'id="identity-apple-signin"',
      'id="delete-participant"',
      'id="sync-run-once"',
      'id="automatic-contribution-toggle"',
      'id="setup-card"',
      'id="share-card-canvas"',
      "data-requires-evidence",
    ]
  ) {
    assert.equal(html.includes(companionOnly), false, companionOnly);
  }
  for (
    const companionOnlyModule of [
      "./app.js",
      "./data-client.js",
      "./lib.js",
      "./navigation.js",
      "LocalCompanionClient",
      "createTelemetryEnvelope",
      "createGoogleSignInRequest",
      "registerUpload",
      "contributeSerialized",
    ]
  ) {
    assert.equal(source.includes(companionOnlyModule), false, companionOnlyModule);
  }

  // Accessibility: the site keeps a skip link, named landmarks, keyboard
  // focus rings, and a language control for the public surface.
  assert.match(html, /<a class="skip-link" href="#main">/u);
  assert.match(html, /<main id="main" tabindex="-1" data-i18n-legacy-root>/u);
  assert.match(html, /data-language-picker/u);
  assert.match(html, /data-language-announcement[^>]*aria-live="polite"/u);
  assert.match(
    html,
    /<nav\s+class="primary-nav"\s+aria-label="Site sections"(?:\s[^>]*)?>/u,
  );
  assert.match(html, /aria-labelledby="install-title"/u);
  assert.match(html, /aria-labelledby="community-title"/u);
  assert.match(
    await readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    /button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible/u,
  );

  // Release packaging materializes the site index from this page, so every
  // injected slot must be present exactly once here.
  for (
    const name of [
      "usage-monitor-installer-url",
      "usage-monitor-installer-version",
      "usage-monitor-installer-sha256",
      "usage-monitor-installer-bytes",
      "usage-monitor-minimum-macos",
      "usage-monitor-architectures",
      "usage-monitor-release-notes-url",
      "usage-monitor-privacy-url",
      "usage-monitor-security-url",
      "usage-monitor-support-url",
    ]
  ) {
    assert.equal(
      html.split(`<meta name="${name}" content="">`).length - 1,
      1,
      name,
    );
  }
});

test("the public community client exposes only the read-only daily request", async () => {
  // The legacy weekly snapshot request left with the snapshot presentation:
  // the public site reads the day-partitioned series and nothing else.
  assert.deepEqual(
    Object.getOwnPropertyNames(PublicCommunityClient.prototype).sort(),
    ["communityDaily", "constructor"],
  );

  const requestId = "12345678-1234-4123-8123-123456789abc";
  const failing = new PublicCommunityClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: "AGGREGATE_UNAVAILABLE",
          requestId,
          privateDetail: "must not escape",
        },
      }),
    }),
  });
  await assert.rejects(
    failing.communityDaily(),
    (error) => {
      assert.equal(error.message, "Request failed (503).");
      assert.equal(error.code, "AGGREGATE_UNAVAILABLE");
      assert.equal(error.requestId, requestId);
      assert.equal(Object.hasOwn(error, "privateDetail"), false);
      return true;
    },
  );
});

test("the first visit leads with the product, Mac download action, and daily community view", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  assert.match(html, /<h1 id="install-title">See where your Codex allowance stands\.<\/h1>/u);
  assert.match(html, /private Mac app that estimates how much of your\s+seven-day Codex allowance remains/u);
  assert.match(html, /Your personal dashboard is calculated on your Mac\./u);
  assert.match(html, /Download for macOS/u);
  assert.match(html, /Latest community evidence/u);
  assert.match(html, /What the Codex allowance is really worth/u);
  assert.match(html, /Install the Mac app/u);
  assert.match(html, /See your week/u);
  assert.match(html, /Share only if you choose/u);
  assert.match(html, /<section class="product-hero"[^>]*id="install"/u);
  assert.match(html, /src="\.\/tibotattle-icon\.png"/u);
  assert.match(html, /src="\.\/tibotattle-weekly-preview\.jpg"/u);
  assert.match(html, /src="\.\/apple\.svg"/u);
  assert.match(html, /Demo data/u);
  assert.match(html, /Example only — not your usage or a bill\./u);
  assert.match(html, /Your dashboard is calculated privately on your Mac\./u);
  assert.match(html, /href="https:\/\/github\.com\/adamallcock\/tibotattle"/u);
  assert.match(html, /href="https:\/\/x\.com\/adamallcock"/u);
  assert.match(html, /footer-social-label">X<\/span>/u);
  assert.match(html, /href="\.\/docs\.html">Docs<\/a>/u);
  assert.match(html, /href="\.\/privacy\.html">Privacy<\/a>/u);
  assert.doesNotMatch(
    html,
    /github\.com\/adamallcock\/(?:app-usagemonitor|tibotattle-client)/u,
  );
  assert.match(html, /id="installer-link"/u);
  assert.ok(
    html.indexOf('id="installer-link"') < html.indexOf('id="community"'),
    "the primary installer action appears before the community activity section",
  );
  assert.ok(
    html.indexOf('class="product-window"') < html.indexOf('id="how-it-works"'),
    "the app preview appears before the supporting feature strip",
  );
  assert.doesNotMatch(
    html,
    /After download|companion-steps|install-explainer|Illustrative demo|Illustrative fixture|Example local dashboard/u,
  );
  // Re-pinned 2026-08-10 (owner-directed): the community section now leads
  // with the fitted allowance estimate, so the old "no community estimate
  // surface" guard narrows to the copy that stays banned — hedge words and
  // unearned privacy claims.
  assert.doesNotMatch(
    html,
    /best guess|privacy[- ]reviewed|privacy and quality checks/u,
  );
});

test("the public hero keeps equal columns and a bounded stacked preview", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
  );
  assert.match(styles, /@media \(max-width: 1120px\)/u);
  assert.match(styles, /width: min\(100%, 620px\);/u);
  assert.match(styles, /justify-self: center;/u);
  assert.doesNotMatch(styles, /font-size: clamp\(3\.15rem, 16vw, 5\.2rem\);/u);
});

test("the public header and footer stay compact on narrow screens", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.community-site \.topbar \{[\s\S]*?min-height: 64px;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.topbar \{\s*min-height: 56px;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site footer \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/u,
  );
  assert.doesNotMatch(
    styles,
    /@media \(max-width: 420px\) \{[\s\S]*?\.community-site footer \{[\s\S]*?flex-direction: column;/u,
  );
});

test("unavailable community activity uses the compact public state", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /data-community-state="checking"/u);
  assert.match(
    html,
    /<h2 id="community-title">What the Codex allowance is really worth<\/h2>/u,
  );
  assert.match(
    html,
    /When available, this leads with the fitted seven-day Codex allowance in API-price-equivalent dollars across every contributing account on the Codex Pro \(20x\) plan, from delayed, anonymous contributions\. Other plan cohorts are never mixed into this series\./u,
  );
  assert.doesNotMatch(
    html,
    /privacy[- ]reviewed|privacy and quality checks|best guess/u,
  );
  assert.doesNotMatch(
    source,
    /renderCommunityEstimate|estimateContainer|estimateHero|estimateStates|id="community-estimate/u,
  );
  assert.match(source, /\.dataset\.communityState = state;/u);
  assert.match(styles, /\[data-community-state="service_unavailable"\]/u);
  assert.match(styles, /\[data-community-state="none_published"\]/u);
  assert.doesNotMatch(styles, /\[data-community-state="not_yet_published"\]/u);
  assert.doesNotMatch(styles, /\[data-community-state="withdrawn"\]/u);
  assert.match(
    styles,
    /@media \(max-width: 1120px\) \{[\s\S]*?\.community-site \.community-proof\[data-community-state\] \.community-proof-heading \{\s*grid-template-columns: 1fr;/u,
  );
});

test("the public guidance pages are useful stubs without app-only controls", async () => {
  const docs = await readFile(DOCS_HTML, "utf8");
  const privacy = await readFile(PRIVACY_HTML, "utf8");
  assert.match(docs, /<title>TiboTattle Docs<\/title>/u);
  assert.match(
    docs,
    /Estimated API-equivalent value of the observed seven-day allowance\./u,
  );
  assert.match(docs, /Activity totals alone are never presented as an allowance\./u);
  assert.match(privacy, /<title>TiboTattle Privacy Overview<\/title>/u);
  assert.match(privacy, /This website cannot read local Codex files\./u);
  assert.match(privacy, /Nothing is contributed unless you review and opt in\./u);
  for (const page of [docs, privacy]) {
    assert.match(page, /href="\.\/community\.html#download"/u);
    assert.match(page, /href="\.\/docs\.html"/u);
    assert.match(page, /href="\.\/privacy\.html"/u);
    assert.doesNotMatch(
      page,
      /<script|id="contribution-form"|id="identity-signin"|id="quota-cards"|\/api\/local/u,
    );
  }
});

test("the dashboard keeps contribution review local while the public site owns delayed evidence", async () => {
  const siteSource = await readFile(SITE_SOURCE, "utf8");
  const appSource = await readFile(APP_SOURCE, "utf8");
  assert.match(siteSource, /from "\.\/community-view\.js"/u);
  assert.match(siteSource, /from "\.\/install-cta\.js"/u);
  assert.match(appSource, /from "\.\/install-cta\.js"/u);
  assert.doesNotMatch(appSource, /from "\.\/community-view\.js"/u);
  // The dashboard is a single local review/send destination; delayed public
  // evidence remains rendered by the public website entry point.
  assert.doesNotMatch(appSource, /COMMUNITY_METRIC_LABELS|renderSharedCommunitySnapshot/u);
  assert.doesNotMatch(appSource, /function configuredInstallerRelease\(/u);
  assert.doesNotMatch(appSource, /function formatInstallerSize\(/u);
  const appHtml = await readFile(APP_HTML, "utf8");
  assert.match(appHtml, /id="community"/u);
  assert.match(appHtml, /https:\/\/tibotattle\.com\/#community/u);
  for (const retiredControl of [
    'id="central-state"',
    'id="backend"',
    'id="contribution-file"',
    'id="selected-contribution-inspection"',
    'id="automatic-contribution-toggle"',
    'id="download-participant"',
    'id="community-result"',
  ]) {
    assert.doesNotMatch(appHtml, new RegExp(retiredControl, "u"), retiredControl);
  }
  // Re-pinned 2026-08-08 (owner-directed, second round): the connect-consent
  // checkbox left with the connect card — the merged surface's explicit
  // Review-and-approve action is the consent.
  assert.doesNotMatch(appHtml, /id="community-connect-consent"/u);
  // Earlier same-day re-pin: the legacy prepare-and-review flow
  // is removed outright. The approve-once surface is the only contribution
  // flow, so the dashboard's local destination is now the consent card.
  assert.doesNotMatch(appHtml, /id="prepare-contribution"/u);
  assert.doesNotMatch(appHtml, /id="sync-run-once"/u);
  assert.match(appHtml, /id="incremental-consent"/u);
  assert.match(appHtml, /id="incremental-consent-approve"/u);
});

test("the retained weekly snapshot normalizer still guards the app's closed contract", () => {
  // The public site no longer renders the sealed weekly snapshot, but the Mac
  // app's data-client.js still imports this normalizer, so its state machine
  // keeps behavioural cover here beside the contract fixture.
  for (
    const [payload, expectedState] of [
      [null, "service_unavailable"],
      [publishedSnapshot(), "published"],
      [publishedSnapshot({ releaseStatus: "not_yet_published" }), "not_yet_published"],
      [publishedSnapshot({ releaseStatus: "withdrawn" }), "withdrawn"],
      [publishedSnapshot({ releaseStatus: "suppressed" }), "suppressed"],
      [{ schemaVersion: "community-weekly-v0.0" }, "unsupported_schema"],
      [
        { publicationStatus: "development_diagnostic_not_publication_safe" },
        "development_unsafe",
      ],
    ]
  ) {
    assert.equal(normalizeCommunitySnapshot(payload).state, expectedState);
  }
  const published = normalizeCommunitySnapshot(publishedSnapshot());
  assert.equal(published.participantCohort, "provider_account");
  assert.equal(published.minimumParticipants, 20);
  assert.equal(published.cells.length, 1);
  assert.equal(published.cells[0].metrics.usageEvents.value, 30);
});

// Re-pinned 2026-08-10 (owner-directed): the community section now leads with
// THE product insight — the fitted seven-day allowance across all
// contributing accounts. The earlier "no community estimate surface" guard is
// replaced by honest-labeling guards: the surface must exist, sit above the
// daily activity block, carry real time controls, and keep hedge copy out.
test("the community allowance surface leads the section with honest labeling", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");

  assert.match(html, /id="community-allowance-figure"/u);
  assert.match(html, /id="community-allowance-result"/u);
  assert.match(html, /id="community-allowance-state"/u);
  assert.match(html, /id="community-allowance-range-controls"/u);
  // The allowance figure is the first block inside the community section,
  // above the daily-activity disclosure.
  const communityIndex = html.indexOf('id="community"');
  const allowanceIndex = html.indexOf('id="community-allowance-figure"');
  const dailyIndex = html.indexOf('class="community-method"');
  assert.ok(communityIndex >= 0 && allowanceIndex > communityIndex);
  assert.ok(
    allowanceIndex < dailyIndex,
    "the allowance figure renders above the daily activity block",
  );
  // Segmented time controls follow the app's established range pattern.
  for (const control of [
    'data-range-days="30"',
    'data-range-days="90"',
    'data-range-days=""',
  ]) {
    assert.match(html, new RegExp(control, "u"), control);
  }

  assert.match(source, /renderCommunityAllowanceSection/u);
  assert.match(source, /community-allowance-range-controls/u);

  const publicCopy = `${html}\n${source}`;
  assert.match(publicCopy, /delayed, anonymous contributions/u);
  assert.doesNotMatch(
    publicCopy,
    /best guess|privacy[- ]reviewed|privacy and quality checks/u,
  );
  assert.doesNotMatch(publicCopy, /id="community-estimate|renderCommunityEstimate/u);
});

test("the generated daily community state follows the active UI language", () => {
  const documentRef = fakeDocument();
  documentRef.documentElement.lang = "zh-Hans";
  const container = documentRef.createElement("div");
  const stateNode = documentRef.createElement("span");

  assert.equal(
    renderCommunityDailySeries({ documentRef, container, stateNode, payload: null }),
    "service_unavailable",
  );
  assert.match(container.text, /每日社区活动暂时不可用/u);
  assert.equal(stateNode.textContent, "每日序列不可用");
});

function publishedDailyDay(day, revision, overrides = {}) {
  return {
    day,
    revision,
    releasedAt: "2026-08-08T01:00:00.000Z",
    payload: {
      schemaVersion: "community-daily-aggregate-v1.0",
      aggregateId: `community-daily:${day}:r${revision}`,
      day,
      revision,
      releasedAt: "2026-08-08T01:00:00.000Z",
      immutableRevision: true,
      recomputesOnLateData: true,
      policyVersion: "community-daily-v1.0",
      suppression: "none_daily_grain_by_owner_decision",
      totals: {
        contributingParticipants: 3,
        contributingDevices: 4,
        usageEvents: 120,
        quotaObservations: 6,
        sessionDimensions: 2,
        inputUncachedTokens: 1000,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTextTokens: 400,
        outputReasoningTokens: 100,
        outputCombinedTokens: 500,
      },
      cellsTruncated: false,
      cells: [],
      ...overrides.payload,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "payload"),
    ),
  };
}

function publishedDailySeries(overrides = {}) {
  return {
    schemaVersion: COMMUNITY_DAILY_READ_SCHEMA_VERSION,
    from: "2025-08-08",
    to: "2026-08-08",
    days: [
      publishedDailyDay("2026-08-06", 1),
      publishedDailyDay("2026-08-07", 2),
    ],
    ...overrides,
  };
}

test("the public daily client requests exactly the inclusive year window", async () => {
  const calls = [];
  const payload = publishedDailySeries();
  const client = new PublicCommunityClient({
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  const nowMs = Date.parse("2026-08-08T12:00:00.000Z");
  assert.equal(await client.communityDaily({ nowMs }), payload);
  const { from, to } = communityDailyWindow(nowMs);
  assert.equal(to, "2026-08-08");
  assert.equal(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`))
      / 86_400_000
      + 1,
    COMMUNITY_DAILY_WINDOW_DAYS,
    "the requested window is the endpoint's full inclusive bound, never a convenience size",
  );
  assert.deepEqual(calls, [[
    `/api/v1/community/daily?from=${from}&to=${to}`,
    { headers: { Accept: "application/json" } },
  ]]);
});

test("the daily series normalizer accepts only the closed published contract", () => {
  assert.equal(
    normalizeCommunityDailySeries(null).state,
    "service_unavailable",
  );
  assert.equal(
    normalizeCommunityDailySeries({ schemaVersion: "community-daily-read-v0.9" })
      .state,
    "unsupported_schema",
  );
  assert.equal(
    normalizeCommunityDailySeries(publishedDailySeries({ days: [] })).state,
    "none_published",
  );

  const published = normalizeCommunityDailySeries(publishedDailySeries());
  assert.equal(published.state, "published");
  assert.deepEqual(
    published.days.map(({ day, revision }) => ({ day, revision })),
    [
      { day: "2026-08-06", revision: 1 },
      { day: "2026-08-07", revision: 2 },
    ],
  );
  assert.equal(published.days[1].totals.usageEvents, 120);

  for (const [label, hostile] of [
    [
      "out-of-order days",
      publishedDailySeries({
        days: [
          publishedDailyDay("2026-08-07", 2),
          publishedDailyDay("2026-08-06", 1),
        ],
      }),
    ],
    [
      "wrapper and payload revision disagreement",
      publishedDailySeries({
        days: [publishedDailyDay("2026-08-06", 2, { payload: { revision: 1 } })],
      }),
    ],
    [
      "mutable revision claim",
      publishedDailySeries({
        days: [
          publishedDailyDay("2026-08-06", 1, {
            payload: { immutableRevision: false },
          }),
        ],
      }),
    ],
    [
      "negative total",
      publishedDailySeries({
        days: [
          publishedDailyDay("2026-08-06", 1, {
            payload: {
              totals: {
                ...publishedDailyDay("2026-08-06", 1).payload.totals,
                usageEvents: -1,
              },
            },
          }),
        ],
      }),
    ],
    [
      "day outside the requested range",
      publishedDailySeries({ days: [publishedDailyDay("2027-01-01", 1)] }),
    ],
  ]) {
    assert.equal(
      normalizeCommunityDailySeries(hostile).state,
      "unsupported_schema",
      label,
    );
  }
});

test("a published daily series renders revision freshness, latest-first", () => {
  const documentRef = fakeDocument();
  const container = documentRef.createElement("div");
  const stateNode = documentRef.createElement("span");
  const state = renderCommunityDailySeries({
    documentRef,
    container,
    stateNode,
    payload: publishedDailySeries(),
    now: Date.parse("2026-08-08T03:00:00.000Z"),
  });
  assert.equal(state, "published");
  assert.equal(stateNode.textContent, "Daily series available");
  assert.match(container.text, /Latest published day/u);
  assert.match(container.text, /r2/u);
  assert.match(container.text, /Revision age/u);
  assert.match(container.text, /Published days in window/u);
  assert.match(container.text, /never edit history/u);

  // The chart precedes the table: bars for usage events, a line series for
  // combined output, and — while the series is one or two days long — dots
  // plus the still-filling note.
  const svg = container.descendants().find(({ tag }) => tag === "svg");
  assert.ok(svg, "a published daily series renders its inline SVG chart");
  const chartIndex = container.children.findIndex((child) =>
    child.descendants().some(({ tag }) => tag === "svg")
    || child.tag === "svg");
  const tableIndex = container.children.findIndex((child) =>
    child.descendants().some(({ tag }) => tag === "table"));
  assert.ok(chartIndex >= 0 && chartIndex < tableIndex, "the chart renders above the table");
  assert.equal(svg.attributes.get("role"), "img");
  assert.equal(svg.attributes.get("aria-label"), "Daily community activity chart");
  const bars = svg.descendants().filter(({ tag }) => tag === "rect")
    .filter((element) => element.attributes.get("class") === "daily-events-bar");
  assert.equal(bars.length, 2);
  const dots = svg.descendants().filter(({ tag }) => tag === "circle");
  assert.equal(dots.length, 2, "a sparse series marks every output point with a dot");
  assert.match(container.text, /still filling/u);
  assert.match(container.text, /Usage events/u);
  assert.match(container.text, /Output tokens/u);

  const table = container.descendants().find(({ tag }) => tag === "table");
  assert.ok(table, "a published daily series renders its table");
  const columnLabels = table
    .descendants()
    .filter((element) => element.tag === "th")
    .map(({ textContent }) => textContent);
  for (const label of [
    "Day",
    "Usage events",
    "Quota observations",
    "Contributing devices",
    "Output tokens",
    "Released",
  ]) {
    assert.equal(columnLabels.includes(label), true, label);
  }
  // The revision column is gone from the table; revision freshness lives in
  // the summary grid above (asserted earlier in this test).
  assert.equal(columnLabels.includes("Revision"), false);
  const bodyRows = table
    .descendants()
    .filter((element) => element.tag === "tr")
    .slice(1);
  assert.equal(bodyRows.length, 2);
  assert.equal(bodyRows[0].children[0].textContent, "2026-08-07");
  assert.equal(bodyRows[1].children[0].textContent, "2026-08-06");
  assert.doesNotMatch(bodyRows[0].text, /\br2\b/u);
  // Numeric cells right-align via the shared class and keep one unit per
  // column (these fixtures stay below 1K, so plain integers).
  const numericCells = bodyRows[0].children
    .filter((cell) => cell.className === "numeric");
  assert.equal(numericCells.length, 4);
});

test("daily table columns share one unit chosen from the column maximum", () => {
  const format = communityDailyColumnFormatter([44, 986, 1_700]);
  assert.deepEqual(
    [44, 986, 1_700].map(format),
    ["0.0K", "1.0K", "1.7K"],
  );
  const plain = communityDailyColumnFormatter([1, 44, 986]);
  assert.deepEqual([1, 44, 986].map(plain), ["1", "44", "986"]);
  const millions = communityDailyColumnFormatter([950_000, 2_400_000]);
  assert.deepEqual(
    [950_000, 2_400_000].map(millions),
    ["0.9M", "2.4M"],
  );
});

test("the daily series degrades honestly without a service or published days", () => {
  for (const [payload, expectedState, marker] of [
    [null, "service_unavailable", /temporarily unavailable/u],
    [{ schemaVersion: "wrong" }, "unsupported_schema", /cannot be displayed safely/u],
    [publishedDailySeries({ days: [] }), "none_published", /No daily community activity/u],
  ]) {
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const stateNode = documentRef.createElement("span");
    const state = renderCommunityDailySeries({
      documentRef,
      container,
      stateNode,
      payload,
    });
    assert.equal(state, expectedState);
    assert.equal(stateNode.textContent, "Daily series unavailable");
    assert.equal(stateNode.className, "evidence-chip neutral");
    assert.match(container.text, marker, expectedState);
    for (const absent of ["table", "svg"]) {
      assert.equal(
        container.descendants().some(({ tag }) => tag === absent),
        false,
        `${expectedState}: ${absent}`,
      );
    }
  }
});

test("the public site hosts the daily series containers", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  assert.match(html, /id="community-daily-result"/u);
  assert.match(html, /id="community-daily-state"/u);
  assert.match(html, /Daily activity series/u);
  assert.match(html, /latest published revision/u);
  const source = await readFile(SITE_SOURCE, "utf8");
  assert.match(source, /renderCommunityDailySeries/u);
  assert.match(source, /communityDaily\(\)/u);
  assert.doesNotMatch(source, /communityStats|renderCommunitySnapshot/u);
});

test("the daily chart model maps published days honestly", () => {
  // Non-published states produce no chart at all.
  for (const payload of [
    null,
    { schemaVersion: "wrong" },
    publishedDailySeries({ days: [] }),
  ]) {
    assert.equal(
      buildCommunityDailyChartModel(normalizeCommunityDailySeries(payload)),
      null,
    );
  }

  // A two-day series is sparse: both days chart, and the line stays one
  // connected segment because the days are calendar-adjacent.
  const sparse = buildCommunityDailyChartModel(
    normalizeCommunityDailySeries(publishedDailySeries()),
  );
  assert.equal(sparse.sparse, true);
  assert.deepEqual(sparse.bars.map(({ day }) => day), ["2026-08-06", "2026-08-07"]);
  assert.equal(sparse.outputSegments.length, 1);
  assert.equal(sparse.outputSegments[0].length, 2);
  assert.deepEqual(sparse.dayTicks.map(({ day }) => day), ["2026-08-06", "2026-08-07"]);
  assert.equal(sparse.tickLabelStyle, "day");
  assert.ok(sparse.bars[0].x < sparse.bars[1].x, "bars advance with the calendar");

  // Events scale from zero on the left axis; output tokens scale on the right.
  assert.equal(sparse.eventsTicks[0].value, 0);
  assert.equal(sparse.eventsTicks[0].y, sparse.plot.bottom);
  assert.ok(
    sparse.eventsTicks[sparse.eventsTicks.length - 1].value >= 120,
    "the events axis covers the maximum usage-event total",
  );
  assert.ok(
    sparse.outputTicks[sparse.outputTicks.length - 1].value >= 500,
    "the output axis covers the maximum combined-output total",
  );
});

test("the daily chart model renders unpublished days as gaps, not zeros", () => {
  const series = normalizeCommunityDailySeries(publishedDailySeries({
    days: [
      publishedDailyDay("2026-08-01", 1),
      publishedDailyDay("2026-08-02", 1),
      publishedDailyDay("2026-08-05", 2),
    ],
  }));
  const model = buildCommunityDailyChartModel(series);
  assert.equal(model.sparse, false);
  assert.equal(model.bars.length, 3, "only published days draw a bar");
  // The output line breaks at the two-day publication gap: one connected
  // segment for the adjacent days, then an isolated single-point segment.
  assert.deepEqual(
    model.outputSegments.map((segment) => segment.map(({ day }) => day)),
    [["2026-08-01", "2026-08-02"], ["2026-08-05"]],
  );
  const positions = model.bars.map(({ x }) => x);
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  // The gap is proportional on the date axis: three days of silence spread
  // the last bar further from the second than the second from the first.
  assert.ok(
    positions[2] - positions[1] > (positions[1] - positions[0]) * 2,
    "missing days occupy axis space instead of collapsing",
  );
});

test("the daily chart model thins ticks and bars for a year of days", () => {
  const days = [];
  const start = Date.parse("2025-08-10T00:00:00.000Z");
  for (let offset = 0; offset < 366; offset += 3) {
    const day = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    days.push(publishedDailyDay(day, 1));
  }
  const series = normalizeCommunityDailySeries(publishedDailySeries({
    from: "2025-08-10",
    to: "2026-08-10",
    days,
  }));
  assert.equal(series.state, "published");
  const model = buildCommunityDailyChartModel(series);
  assert.equal(model.sparse, false);
  assert.equal(model.bars.length, days.length);
  assert.ok(model.dayTicks.length <= 6, "a year keeps a handful of date ticks");
  assert.equal(model.tickLabelStyle, "month", "long spans label ticks by month");
  assert.ok(model.barWidth >= 1, "bars stay visible");
  const slotWidth = (model.plot.right - model.plot.left) / model.spanDays;
  assert.ok(model.barWidth <= slotWidth, "bars never overlap their neighbours");
  for (const tick of model.dayTicks) {
    assert.match(tick.day, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(tick.x >= model.plot.left && tick.x <= model.plot.right);
  }
});

test("the daily chart keeps an all-zero output series on the baseline", () => {
  // Combined-output totals were zero before the server-side fix; a series of
  // zeros must chart as a flat baseline, never as an invented scale.
  const series = normalizeCommunityDailySeries(publishedDailySeries({
    days: [
      publishedDailyDay("2026-08-06", 1, {
        payload: {
          totals: {
            ...publishedDailyDay("2026-08-06", 1).payload.totals,
            outputCombinedTokens: 0,
          },
        },
      }),
      publishedDailyDay("2026-08-07", 1, {
        payload: {
          totals: {
            ...publishedDailyDay("2026-08-07", 1).payload.totals,
            outputCombinedTokens: 0,
          },
        },
      }),
    ],
  }));
  const model = buildCommunityDailyChartModel(series);
  for (const point of model.outputPoints) {
    assert.equal(point.y, model.plot.bottom);
  }
});

function allowanceBlock(overrides = {}) {
  return {
    basis: "seven_day_codex_pro20x_trailing_30d",
    limitId: "codex",
    planType: "pro",
    planVariant: "pro-20x",
    windowDurationMinutes: 10_080,
    trailingDays: 30,
    qualification: "shared_reset_fit_gates_40pp_span_floor",
    spanFloorPp: 40,
    fitCount: 5,
    participantCount: 1,
    centralUsd: 1879,
    band80Usd: { lowerUsd: 1500, upperUsd: 2300 },
    ...overrides,
  };
}

function allowanceDay(day, allowance, revision = 1) {
  return publishedDailyDay(day, revision, { payload: { allowance } });
}

test("the daily normalizer treats the allowance block as additive and per-day", () => {
  // Old revisions without the block stay renderable: allowance is null, the
  // day itself survives.
  const withoutBlock = normalizeCommunityDailySeries(publishedDailySeries());
  assert.equal(withoutBlock.state, "published");
  assert.equal(withoutBlock.days[0].allowance, null);

  const published = normalizeCommunityDailySeries(publishedDailySeries({
    days: [allowanceDay("2026-08-06", allowanceBlock())],
  }));
  assert.equal(published.state, "published");
  assert.deepEqual(published.days[0].allowance, {
    fitCount: 5,
    participantCount: 1,
    centralUsd: 1879,
    band80Usd: { lowerUsd: 1500, upperUsd: 2300 },
  });

  // The honest zero-estimate day: block present, no claim.
  const empty = normalizeCommunityDailySeries(publishedDailySeries({
    days: [allowanceDay("2026-08-06", allowanceBlock({
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
      band80Usd: null,
    }))],
  }));
  assert.deepEqual(empty.days[0].allowance, {
    fitCount: 0,
    participantCount: 0,
    centralUsd: null,
    band80Usd: null,
  });

  // Invalid blocks collapse to per-day-absent, never to unsupported_schema:
  // the activity series must keep rendering even if the allowance claim is
  // malformed.
  for (const [label, hostile] of [
    ["unknown basis", allowanceBlock({ basis: "five_hour_trailing_7d" })],
    // A different plan_type is a different product's allowance (ProLite is the
    // 5x plan); the page's copy names the Pro (20x) cohort, so the block must
    // not render under it. Cohorting is by plan_type, not the frozen variant tag.
    ["different plan cohort", allowanceBlock({ planType: "prolite" })],
    ["cohort-less pooled block", allowanceBlock({
      planType: undefined,
      planVariant: undefined,
    })],
    ["negative fit count", allowanceBlock({ fitCount: -1 })],
    ["missing central with fits", allowanceBlock({ centralUsd: null })],
    ["zero-dollar central", allowanceBlock({ centralUsd: 0 })],
    ["inverted band", allowanceBlock({ band80Usd: { lowerUsd: 9, upperUsd: 3 } })],
    ["participants without fits", allowanceBlock({ participantCount: 0 })],
    [
      "estimate on a zero-fit day",
      allowanceBlock({ fitCount: 0, participantCount: 0, band80Usd: null }),
    ],
  ]) {
    const series = normalizeCommunityDailySeries(publishedDailySeries({
      days: [allowanceDay("2026-08-06", hostile)],
    }));
    assert.equal(series.state, "published", label);
    assert.equal(series.days[0].allowance, null, label);
  }

  // A missing band is legitimate below the fit minimum.
  const bandless = normalizeCommunityDailySeries(publishedDailySeries({
    days: [allowanceDay("2026-08-06", allowanceBlock({
      fitCount: 2,
      band80Usd: null,
    }))],
  }));
  assert.deepEqual(bandless.days[0].allowance, {
    fitCount: 2,
    participantCount: 1,
    centralUsd: 1879,
    band80Usd: null,
  });
});

test("the allowance chart model maps estimates honestly and slices ranges", () => {
  // No allowance-bearing day anywhere: no model.
  assert.equal(
    buildCommunityAllowanceChartModel(
      normalizeCommunityDailySeries(publishedDailySeries()),
    ),
    null,
  );

  const series = normalizeCommunityDailySeries(publishedDailySeries({
    from: "2025-08-10",
    to: "2026-08-10",
    days: [
      allowanceDay("2026-04-01", allowanceBlock({
        fitCount: 1,
        band80Usd: null,
        centralUsd: 900,
      })),
      allowanceDay("2026-08-01", allowanceBlock({ centralUsd: 1700 })),
      allowanceDay("2026-08-02", allowanceBlock({ centralUsd: 1800 })),
      // A published day whose estimate has not accrued: a gap, not a zero.
      allowanceDay("2026-08-03", allowanceBlock({
        fitCount: 0,
        participantCount: 0,
        centralUsd: null,
        band80Usd: null,
      })),
      allowanceDay("2026-08-05", allowanceBlock({
        fitCount: 12,
        centralUsd: 1879,
      })),
    ],
  }));
  assert.equal(series.state, "published");

  const all = buildCommunityAllowanceChartModel(series);
  assert.equal(all.dots.length, 4, "only estimate-bearing days become points");
  // The central line breaks at the April-to-August gap, at the estimate-free
  // Aug 3, and around the isolated Aug 5 point.
  assert.deepEqual(
    all.centralSegments.map((segment) => segment.map(({ day }) => day)),
    [["2026-04-01"], ["2026-08-01", "2026-08-02"], ["2026-08-05"]],
  );
  // The band renders only where days published one: April's one-fit day has
  // no band, so band segments cover the banded August days only.
  assert.deepEqual(
    all.bandSegments.map((segment) => segment.map(({ day }) => day)),
    [["2026-08-01", "2026-08-02"], ["2026-08-05"]],
  );
  // Dot radius grows with fit count: the 12-fit day out-weighs the 1-fit day.
  const radiusByDay = new Map(all.dots.map(({ day, radius }) => [day, radius]));
  assert.ok(radiusByDay.get("2026-08-05") > radiusByDay.get("2026-04-01"));
  // The dollar axis covers the largest published claim (the band top).
  assert.ok(all.dollarTicks[all.dollarTicks.length - 1].value >= 2300);
  assert.equal(all.dollarTicks[0].value, 0);
  // The latest point carries the honest counts the headline renders.
  assert.equal(all.latest.day, "2026-08-05");
  assert.equal(all.latest.fitCount, 12);
  assert.equal(all.latest.participantCount, 1);
  assert.equal(all.sparse, false);

  // Range slicing anchors at the latest published day (2026-08-05): a 30-day
  // range keeps the August points and drops April.
  const thirty = buildCommunityAllowanceChartModel(series, { rangeDays: 30 });
  assert.deepEqual(thirty.dots.map(({ day }) => day), [
    "2026-08-01",
    "2026-08-02",
    "2026-08-05",
  ]);

  // A range with estimates outside it produces no model — the renderer's
  // "none in this range" state, distinct from "still accumulating".
  const twoDays = buildCommunityAllowanceChartModel(series, { rangeDays: 1 });
  assert.equal(twoDays.dots.length, 1);
  assert.equal(twoDays.sparse, true);
});

test("the allowance section renders the estimate with its visible caveat", () => {
  const documentRef = fakeDocument();
  const container = documentRef.createElement("div");
  const stateNode = documentRef.createElement("span");
  const state = renderCommunityAllowanceSection({
    documentRef,
    container,
    stateNode,
    payload: publishedDailySeries({
      days: [
        allowanceDay("2026-08-06", allowanceBlock({
          fitCount: 4,
          centralUsd: 1700,
        })),
        allowanceDay("2026-08-07", allowanceBlock({
          fitCount: 5,
          centralUsd: 1879,
        })),
      ],
    }),
  });
  assert.equal(state, "published");
  assert.equal(stateNode.textContent, "Allowance estimates available");
  assert.equal(stateNode.className, "evidence-chip");
  // The headline claim, in dollars, with the per-window qualification.
  assert.match(container.text, /\$1,879/u);
  assert.match(container.text, /per 7 days, API-price equivalent/u);
  // The plausible range is spelled out beside the central number.
  assert.match(container.text, /\$1,500/u);
  assert.match(container.text, /\$2,300/u);
  // The participant count is visible copy, not a tooltip: with one account
  // contributing, the page says so plainly.
  assert.match(container.text, /from 1 contributing account\b/u);
  assert.match(container.text, /5 qualifying reset fits in the trailing 30 days/u);
  // The methodology note names the shared gates and the absent span floor.
  assert.match(container.text, /no display-side span floor/u);
  // Chart present with band, line, and fit dots; sparse two-point series
  // carries the still-filling note.
  const svg = container.descendants().find(({ tag }) => tag === "svg");
  assert.ok(svg, "the allowance section renders its inline SVG chart");
  assert.ok(svg.descendants().some((element) => (
    element.attributes.get("class") === "allowance-central-line"
  )));
  assert.ok(svg.descendants().some((element) => (
    element.attributes.get("class") === "allowance-band-area"
  )));
  assert.equal(
    svg.descendants().filter((element) => (
      element.attributes.get("class") === "allowance-fit-dot"
    )).length,
    2,
  );
  assert.match(container.text, /still filling/u);
});

test("the allowance section degrades honestly through every state", () => {
  // Not published at all: fixed state copy, neutral chip.
  for (const [payload, expectedState, marker] of [
    [null, "service_unavailable", /temporarily unavailable/u],
    [{ schemaVersion: "wrong" }, "unsupported_schema", /cannot be displayed safely/u],
    [publishedDailySeries({ days: [] }), "none_published", /No community days/u],
  ]) {
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const stateNode = documentRef.createElement("span");
    const state = renderCommunityAllowanceSection({
      documentRef,
      container,
      stateNode,
      payload,
    });
    assert.equal(state, expectedState);
    assert.equal(stateNode.textContent, "Allowance estimates unavailable");
    assert.equal(stateNode.className, "evidence-chip neutral");
    assert.match(container.text, marker, expectedState);
  }

  // Published days exist but no estimate has accrued anywhere.
  {
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const stateNode = documentRef.createElement("span");
    const state = renderCommunityAllowanceSection({
      documentRef,
      container,
      stateNode,
      payload: publishedDailySeries(),
    });
    assert.equal(state, "estimates_accumulating");
    assert.equal(stateNode.textContent, "Estimates still accumulating");
    assert.match(container.text, /still accumulating/u);
    assert.equal(
      container.descendants().some(({ tag }) => tag === "svg"),
      false,
    );
  }

  // Estimates exist, but the selected range excludes all of them.
  {
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const stateNode = documentRef.createElement("span");
    const state = renderCommunityAllowanceSection({
      documentRef,
      container,
      stateNode,
      payload: publishedDailySeries({
        from: "2025-08-10",
        to: "2026-08-10",
        days: [
          allowanceDay("2026-04-01", allowanceBlock()),
          publishedDailyDay("2026-08-07", 1),
        ],
      }),
      rangeDays: 30,
    });
    assert.equal(state, "no_estimates_in_range");
    assert.match(container.text, /No allowance estimates fall inside this range/u);
  }
});

test("the allowance section follows the active UI language", () => {
  const documentRef = fakeDocument();
  documentRef.documentElement.lang = "zh-Hans";
  const container = documentRef.createElement("div");
  const stateNode = documentRef.createElement("span");
  renderCommunityAllowanceSection({
    documentRef,
    container,
    stateNode,
    payload: publishedDailySeries({
      days: [allowanceDay("2026-08-07", allowanceBlock())],
    }),
  });
  assert.equal(stateNode.textContent, "额度估计可用");
  assert.match(container.text, /来自 1 个贡献账户/u);
});

test("the install card refuses a partially injected release", () => {
  const complete = {
    "usage-monitor-installer-url":
      "https://downloads.example.org/TiboTattle.dmg",
    "usage-monitor-installer-version": "1.2.3",
    "usage-monitor-installer-sha256": "a".repeat(64),
    "usage-monitor-installer-bytes": "12582912",
    "usage-monitor-minimum-macos": "13.0",
    "usage-monitor-architectures": "arm64",
    "usage-monitor-release-notes-url": "https://example.org/releases/1.2.3",
    "usage-monitor-privacy-url": "https://example.org/privacy",
    "usage-monitor-security-url": "https://example.org/security",
    "usage-monitor-support-url": "https://example.org/support",
  };
  const ready = fakeDocument(complete);
  const release = configuredInstallerRelease(ready);
  assert.equal(release.version, "1.2.3");
  assert.equal(formatInstallerSize(12_582_912), "12 MiB download");
  assert.equal(renderInstallerJourney(ready)?.version, "1.2.3");
  assert.equal(ready.byId.get("installer-link").hidden, false);
  assert.equal(ready.byId.get("installer-unavailable-action").hidden, true);
  assert.equal(
    ready.byId.get("installer-link").attributes.has("aria-disabled"),
    false,
  );
  assert.equal(ready.byId.get("installer-unavailable").hidden, true);
  assert.match(
    ready.byId.get("installer-compatibility").textContent,
    /Requires macOS 13\.0 or later · Apple silicon/u,
  );

  for (
    const [name, hostile] of [
      ["usage-monitor-installer-url", "http://downloads.example.org/x.dmg"],
      ["usage-monitor-installer-url", "https://downloads.example.org/x.zip"],
      ["usage-monitor-installer-sha256", "not-a-digest"],
      ["usage-monitor-installer-bytes", "0"],
      ["usage-monitor-minimum-macos", "thirteen"],
      ["usage-monitor-privacy-url", "http://example.org/privacy"],
    ]
  ) {
    const documentRef = fakeDocument({ ...complete, [name]: hostile });
    assert.equal(configuredInstallerRelease(documentRef), null, `${name}=${hostile}`);
    assert.equal(renderInstallerJourney(documentRef), null);
    assert.equal(documentRef.byId.get("installer-link").hidden, true);
    assert.equal(documentRef.byId.get("installer-unavailable-action").hidden, true);
    assert.equal(documentRef.byId.get("installer-unavailable").hidden, false);
    assert.equal(
      Object.hasOwn(documentRef.byId.get("installer-link"), "href"),
      false,
    );

    const publicDocument = fakeDocument({ ...complete, [name]: hostile });
    assert.equal(
      renderInstallerJourney(publicDocument, { showUnavailableAction: true }),
      null,
    );
    assert.equal(publicDocument.byId.get("installer-link").hidden, true);
    assert.equal(
      publicDocument.byId.get("installer-unavailable-action").hidden,
      false,
    );
    assert.equal(
      Object.hasOwn(publicDocument.byId.get("installer-link"), "href"),
      false,
    );
  }
});
