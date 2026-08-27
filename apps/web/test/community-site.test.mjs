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
  HOMEBREW_INSTALL_COMMAND,
  copyInstallerChecksum,
  copyHomebrewInstallCommand,
  detectPublicPlatform,
  resolveInitialPublicPlatform,
  wirePublicPlatformSelector,
} from "../public/community.js";
import {
  compactMacOSVersion,
  configuredInstallerRelease,
  formatInstallerSize,
  renderInstallerAssurance,
  renderInstallerJourney,
} from "../public/install-cta.js";

const SITE_HTML = new URL("../public/community.html", import.meta.url);
const SITE_SOURCE = new URL("../public/community.js", import.meta.url);
const DOCS_HTML = new URL("../public/docs.html", import.meta.url);
const VERIFY_RELEASE = new URL("../../../docs/verify-release.md", import.meta.url);
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

function openingTagForId(html, id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "u"));
  assert.ok(match, `${id} has an opening tag`);
  return match[0];
}

class FakePlatformNode {
  constructor({ dataset = {}, hidden = false } = {}) {
    this.attributes = new Map();
    this.dataset = { ...dataset };
    this.hidden = hidden;
    this.focusCount = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, event) {
    this.listeners.get(type)?.(event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.focusCount += 1;
  }

  closest(selector) {
    return selector === '[role="tab"][data-platform]' && this.dataset.platform
      ? this
      : null;
  }
}

function fakePlatformSelectorDocument({ missingPanel = null } = {}) {
  const platforms = ["macos", "windows", "linux"];
  const tabs = new Map(platforms.map((platform) => [
    platform,
    new FakePlatformNode({ dataset: { platform } }),
  ]));
  const panels = new Map(platforms
    .filter((platform) => platform !== missingPanel)
    .map((platform) => [
      platform,
      new FakePlatformNode({
        dataset: { platformPanel: platform },
        hidden: platform !== "macos",
      }),
    ]));
  const selector = new FakePlatformNode({ hidden: true });
  selector.querySelectorAll = (query) => query === '[role="tab"][data-platform]'
    ? [...tabs.values()]
    : [];
  selector.contains = (candidate) => [...tabs.values()].includes(candidate);
  const documentRef = {
    documentElement: { dataset: {} },
    querySelector(query) {
      return query === "#platform-selector" ? selector : null;
    },
    querySelectorAll(query) {
      return query === "[data-platform-panel]" ? [...panels.values()] : [];
    },
  };
  return { documentRef, panels, selector, tabs };
}

function recordingStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  return {
    getItem(key) {
      reads.push(key);
      return values.get(key) ?? null;
    },
    reads,
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
    values,
    writes,
  };
}

