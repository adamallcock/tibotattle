import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../../config/product-brand.js";
import {
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  PublicCommunityClient,
} from "../public/community-data.js";
import {
  COMMUNITY_METRIC_LABELS,
  renderCommunitySnapshot,
} from "../public/community-view.js";
import {
  configuredInstallerRelease,
  configuredSemanticOpenTarget,
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
  assert.match(html, /id="open-installed-app"/u);
  assert.match(html, /id="community-result"/u);
  assert.match(html, /id="community-snapshot-service-detail"/u);
  assert.match(html, /id="community-service-state"/u);
  assert.match(html, /id="community-snapshot-status"/u);
  assert.match(html, /id="community-snapshot-panel-state"/u);

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
  assert.equal(
    html.split(SEMANTIC_OPEN_TARGET_PLACEHOLDER).length - 1,
    1,
  );
});

test("the public community client exposes one read-only aggregate request", async () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(PublicCommunityClient.prototype).sort(),
    ["communityStats", "constructor"],
  );
  const calls = [];
  const payload = { releaseStatus: "not_yet_published" };
  const client = new PublicCommunityClient({
    fetchImpl: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      };
    },
  });
  assert.equal(await client.communityStats(), payload);
  assert.deepEqual(calls, [[
    "/api/v1/stats/aggregate",
    { headers: { Accept: "application/json" } },
  ]]);

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
    failing.communityStats(),
    (error) => {
      assert.equal(error.message, "Request failed (503).");
      assert.equal(error.code, "AGGREGATE_UNAVAILABLE");
      assert.equal(error.requestId, requestId);
      assert.equal(Object.hasOwn(error, "privateDetail"), false);
      return true;
    },
  );
});

