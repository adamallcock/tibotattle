import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  COMMUNITY_METRIC_LABELS,
  COMMUNITY_SNAPSHOT_STATE_COPY,
  renderCommunitySnapshot,
} from "../public/community-view.js";
import {
  renderPublicInstallerJourney,
  setPublicSnapshotPresentation,
} from "../public/community.js";
import {
  configuredInstallerRelease,
  configuredSemanticOpenTarget,
  formatInstallerSize,
  renderInstallerJourney,
} from "../public/install-cta.js";

const SITE_HTML = new URL("../public/community.html", import.meta.url);
const SITE_SOURCE = new URL("../public/community.js", import.meta.url);
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
    privacyPolicy: {
      version: "community-weekly-v0.1",
      minimumIndependentParticipants: 20,
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

test("the public site presents the community snapshot first and a fail-closed download CTA", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");

  assert.match(html, /<script type="module" src="\.\/community\.js">/u);
  assert.match(html, /id="hero-title"/u);
  assert.match(html, /id="community"/u);
  assert.match(html, /id="download"/u);
  assert.match(html, /id="faq"/u);
  assert.match(html, /Download for Mac/u);
  assert.match(html, /privacy-safe seven-day community snapshot/u);
  assert.match(html, /community seven-day allowance estimate will appear only after/u);
  assert.match(html, /id="installer-link"/u);
  assert.match(html, /id="installer-details"/u);
  assert.match(html, /id="installer-unavailable"/u);
  assert.match(html, /id="installer-steps" hidden/u);
  assert.match(html, /id="download-nav-link"/u);
  assert.match(html, /id="download-hero-link"/u);
  assert.match(html, /id="community-result"/u);
  assert.match(html, /id="community-snapshot-service-detail"/u);
  assert.match(html, /id="community-service-state"/u);
  assert.match(html, /id="community-snapshot-title">Seven-day community snapshot/u);
  assert.doesNotMatch(html, /Published seven-day snapshot/u);
  assert.ok(
    html.indexOf('id="community"') < html.indexOf('id="download"'),
    "the community snapshot precedes the download section",
  );
  assert.doesNotMatch(
    html,
    /open-installed-app|usage-monitor-semantic-open-target|usagemonitor:\/\/open/u,
  );

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
      "./navigation.js",
      "./admin.js",
      "./admin-client.js",
      "./data-client.js",
      "./install-cta.js",
      "LocalCompanionClient",
      "createTelemetryEnvelope",
      "createGoogleSignInRequest",
      "registerUpload",
      "contributeSerialized",
      "./lib.js",
    ]
  ) {
    assert.equal(source.includes(companionOnlyModule), false, companionOnlyModule);
  }
  assert.match(html, /<img[^>]+src="\.\/tibotattle-icon\.png"/u);

  // Accessibility: the site keeps a skip link, named landmarks, keyboard
  // focus rings, and native details/summary FAQ disclosures.
  assert.match(html, /<a class="skip-link" href="#main">/u);
  assert.match(html, /<main id="main">/u);
  assert.match(html, /<nav class="primary-nav" aria-label="Site sections">/u);
  assert.match(html, /aria-labelledby="community-title"/u);
  assert.match(html, /aria-labelledby="download-title"/u);
  assert.match(html, /aria-labelledby="faq-title"/u);
  assert.match(
    await readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    /button:focus-visible, input:focus-visible, a:focus-visible/u,
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
  assert.doesNotMatch(html, /semantic-open-target|open-installed-app/u);
});

test("browser entry points share the renderer without shipping local app controls", async () => {
  const siteSource = await readFile(SITE_SOURCE, "utf8");
  const appSource = await readFile(APP_SOURCE, "utf8");
  assert.match(siteSource, /from "\.\/community-view\.js"/u);
  assert.match(appSource, /from "\.\/community-view\.js"/u);
  assert.doesNotMatch(siteSource, /from "\.\/install-cta\.js"/u);
  assert.match(appSource, /from "\.\/install-cta\.js"/u);
  // No forked copy: the dashboard entry no longer defines the community
  // renderer, while the public entry keeps its own companion-free install
  // card instead of shipping the app-open helper.
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
    assert.equal(
      container.text.includes(COMMUNITY_SNAPSHOT_STATE_COPY[expectedState]),
      true,
      expectedState,
    );
    // No empty panel and no invented figure in any degraded state.
    assert.equal(container.children.length > 0, true, expectedState);
    assert.equal(
      container.descendants().some(({ tag }) => tag === "table"),
      false,
      expectedState,
    );
  }
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
  assert.match(container.text, /at least 20 different participants/u);
  assert.match(container.text, /not an average, and not a cost/u);
  const table = container.descendants().find(({ tag }) => tag === "table");
  assert.ok(table, "a released week renders its cell table");
  const breakdown = container.descendants().find(({ tag, className }) => (
    tag === "details" && className.includes("snapshot-breakdown")
  ));
  assert.ok(breakdown, "the detailed cell table is opt-in disclosure content");
  assert.equal(breakdown.descendants().includes(table), true);
  const headerLabels = table
    .descendants()
    .filter(({ tag }) => tag === "th")
    .map(({ textContent }) => textContent);
  for (const label of Object.values(COMMUNITY_METRIC_LABELS)) {
    assert.equal(headerLabels.includes(label), true, label);
  }
  assert.match(detail.text, /community-weekly/u);
  assert.match(detail.text, /clipped per participant/u);

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
  assert.equal(
    bare.descendants().some(({ tag, className }) => (
      tag === "details" && className.includes("snapshot-breakdown")
    )),
    true,
  );
});

test("the public page names only a verified installer as a download", () => {
  const complete = {
    "usage-monitor-installer-url": "https://downloads.example.org/TiboTattle.dmg",
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
  const unavailable = fakeDocument();
  assert.equal(renderPublicInstallerJourney(unavailable), null);
  assert.equal(unavailable.byId.get("installer-steps").hidden, true);
  assert.equal(unavailable.byId.get("download-nav-link").textContent, "Mac app");
  assert.equal(
    unavailable.byId.get("download-hero-link").textContent,
    "Mac app availability",
  );

  const ready = fakeDocument(complete);
  assert.equal(renderPublicInstallerJourney(ready)?.version, "1.2.3");
  assert.equal(ready.byId.get("installer-steps").hidden, false);
  assert.equal(ready.byId.get("download-nav-link").textContent, "Download");
  assert.equal(ready.byId.get("download-hero-link").textContent, "Download for Mac");
});

test("the public snapshot badge reports reader-facing snapshot state", () => {
  const unavailable = fakeDocument();
  setPublicSnapshotPresentation(unavailable, "service_unavailable", { failed: true });
  assert.equal(
    unavailable.byId.get("community-service-state").textContent,
    "Snapshot temporarily unavailable",
  );
  assert.equal(
    unavailable.byId.get("community-snapshot-title").textContent,
    "Seven-day community snapshot",
  );

  const published = fakeDocument();
  setPublicSnapshotPresentation(published, "published");
  assert.equal(
    published.byId.get("community-service-state").textContent,
    "Snapshot available",
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
    assert.equal(documentRef.byId.get("installer-unavailable").hidden, false);
    assert.equal(
      Object.hasOwn(documentRef.byId.get("installer-link"), "href"),
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