function assertPlatformSelection(fixture, selectedPlatform) {
  assert.equal(
    fixture.documentRef.documentElement.dataset.downloadPlatform,
    selectedPlatform,
  );
  assert.equal(fixture.selector.hidden, false);
  for (const platform of ["macos", "windows", "linux"]) {
    assert.equal(
      fixture.tabs.get(platform).attributes.get("aria-selected"),
      String(platform === selectedPlatform),
      `${platform} aria-selected`,
    );
    assert.equal(
      fixture.tabs.get(platform).attributes.get("tabindex"),
      platform === selectedPlatform ? "0" : "-1",
      `${platform} tabindex`,
    );
    assert.equal(
      fixture.panels.get(platform).hidden,
      platform !== selectedPlatform,
      `${platform} panel visibility`,
    );
  }
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
  assert.match(
    html,
    /id="installer-sha256-copy"[\s\S]*?aria-describedby="installer-sha256-copy-status"/u,
  );
  assert.match(html, /id="installer-sha256"[\s\S]*?data-i18n-skip[\s\S]*?hidden/u);
  assert.match(html, /id="download-assurance"[^>]*hidden/u);
  assert.match(html, /Developer ID signed and Apple notarized\./u);
  assert.match(html, /href="\.\/docs\.html#download-security"/u);
  assert.doesNotMatch(
    html,
    /How can I trust this download\?|Published SHA-256|integrity, not safety|installer-trust-/u,
  );
  assert.doesNotMatch(html, /installer-verification|role="tooltip"/u);
  assert.match(html, /id="installer-unavailable"/u);
  assert.match(html, /id="homebrew-install"[^>]*hidden/u);
  assert.match(html, /id="homebrew-copy-button"/u);
  assert.doesNotMatch(html, /open-installed-app|usage-monitor-semantic-open-target|usagemonitor:\/\//u);
  assert.match(html, /id="community-daily-result"/u);
  assert.match(html, /id="community-daily-state"/u);
  assert.match(html, /id="community-daily-hero"/u);
  assert.match(
    html,
    /id="community-method-summary"[^>]*>See community activity<\/summary>/u,
  );
  assert.doesNotMatch(html, /community-daily-status|community-daily-panel-state/u);

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
  assert.match(html, /data-language-picker-resolved/u);
  assert.match(html, /data-language-announcement[^>]*aria-live="polite"/u);
  assert.match(
    html,
    /<nav\s+class="primary-nav"\s+aria-label="Site sections"(?:\s[^>]*)?>/u,
  );
  assert.match(html, /aria-labelledby="install-title"/u);
  const tablist = openingTagForId(html, "platform-selector");
  assert.match(tablist, /\brole="tablist"/u);
  assert.match(tablist, /\baria-label="Choose your platform"/u);
  assert.match(tablist, /\bhidden(?:\s|>)/u);
  for (const platform of ["macos", "windows", "linux"]) {
    const tab = openingTagForId(html, `platform-tab-${platform}`);
    assert.match(tab, /\brole="tab"/u);
    assert.match(tab, new RegExp(`\\baria-controls="platform-panel-${platform}"`, "u"));
    const panel = openingTagForId(html, `platform-panel-${platform}`);
    assert.match(panel, /\brole="tabpanel"/u);
    assert.match(panel, new RegExp(`\\baria-labelledby="platform-tab-${platform}"`, "u"));
    assert.match(panel, /\btabindex="0"/u);
  }
  assert.doesNotMatch(
    openingTagForId(html, "platform-panel-macos"),
    /\bhidden(?:\s|>)/u,
    "macOS remains the usable no-JavaScript fallback",
  );
  assert.match(html, /aria-labelledby="community-method-summary"/u);
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

test("the first visit leads with the product, platform choice, and daily community view", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  assert.match(html, /<h1 id="install-title">What the Codex allowance is really worth\.<\/h1>/u);
  assert.match(html, /turns your seven-day Codex allowance into an\s+API-price-equivalent estimate/u);
  assert.match(html, /calculates your personal dashboard locally on your computer\./u);
  assert.doesNotMatch(html, /calculates your personal dashboard on your Mac\./u);
  assert.match(html, /id="header-download-label"[^>]*>\s*Get the app\s*<\/span>/u);
  assert.doesNotMatch(html, /Get the Mac app/u);
  for (const [platform, label] of [
    ["macos", "macOS"],
    ["windows", "Windows"],
    ["linux", "Linux"],
  ]) {
    const start = html.indexOf(`id="platform-tab-${platform}"`);
    const end = html.indexOf("</button>", start);
    assert.ok(start >= 0 && end > start, `${label} tab is complete`);
    assert.match(html.slice(start, end), new RegExp(`>${label}<\\/span>`, "u"));
    assert.doesNotMatch(
      html.slice(start, end),
      /<small\b/u,
      `${label} keeps availability detail in its panel instead of the selector`,
    );
  }
  assert.match(html, /Download for macOS/u);
  assert.equal(
    html.match(/Download for macOS/gu)?.length,
    2,
    "the verified and unavailable macOS actions retain their platform-specific labels",
  );
  assert.match(html, /Copy SHA-256/u);
  assert.match(
    html,
    /brew install --cask adamallcock\/tap\/tibotattle/u,
  );
  assert.match(html, /Latest community evidence/u);
  assert.match(html, /See community activity/u);
  assert.match(html, /Community activity over time/u);
  assert.match(
    html,
    /Delayed, aggregate daily totals from optional contributions\./u,
  );
  assert.doesNotMatch(html, /The community signal|Personal dashboards and contributions stay in the Mac app\./u);
  assert.doesNotMatch(html, /community-estimate-summary|community-daily-panel-state|community-daily-status/u);
  assert.match(html, /Install the desktop app/u);
  assert.doesNotMatch(html, /Install the Mac app/u);
  assert.match(html, /See your week/u);
  assert.match(html, /Share only if you choose/u);
  assert.match(html, /<section class="product-hero"[^>]*id="install"/u);
  assert.match(html, /src="\.\/tibotattle-icon\.png"/u);
  assert.match(html, /src="\.\/apple\.svg"/u);
  assert.match(html, /<section class="community-window" aria-labelledby="community-allowance-heading">/u);
  assert.match(html, /Community view/u);
  assert.match(html, /id="community-allowance-figure"/u);
  assert.doesNotMatch(
    html,
    /tibotattle-weekly-preview\.jpg|Demo data|Example only — not your usage or a bill\./u,
  );
  assert.match(html, /href="https:\/\/github\.com\/adamallcock\/tibotattle"/u);
  assert.match(html, /href="https:\/\/x\.com\/adamallcock"/u);
  assert.match(html, /footer-social-label">X<\/span>/u);
  assert.match(html, /href="\.\/docs\.html">Docs<\/a>/u);
  assert.match(html, /href="\.\/privacy\.html">Privacy<\/a>/u);
  assert.doesNotMatch(
    html,
    /github\.com\/adamallcock\/app-usagemonitor/u,
  );
  assert.match(html, /id="installer-link"/u);
  assert.ok(
    html.indexOf('id="installer-link"') < html.indexOf('id="community"'),
    "the primary installer action appears before the community activity section",
  );
  assert.ok(
    html.indexOf('id="community-allowance-figure"') < html.indexOf('id="how-it-works"'),
    "the live community allowance appears before the supporting feature strip",
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

test("platform tabs keep the live macOS release separate from honest unavailable panels", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const macosStart = html.indexOf('id="platform-panel-macos"');
  const windowsStart = html.indexOf('id="platform-panel-windows"');
  const linuxStart = html.indexOf('id="platform-panel-linux"');
  const panelsEnd = html.indexOf('class="community-inline"', linuxStart);

  assert.ok(macosStart >= 0, "macOS panel exists");
  assert.ok(windowsStart > macosStart, "Windows panel follows macOS");
  assert.ok(linuxStart > windowsStart, "Linux panel follows Windows");
  assert.ok(panelsEnd > linuxStart, "platform panels end before community activity");

  const macosPanel = html.slice(macosStart, windowsStart);
  const windowsPanel = html.slice(windowsStart, linuxStart);
  const linuxPanel = html.slice(linuxStart, panelsEnd);

  assert.match(macosPanel, /id="installer-link"/u);
  assert.match(macosPanel, /id="homebrew-install"/u);
  assert.match(macosPanel, /id="installer-sha256-copy"/u);
  assert.match(macosPanel, /Developer ID signed and Apple notarized\./u);

  for (const [platform, panel] of [
    ["Windows", windowsPanel],
    ["Linux", linuxPanel],
  ]) {
    assert.match(panel, new RegExp(`${platform} is not yet available`, "u"));
    assert.match(panel, /Not yet available/u);
    assert.doesNotMatch(panel, /id="installer-|id="homebrew-|brew install/iu);
    assert.doesNotMatch(panel, /Download for|\.dmg\b|\.exe\b|\.msi\b|AppImage/iu);
    assert.doesNotMatch(panel, /<a\b[^>]*class="[^"]*\bbutton\b/iu);
    assert.doesNotMatch(panel, /<button\b[^>]*disabled/iu);
  }
  assert.match(windowsPanel, /tibotattle\/issues\/3/u);
  assert.match(linuxPanel, /tibotattle\/issues\/4/u);

  const macosTab = openingTagForId(html, "platform-tab-macos");
  assert.match(macosTab, /\baria-selected="true"/u);
  assert.match(macosTab, /\btabindex="0"/u);
  for (const platform of ["windows", "linux"]) {
    const tab = openingTagForId(html, `platform-tab-${platform}`);
    assert.match(tab, /\baria-selected="false"/u);
    assert.match(tab, /\btabindex="-1"/u);
    assert.match(openingTagForId(html, `platform-panel-${platform}`), /\bhidden(?:\s|>)/u);
  }
});

test("platform detection is conservative and explicit choices take precedence", () => {
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "Windows",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }),
    "windows",
  );
  assert.equal(
    detectPublicPlatform({ userAgentDataPlatform: "macOS", userAgent: "" }),
    "macos",
  );
  assert.equal(
    detectPublicPlatform({ userAgentDataPlatform: "Linux", userAgent: "" }),
    "linux",
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }),
    "windows",
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }),
    "macos",
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    }),
    "linux",
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "",
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
    }),
    null,
    "Android's Linux token must not imply Linux desktop availability",
  );
  assert.equal(
    detectPublicPlatform({ userAgentDataPlatform: "Chrome OS", userAgent: "" }),
    null,
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 5,
    }),
    null,
    "an iPad presenting a desktop Mac user agent must not select macOS",
  );
  assert.equal(
    detectPublicPlatform({
      userAgentDataPlatform: "Linux",
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0)",
    }),
    null,
    "a ChromeOS Linux token must not select a Linux desktop build",
  );

  assert.equal(
    resolveInitialPublicPlatform({
      urlPlatform: "linux",
      savedPlatform: "windows",
      detectedPlatform: "macos",
    }),
    "linux",
  );
  assert.equal(
    resolveInitialPublicPlatform({
      urlPlatform: "not-a-platform",
      savedPlatform: "windows",
      detectedPlatform: "macos",
    }),
    "windows",
  );
  assert.equal(
    resolveInitialPublicPlatform({
      urlPlatform: null,
      savedPlatform: "invalid",
      detectedPlatform: "linux",
    }),
    "linux",
  );
  assert.equal(
    resolveInitialPublicPlatform({
      urlPlatform: null,
      savedPlatform: null,
      detectedPlatform: null,
    }),
    "macos",
    "macOS remains the truthful default when no desktop platform can be inferred",
  );
});