test("the first visit leads with the product, combined Mac action, and snapshot-only community view", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  assert.match(html, /<h1 id="install-title">Understand your Codex week\.<\/h1>/u);
  assert.match(html, /local-first Mac app for understanding personal Codex\s+usage/u);
  assert.match(html, /estimates your personal seven-day allowance in\s+API-equivalent terms/u);
  assert.match(html, /Download for macOS/u);
  assert.match(html, /Already installed\?/u);
  assert.match(html, /Open TiboTattle/u);
  assert.match(html, /Delayed community activity/u);
  assert.match(html, /Community activity snapshot/u);
  assert.match(html, /<section class="product-hero"[^>]*id="install"/u);
  assert.match(html, /src="\.\/tibotattle-icon\.png"/u);
  assert.match(html, /src="\.\/tibotattle-weekly-preview\.jpg"/u);
  assert.match(html, /src="\.\/apple\.svg"/u);
  assert.match(html, /Demo data/u);
  assert.match(html, /Example only — not your usage or a bill\./u);
  assert.match(html, /Your dashboard is calculated privately on your Mac\./u);
  assert.match(html, /href="https:\/\/github\.com\/adamallcock"/u);
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
  assert.doesNotMatch(
    html,
    /Community seven-day estimate|community allowance|community estimate|community capacity|best guess|privacy[- ]reviewed|privacy and quality checks/u,
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
  assert.match(html, /<h2 id="community-title">Community activity snapshot<\/h2>/u);
  assert.match(
    html,
    /Published as delayed, aggregate activity for a defined reporting period\./u,
  );
  assert.doesNotMatch(
    html,
    /privacy[- ]reviewed|privacy and quality checks|community seven-day estimate|community allowance|community estimate|community capacity|best guess/u,
  );
  assert.doesNotMatch(
    source,
    /renderCommunityEstimate|estimateContainer|estimateHero|estimateStates|id="community-estimate/u,
  );
  assert.match(source, /\.dataset\.communityState = state;/u);
  assert.match(styles, /\[data-community-state="service_unavailable"\]/u);
  assert.match(styles, /\[data-community-state="not_yet_published"\]/u);
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

test("both browser entry points share one community renderer and one install card", async () => {
  const siteSource = await readFile(SITE_SOURCE, "utf8");
  const appSource = await readFile(APP_SOURCE, "utf8");
  for (const shared of ["./community-view.js", "./install-cta.js"]) {
    assert.match(siteSource, new RegExp(`from "${shared.replace(".", "\\.")}"`, "u"));
    assert.match(appSource, new RegExp(`from "${shared.replace(".", "\\.")}"`, "u"));
  }
  // No forked copy: the dashboard entry no longer defines either renderer.
  assert.doesNotMatch(appSource, /const COMMUNITY_METRIC_LABELS = Object\.freeze/u);
  assert.doesNotMatch(appSource, /function configuredInstallerRelease\(/u);
  assert.doesNotMatch(appSource, /function formatInstallerSize\(/u);
  // The dashboard entry keeps the full companion-backed surface it always had.
  const appHtml = await readFile(APP_HTML, "utf8");
  for (
    const dashboardControl of [
      'id="refresh-button"',
      'id="contribution-form"',
      'id="identity-signin"',
      'id="community-result"',
    ]
  ) {
    assert.equal(appHtml.includes(dashboardControl), true, dashboardControl);
  }
});

test("the community view degrades honestly without a service or a published week", () => {
  for (
    const [payload, expectedState] of [
      [null, "service_unavailable"],
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
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const detail = documentRef.createElement("div");
    const state = renderCommunitySnapshot({
      documentRef,
      container,
      detail,
      payload,
    });
    assert.equal(state, expectedState);
    assert.match(container.text, /[A-Za-z]{3}/u, expectedState);
    // No empty panel and no invented figure in any degraded state.
    assert.equal(container.children.length > 0, true, expectedState);
    assert.equal(
      container.descendants().some(({ tag }) => tag === "table"),
      false,
      expectedState,
    );
  }
});

test("the public source contains no community allowance, estimate, capacity, or privacy-review claim", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");
  const publicCopy = `${html}\n${source}`;
  assert.match(publicCopy, /delayed, aggregate/u);
  assert.doesNotMatch(
    publicCopy,
    /Community seven-day estimate|community allowance|community estimate|community capacity|best guess|privacy[- ]reviewed|privacy and quality checks/u,
  );
  assert.doesNotMatch(publicCopy, /id="community-estimate|renderCommunityEstimate/u);
});

test("the generated community state follows the active UI language", () => {
  const documentRef = fakeDocument();
  documentRef.documentElement.lang = "zh-Hans";
  const container = documentRef.createElement("div");
  const detail = documentRef.createElement("div");

  assert.equal(
    renderCommunitySnapshot({ documentRef, container, detail, payload: null }),
    "service_unavailable",
  );
  assert.match(container.text, /中心服务不可用/u);
  assert.match(detail.text, /不在当前契约/u);
});

test("a published community week renders its support gate, provenance, and cells", () => {
  const documentRef = fakeDocument();
  const container = documentRef.createElement("div");
  const detail = documentRef.createElement("div");
  const state = renderCommunitySnapshot({
    documentRef,
    container,
    detail,
    payload: publishedSnapshot(),
    now: Date.parse("2026-07-22T01:00:00.000Z"),
  });
  assert.equal(state, "published");
  assert.match(
    container.text,
    /at least 20 distinct eligible social-provider accounts/u,
  );
  assert.match(container.text, /an average, a cost/u);
  const table = container.descendants().find(({ tag }) => tag === "table");
  assert.ok(table, "a released week renders its cell table");
  const headerLabels = table
    .descendants()
    .filter(({ tag }) => tag === "th")
    .map(({ textContent }) => textContent);
  for (const label of Object.values(COMMUNITY_METRIC_LABELS)) {
    assert.equal(headerLabels.includes(label), true, label);
  }
  assert.match(detail.text, /community-weekly/u);
  assert.match(detail.text, /capped per eligible provider account/u);

  // The site can render the headline without the provenance container, and it
  // must not invent one.
  const bare = documentRef.createElement("div");
  assert.equal(
    renderCommunitySnapshot({ documentRef, container: bare, payload: publishedSnapshot() }),
    "published",
  );
  assert.equal(
    bare.descendants().some(({ tag }) => tag === "table"),
    true,
  );
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
    "usage-monitor-semantic-open-target": "usagemonitor://open",
  };
  const ready = fakeDocument(complete);
  const release = configuredInstallerRelease(ready);
  assert.equal(release.version, "1.2.3");
  assert.equal(configuredSemanticOpenTarget(ready), "usagemonitor://open");
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
  assert.equal(
    configuredSemanticOpenTarget(fakeDocument({
      "usage-monitor-semantic-open-target": "https://example.org/open",
    })),
    null,
  );
});