test("the platform selector applies URL state and persists only user interaction", () => {
  const storageKey = "tibotattle.download-platform.v1";
  const storage = recordingStorage({ [storageKey]: "windows" });
  const fixture = fakePlatformSelectorDocument();
  assert.equal(
    wirePublicPlatformSelector(fixture.documentRef, {
      navigatorRef: {
        userAgentData: { platform: "macOS" },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        maxTouchPoints: 0,
      },
      locationRef: { search: "?campaign=homepage&platform=linux" },
      storage,
    }),
    "linux",
  );
  assert.equal(fixture.selector.dataset.platformBound, "true");
  assert.deepEqual(storage.reads, [storageKey]);
  assert.deepEqual(storage.writes, [], "initial selection is never persisted");
  assertPlatformSelection(fixture, "linux");

  fixture.selector.dispatch("click", { target: fixture.tabs.get("windows") });
  assertPlatformSelection(fixture, "windows");
  assert.deepEqual(storage.writes, [[storageKey, "windows"]]);

  function press(platform, key, expectedPlatform) {
    let prevented = 0;
    fixture.selector.dispatch("keydown", {
      key,
      preventDefault() {
        prevented += 1;
      },
      target: fixture.tabs.get(platform),
    });
    assert.equal(prevented, 1, `${key} prevents native scrolling`);
    assertPlatformSelection(fixture, expectedPlatform);
    assert.ok(
      fixture.tabs.get(expectedPlatform).focusCount > 0,
      `${key} moves focus to ${expectedPlatform}`,
    );
  }

  press("windows", "ArrowRight", "linux");
  press("linux", "ArrowRight", "macos");
  press("macos", "ArrowLeft", "linux");
  press("linux", "Home", "macos");
  press("macos", "End", "linux");
  assert.deepEqual(
    storage.writes.map(([, value]) => value),
    ["windows", "linux", "macos", "linux", "macos", "linux"],
  );
});

test("platform inference reveals the selector without writing session state", () => {
  const storage = recordingStorage();
  const fixture = fakePlatformSelectorDocument();
  assert.equal(
    wirePublicPlatformSelector(fixture.documentRef, {
      navigatorRef: {
        userAgentData: { platform: "Windows" },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      locationRef: { search: "" },
      storage,
    }),
    "windows",
  );
  assertPlatformSelection(fixture, "windows");
  assert.deepEqual(storage.writes, []);
});

test("mobile Mac and ChromeOS hints fall back safely through the wired selector", () => {
  for (const [label, navigatorRef] of [
    ["iPad", {
      userAgentData: { platform: "macOS" },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 5,
    }],
    ["ChromeOS", {
      userAgentData: { platform: "Linux" },
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0)",
      maxTouchPoints: 0,
    }],
  ]) {
    const storage = recordingStorage();
    const fixture = fakePlatformSelectorDocument();
    assert.equal(
      wirePublicPlatformSelector(fixture.documentRef, {
        navigatorRef,
        locationRef: { search: "" },
        storage,
      }),
      "macos",
      label,
    );
    assertPlatformSelection(fixture, "macos");
    assert.deepEqual(storage.writes, [], label);
  }
});

test("the selector tolerates unavailable or throwing storage", () => {
  const throwingStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  for (const [label, storage] of [
    ["unavailable", null],
    ["throwing", throwingStorage],
  ]) {
    const fixture = fakePlatformSelectorDocument();
    assert.equal(
      wirePublicPlatformSelector(fixture.documentRef, {
        navigatorRef: {
          userAgentData: { platform: "Windows" },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
        locationRef: { search: "" },
        storage,
      }),
      "windows",
      label,
    );
    assertPlatformSelection(fixture, "windows");
    assert.doesNotThrow(() => fixture.selector.dispatch("click", {
      target: fixture.tabs.get("linux"),
    }));
    assertPlatformSelection(fixture, "linux");
  }
});

test("a malformed platform selector fails closed before binding", () => {
  const fixture = fakePlatformSelectorDocument({ missingPanel: "linux" });
  const storage = recordingStorage();
  assert.equal(
    wirePublicPlatformSelector(fixture.documentRef, {
      navigatorRef: { userAgentData: { platform: "Linux" } },
      locationRef: { search: "?platform=linux" },
      storage,
    }),
    null,
  );
  assert.equal(fixture.selector.hidden, true);
  assert.equal(fixture.selector.dataset.platformBound, undefined);
  assert.equal(fixture.documentRef.documentElement.dataset.downloadPlatform, undefined);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test("the Homebrew action copies only the fixed first-party tap command", async () => {
  const writes = [];
  assert.equal(
    await copyHomebrewInstallCommand({
      async writeText(value) {
        writes.push(value);
      },
    }),
    true,
  );
  assert.deepEqual(writes, [HOMEBREW_INSTALL_COMMAND]);
  assert.equal(
    HOMEBREW_INSTALL_COMMAND,
    "brew install --cask adamallcock/tap/tibotattle",
  );
  assert.equal(await copyHomebrewInstallCommand(null), false);
  assert.equal(
    await copyHomebrewInstallCommand({
      async writeText() {
        throw new Error("clipboard blocked");
      },
    }),
    false,
  );
});

test("the installer checksum action copies only a complete SHA-256 digest", async () => {
  const checksum = "a".repeat(64);
  const writes = [];
  assert.equal(
    await copyInstallerChecksum(checksum, {
      async writeText(value) {
        writes.push(value);
      },
    }),
    true,
  );
  assert.deepEqual(writes, [checksum]);
  assert.equal(await copyInstallerChecksum("a".repeat(63), null), false);
  assert.equal(await copyInstallerChecksum("A".repeat(64), null), false);
  assert.equal(
    await copyInstallerChecksum(checksum, {
      async writeText() {
        throw new Error("clipboard blocked");
      },
    }),
    false,
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
  assert.match(
    styles,
    /\.community-site \.community-window-content \{\s*padding: 22px;/u,
  );
  assert.doesNotMatch(styles, /font-size: clamp\(3\.15rem, 16vw, 5\.2rem\);/u);
});

test("the Homebrew command stays bounded and readable at narrow widths", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.community-site \.hero-copy \{[\s\S]*?min-width: 0;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 420px\) \{[\s\S]*?\.community-site \.install-actions \{\s*flex-direction: column;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 420px\) \{[\s\S]*?\.community-site \.homebrew-install code \{\s*overflow-x: visible;\s*white-space: normal;/u,
  );
  assert.match(
    styles,
    /\.community-site \.homebrew-install code \{[\s\S]*?font-size: \.6rem;/u,
    "the long fixed command uses the deliberately smaller desktop type size",
  );
});

test("the platform selector stays a quiet compact line above the active download", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const selectorRule = styles.match(/\.community-site \.platform-selector \{([^}]*)\}/u)?.[1] ?? "";
  const tabRule = styles.match(/\.community-site \.platform-tab \{([^}]*)\}/u)?.[1] ?? "";
  const selectedRule = styles.match(/\.community-site \.platform-tab\[aria-selected="true"\] \{([^}]*)\}/u)?.[1] ?? "";

  assert.match(selectorRule, /display: inline-flex;/u);
  assert.match(selectorRule, /flex-wrap: nowrap;/u);
  assert.match(selectorRule, /width: auto;/u);
  assert.match(selectorRule, /border: 0;/u);
  assert.match(selectorRule, /background: transparent;/u);
  assert.match(selectorRule, /box-shadow: none;/u);
  assert.match(tabRule, /min-height: 32px;/u);
  assert.match(
    styles,
    /\.community-site \.platform-tab \+ \.platform-tab \{\s*border-inline-start: 1px solid/u,
  );
  assert.match(selectedRule, /border-bottom-color: var\(--site-green-bright\);/u);
  assert.match(selectedRule, /font-weight: var\(--weight-bold\);/u);
  assert.match(selectedRule, /background: transparent;/u);
  assert.match(selectedRule, /box-shadow: none;/u);
});

test("the public header and footer stay compact on narrow screens", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.community-site \.topbar \{[\s\S]*?min-height: 64px;/u,
  );
  assert.match(
    styles,
    /\.community-site \.primary-nav a \{[\s\S]*?width: auto;[\s\S]*?white-space: nowrap;/u,
  );
  assert.match(
    styles,
    /\.community-site \.primary-nav \{[\s\S]*?flex-wrap: nowrap;/u,
  );
  assert.match(
    styles,
    /\.community-site \.topbar \.primary-nav \{\s*justify-self: stretch;/u,
  );
  assert.match(
    styles,
    /\.community-site \.language-picker select \{[\s\S]*?min-width: 5\.2rem;[\s\S]*?background: rgba\(255, 253, 247, \.07\);/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.topbar \{\s*min-height: 0;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.primary-nav \{\s*display: flex;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.brand \{\s*gap: \.45rem;[\s\S]*?\.community-site \.header-download \{\s*justify-content: center;\s*width: 36px;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.brand > span \{\s*min-width: 0;[\s\S]*?max-width: clamp\(4\.4rem, 15vw, 7\.2rem\);[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.header-download-label \{\s*position: absolute;/u,
  );
  assert.match(styles, /\.community-site \.brand \{\s*min-width: 0;/u);
  assert.doesNotMatch(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site \.primary-nav \{\s*display: none;/u,
  );
  assert.doesNotMatch(styles, /grid-template-areas:|navigation navigation/u);
  assert.ok(
    html.indexOf('class="language-picker"')
      < html.indexOf('class="brand"')
      && html.indexOf('class="brand"') < html.indexOf('class="primary-nav"')
      && html.indexOf('class="primary-nav"') < html.indexOf('class="header-download"'),
    "the narrow header keeps language, brand, navigation, and download in one source order",
  );
  assert.match(
    styles,
    /@media \(max-width: 700px\) \{[\s\S]*?\.community-site footer \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/u,
  );
  assert.doesNotMatch(
    styles,
    /@media \(max-width: 420px\) \{[\s\S]*?\.community-site footer \{[\s\S]*?flex-direction: column;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 420px\) \{[\s\S]*?\.community-site \.topbar \{\s*column-gap: 3px;\s*padding-inline: 8px;[\s\S]*?\.community-site \.brand-icon \{\s*width: 26px;/u,
  );
});

test("unavailable community activity uses the compact public state", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /data-community-state="checking"/u);
  assert.match(
    html,
    /class="community-proof community-proof-compact"[\s\S]*?aria-labelledby="community-method-summary"/u,
  );
  assert.match(
    html,
    /<summary id="community-method-summary"[^>]*>See community activity<\/summary>/u,
  );
  assert.match(html, /Community activity over time/u);
  assert.match(
    html,
    /This public view includes no prompts, responses, or account details\./u,
  );
  assert.doesNotMatch(
    html,
    /community-proof-heading|The community signal|The community view pools delayed, anonymous contributions|Personal dashboards and contributions stay in the Mac app\./u,
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
  assert.match(styles, /\.community-site \.community-proof-compact \{\s*padding: clamp\(24px, 3vw, 36px\) 0 0;/u);
  assert.doesNotMatch(styles, /installer-verification|text-decoration-style:\s*wavy/u);
});

test("the public guidance pages are useful stubs without app-only controls", async () => {
  const docs = await readFile(DOCS_HTML, "utf8");
  const verifyRelease = await readFile(VERIFY_RELEASE, "utf8");
  const privacy = await readFile(PRIVACY_HTML, "utf8");
  assert.match(docs, /<title>TiboTattle Docs<\/title>/u);
  assert.match(
    docs,
    /Estimated API-equivalent value of the observed seven-day allowance\./u,
  );
  assert.match(docs, /Activity totals alone are never presented as an allowance\./u);
  assert.match(docs, /id="download-security"/u);
  assert.match(docs, /A download you can check/u);
  assert.match(docs, /Signed for the platform/u);
  assert.match(docs, /release-manifest\.json/u);
  assert.match(docs, /fields not published are explicitly null/u);
  assert.match(docs, /complete non-null evidence set/u);
  assert.match(docs, /independent verifier can check against the artifact/u);
  assert.doesNotMatch(docs, /verified provenance bundles/u);
  assert.match(docs, /website\s+exposes availability and digest/u);
  assert.match(docs, /Read the full verification guide on GitHub/u);
  assert.doesNotMatch(docs, /gh attestation verify|Get-AuthenticodeSignature|sha256sum|verification-command/u);
  assert.match(verifyRelease, /# Verify a TiboTattle release/u);
  assert.match(verifyRelease, /gh release verify-asset/u);
  assert.match(verifyRelease, /gh release download "\$VERSION" --repo "\$REPO"/u);
  assert.match(verifyRelease, /npm run release:evidence:validate --/u);
  assert.match(verifyRelease, /### Important: v0\.1\.12 is a legacy release/u);
  assert.ok(
    verifyRelease.indexOf("### Important: v0.1.12 is a legacy release")
      < verifyRelease.indexOf('gh release verify "$VERSION"'),
    "the legacy release caveat appears before release-level verification commands",
  );
  assert.match(verifyRelease, /--bundle "\$PROVENANCE_BUNDLE"/u);
  assert.match(verifyRelease, /--bundle "\$SBOM_BUNDLE"/u);
  assert.match(verifyRelease, /https:\/\/spdx\.dev\/Document\/v2\.3/u);
  assert.match(verifyRelease, /--source-ref "refs\/tags\/\$VERSION"/u);
  assert.match(verifyRelease, /--source-digest "\$COMMIT"/u);
  assert.match(verifyRelease, /--signer-workflow/u);
  assert.match(verifyRelease, /### macOS direct DMG/u);
  assert.match(verifyRelease, /### Windows direct installer or MSIX/u);
  assert.match(verifyRelease, /### Linux AppImage/u);
  assert.match(verifyRelease, /Mac App Store/u);
  assert.match(verifyRelease, /does not prove safety/u);
  assert.match(privacy, /<title>TiboTattle Privacy Overview<\/title>/u);
  assert.match(privacy, /This website cannot read local Codex files\./u);
  assert.match(privacy, /Nothing is contributed unless you review and opt in\./u);
  for (const page of [docs, privacy]) {
    assert.match(page, /href="\.\/community\.html#download"/u);
    assert.match(
      page,
      /<span class="header-download-label">Download<\/span>/u,
      "resource-page download labels must collapse without clipping on narrow headers",
    );
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

// The real community allowance is the hero visual. It must remain a live,
// honestly-labelled aggregate rather than turning back into a static dashboard
// mockup, while the compact daily-activity disclosure stays immediately above
// the supporting feature strip.
test("the community allowance surface leads the product hero with honest labeling", async () => {
  const html = await readFile(SITE_HTML, "utf8");
  const source = await readFile(SITE_SOURCE, "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="community-allowance-figure"/u);
  assert.match(html, /id="community-allowance-result"/u);
  assert.match(html, /id="community-allowance-state"/u);
  assert.match(html, /id="community-allowance-range-controls"/u);
  // The allowance figure occupies the hero. The compact daily-activity
  // disclosure follows it, before the supporting feature strip.
  const heroIndex = html.indexOf('class="product-hero"');
  const featureIndex = html.indexOf('id="how-it-works"');
  const communityIndex = html.indexOf('id="community"');
  const allowanceIndex = html.indexOf('id="community-allowance-figure"');
  const dailyIndex = html.indexOf('class="community-method"');
  assert.ok(heroIndex >= 0 && allowanceIndex > heroIndex);
  assert.ok(allowanceIndex < featureIndex);
  assert.ok(
    allowanceIndex < communityIndex && communityIndex < dailyIndex && dailyIndex < featureIndex,
    "the daily-activity disclosure renders above the supporting feature strip",
  );
  // The honest recomputation horizon is 70 days, so 90d would duplicate All.
  for (const control of ['data-range-days="30"', 'data-range-days=""']) {
    assert.match(html, new RegExp(control, "u"), control);
  }
  assert.doesNotMatch(html, /data-range-days="90"/u);
  assert.match(
    html,
    /data-range-days="30" class="active" aria-pressed="true"/u,
  );
  assert.match(html, /Combined Pro 20x-equivalent allowance/u);
  assert.match(html, /One combined estimate across contributing personal-plan accounts/u);
  assert.doesNotMatch(html, /data-allowance-mode|By plan|plan selector/u);

  // The larger chart is a standard native-dialog lightbox. The launcher is
  // hidden until a published chart is actually renderable, then exposes the
  // dialog relationship to assistive technology without invoking browser
  // fullscreen mode.
  const launcherIndex = html.indexOf('id="community-allowance-expand"');
  assert.ok(launcherIndex >= 0, "the allowance chart has an expand launcher");
  const launcherMarkup = html.slice(
    html.lastIndexOf("<button", launcherIndex),
    html.indexOf("</button>", launcherIndex) + "</button>".length,
  );
  assert.match(launcherMarkup, /aria-haspopup="dialog"/u);
  assert.match(launcherMarkup, /aria-controls="community-allowance-dialog"/u);
  assert.match(launcherMarkup, /aria-label="Expand community allowance chart"/u);
  assert.match(launcherMarkup, /\shidden(?:\s|>)/u);

  assert.match(
    html,
    /<dialog[\s\S]*?id="community-allowance-dialog"[\s\S]*?aria-labelledby="community-allowance-dialog-title"[\s\S]*?aria-describedby="community-allowance-dialog-copy"/u,
  );
  assert.match(
    html,
    /<h2 id="community-allowance-dialog-title"[^>]*>Explore community allowance history<\/h2>/u,
  );
  assert.match(
    html,
    /id="community-allowance-dialog-close"[\s\S]*?type="button"[\s\S]*?aria-label="Close expanded community allowance chart"/u,
  );
  assert.match(html, /id="community-allowance-dialog-range-controls"/u);
  assert.equal(
    html.match(/data-allowance-range-controls/g)?.length,
    2,
    "inline and expanded views expose the same synchronized range contract",
  );

  assert.match(source, /renderCommunityAllowanceSection/u);
  assert.match(source, /syncAllowanceRangeControls/u);
  assert.match(source, /launcher\.hidden = !available;/u);
  assert.match(source, /dialog\.showModal\(\);/u);
  assert.match(source, /closeButton\.focus\(\);/u);
  assert.match(source, /dialog\.addEventListener\("close"/u);
  assert.match(source, /allowanceDialogReturnFocus\?\.focus\?\.\(\);/u);
  assert.match(styles, /\.community-site \.community-chart-dialog::backdrop/u);
  assert.match(
    styles,
    /\.community-site \.community-chart-dialog \{\s*width: min\(1180px, calc\(100vw - 32px\)\);/u,
  );

  const publicCopy = `${html}\n${source}`;
  assert.doesNotMatch(
    publicCopy,
    /The community signal|The community view pools delayed, anonymous contributions|Personal dashboards and contributions stay in the Mac app\./u,
  );
  assert.doesNotMatch(publicCopy, /Demo data|Example only — not your usage or a bill\./u);
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
    allowanceState: "ready",
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

test("a published daily series renders friendly cumulative activity, latest-first", () => {
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
  const quality = container.descendants().find(
    (element) => element.className === "snapshot-quality-grid",
  );
  assert.ok(quality, "the reader-facing activity summary is present");
  const terms = quality.descendants()
    .filter(({ tag }) => tag === "dt")
    .map(({ textContent }) => textContent);
  const values = quality.descendants()
    .filter(({ tag }) => tag === "dd")
    .map(({ textContent }) => textContent);
  const details = quality.descendants()
    .filter(({ tag }) => tag === "small")
    .map(({ textContent }) => textContent);
  assert.deepEqual(terms, [
    "Activity through",
    "Contributors that day",
    "Turns counted",
    "Output tokens counted",
  ]);
  assert.deepEqual(values, ["Aug 7, 2026", "3", "240", "1K"]);
  assert.deepEqual(details, [
    "Most recent community day",
    "Accounts represented on that day",
    "Usage events across 2 shared days",
    "Combined output across 2 shared days",
  ]);
  for (const retiredOperationalLabel of [
    "Latest published day",
    "Revision",
    "Revision age",
    "Released",
    "Published days in window",
  ]) {
    assert.equal(quality.text.includes(retiredOperationalLabel), false, retiredOperationalLabel);
  }
  assert.match(
    container.text,
    /Late contributions can update a day; this view always shows the newest published totals\./u,
  );

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
  ]) {
    assert.equal(columnLabels.includes(label), true, label);
  }
  // Operational publication metadata does not compete with the reader-facing
  // activity itself in either the summary or detailed table.
  assert.equal(columnLabels.includes("Revision"), false);
  assert.equal(columnLabels.includes("Released"), false);
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
  assert.match(html, /Community activity over time/u);
  assert.match(html, /Delayed, aggregate daily totals from optional contributions\./u);
  assert.doesNotMatch(html, /latest published revision/u);
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
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
    limitId: "codex",
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_plus_x20",
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
    ["wrong reference plan", allowanceBlock({ referencePlanType: "prolite" })],
    ["altered normalization", allowanceBlock({
      normalization: "pro_x1_prolite_x5_plus_x20",
    })],
    ["missing normalization", allowanceBlock({ normalization: undefined })],
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
  assert.match(container.text, /Latest published estimate \(Aug 7, 2026\)/u);
  assert.doesNotMatch(container.text, /Latest published estimate \(Aug 6, 2026\)/u);
  // The methodology note names the merged multipliers and real 40pp gate.
  assert.match(container.text, /Pro ×1, Pro 5x ×4, Plus ×20/u);
  assert.match(container.text, /40-point observed-span floor/u);
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

  // A basis cutover never renders a partly rebuilt merged history.
  {
    const documentRef = fakeDocument();
    const container = documentRef.createElement("div");
    const stateNode = documentRef.createElement("span");
    const state = renderCommunityAllowanceSection({
      documentRef,
      container,
      stateNode,
      payload: publishedDailySeries({ allowanceState: "updating" }),
    });
    assert.equal(state, "allowance_updating");
    assert.equal(stateNode.textContent, "Merged history updating");
    assert.match(container.text, /Daily activity remains available/u);
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
  assert.equal(compactMacOSVersion("14.0"), "14");
  assert.equal(compactMacOSVersion("14.0.0"), "14");
  assert.equal(compactMacOSVersion("14.1"), "14.1");
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

  const compact = fakeDocument(complete);
  assert.equal(
    renderInstallerJourney(compact, {
      compactDetails: true,
      showReleaseLinks: false,
    })?.version,
    "1.2.3",
  );
  assert.equal(
    compact.byId.get("installer-compatibility").textContent,
    "macOS 13 or later · Apple silicon",
  );
  assert.equal(compact.byId.get("installer-links").hidden, true);
  for (const id of [
    "release-notes-link",
    "privacy-link",
    "security-link",
    "support-link",
  ]) {
    assert.equal(compact.byId.get(id).hidden, true, id);
    assert.equal(Object.hasOwn(compact.byId.get(id), "href"), false, id);
  }

  const assurance = fakeDocument(complete);
  const assuranceRelease = configuredInstallerRelease(assurance);
  assert.equal(renderInstallerAssurance(assurance, assuranceRelease), assuranceRelease);
  assert.equal(assurance.byId.get("download-assurance").hidden, false);
  assert.equal(renderInstallerAssurance(assurance, undefined), null);
  assert.equal(assurance.byId.get("download-assurance").hidden, true);

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
    assert.equal(renderInstallerAssurance(documentRef, null), null);
    assert.equal(documentRef.byId.get("download-assurance").hidden, true);
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
