/** Consume an explicitly reviewed final publication plan; never rebuild or sign. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import distribution from '../../config/electron-production-distribution.cjs';
import { EN_US_CATALOG } from '../../packages/i18n/index.js';
import { identityDigest } from './release-operation.mjs';

const fail = () => { throw new TypeError('Electron site requires the exact reviewed stable publication plan and unchanged artifacts'); };
const HASH = /^[a-f0-9]{64}$/u;
const supportsAutomaticNativeReplacement = version => {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 0 || minor > 1 || (minor === 1 && patch >= 20);
};
const targets = Object.keys(distribution.PRODUCTION_ELECTRON_TARGETS);
export async function readElectronSitePublication({ planPath, artifactRoot, approvedPlanSha256, verifyPublishedInstaller }) {
  if (!HASH.test(approvedPlanSha256 ?? '')) fail();
  const planStat = await lstat(planPath);
  if (!planStat.isFile() || planStat.isSymbolicLink() || planStat.size > 128 * 1024) fail();
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (identityDigest(plan) !== approvedPlanSha256
      || plan.schemaVersion !== 'tibotattle-electron-stable-publication-plan-v1'
      || plan.origin !== distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN
      || plan.status !== 'local_bytes_bound' || plan.published !== false
      || !/^[a-f0-9]{40}$/u.test(plan.sourceRevision ?? '')
      || !supportsAutomaticNativeReplacement(plan.version)
      || !Array.isArray(plan.targets) || plan.targets.length !== 4
      || plan.targets.map(t => t.target).sort().join() !== [...targets].sort().join()) fail();
  const root = await realpath(artifactRoot);
  const downloads = [];
  let publishedInstallersVerified = true;
  for (const target of plan.targets) {
    const feedURL = distribution.PRODUCTION_ELECTRON_TARGETS[target.target].feedURL;
    if (target.feedURL !== feedURL || !Array.isArray(target.artifacts)) fail();
    const arch = target.target.slice(7);
    const name = target.target.startsWith('darwin-') ? `TiboTattle-${plan.version}-mac-${arch}.dmg`
      : target.target === 'win32-x64' ? `TiboTattle-${plan.version}-Windows-x64.exe`
        : `TiboTattle-${plan.version}-linux-x86_64.AppImage`;
    const selected = target.artifacts.filter(a => basename(a.objectKey) === name);
    if (selected.length !== 1) fail();
    for (const object of [...target.artifacts, target.feed]) {
      if (typeof object.localPath !== 'string' || object.localPath.includes('\\')
          || object.localPath.split('/').some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(p))
          || !HASH.test(object.sha256 ?? '') || !Number.isSafeInteger(object.bytes)
          || object.bytes < 1 || object.bytes > 2 * 1024 ** 3
          || object.objectKey !== `${new URL(feedURL).pathname.slice(1)}/${basename(object.localPath)}`) fail();
      const path = resolve(root, object.localPath);
      if (!path.startsWith(root + sep) || await realpath(path) !== path) fail();
      const before = await lstat(path);
      if (!before.isFile() || before.nlink !== 1 || before.size !== object.bytes) fail();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) fail();
        let bytes = 0; const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          bytes += chunk.length; if (bytes > object.bytes) fail(); hash.update(chunk);
        }
        const after = await handle.stat(); const named = await lstat(path);
        if (bytes !== object.bytes || hash.digest('hex') !== object.sha256
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail();
      } finally { await handle.close(); }
    }
    const object = selected[0];
    const url = `https://github.com/adamallcock/tibotattle/releases/download/v${plan.version}/${name}`;
    const verified = await verifyPublishedInstaller({ installerUrl: url, expectedBytes: object.bytes, expectedSha256: object.sha256 });
    if (verified?.bytes !== object.bytes || verified?.sha256 !== object.sha256) fail();
    if (verified.published === false) publishedInstallersVerified = false;
    downloads.push({ target: target.target, url, bytes: object.bytes, sha256: object.sha256 });
  }
  return { version: plan.version, buildNumber: plan.buildNumber, sourceRevision: plan.sourceRevision,
    approvedPlanSha256, publishedInstallersVerified, verificationScope: ['reviewed-publication-plan', 'local-artifact-bytes', ...(publishedInstallersVerified ? ['published-installer-bytes'] : [])], downloads };
}

const escape = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = key => `<span data-i18n="${key}">${escape(EN_US_CATALOG[key])}</span>`;
function homebrewAction(panel, prefix, published) {
  // Preserve the source-owned command, localization, accessibility and copy IDs.
  const pattern = new RegExp(`<div\\b(?=[^>]*\\bid="${prefix}homebrew-install")[^>]*>[\\s\\S]*?<\\/div>\\s*<span\\b(?=[^>]*\\bid="${prefix}homebrew-copy-status")[^>]*>[\\s\\S]*?<\\/span>`, 'u');
  const action = panel.match(pattern)?.[0];
  if (!action) throw new TypeError('Missing exact Homebrew install action');
  return published ? action.replace(/^<div\b[^>]*>/u, tag => tag.replace(/\s+hidden(?=[\s>])/u, '')) : action;
}
export function renderElectronSiteDownloads(html, release) {
  if (!supportsAutomaticNativeReplacement(release.version)) fail();
  let output = html.replace('</head>', '<meta name="usage-monitor-electron-stable" content="true">\n</head>');
  const description = 'TiboTattle is a private desktop app for macOS, Windows and Linux that estimates your seven-day Codex allowance locally and shows delayed aggregate community activity when published.';
  let descriptions = 0;
  output = output.replace(/<meta\s+(property|name)="(og:description|twitter:description|description)"\s+content="[^"]*"\s*>/gu,
    (_match, attribute, name) => { descriptions++; return `<meta ${attribute}="${name}" content="${escape(description)}">`; });
  if (descriptions !== 3) throw new TypeError('Missing exact social description slots');
  output = output.replace(/<meta property="og:image:alt" content="[^"]*">/u,
    '<meta property="og:image:alt" content="TiboTattle logo">');
  for (const item of release.downloads) {
    const platform = { 'darwin-arm64': 'macos', 'darwin-x64': 'macos-intel', 'win32-x64': 'windows', 'linux-x64': 'linux' }[item.target];
    const mac = item.target.startsWith('darwin-');
    const pattern = new RegExp(`<section\\b[^>]*data-platform-panel="${platform}"[^>]*>[\\s\\S]*?<\\/section>`, 'u');
    if (!pattern.test(output)) throw new TypeError('Missing exact platform panel');
    const prefix = { macos: '', 'macos-intel': 'intel-', windows: 'windows-', linux: 'linux-' }[platform];
    const homebrew = mac ? homebrewAction(output.match(pattern)[0], prefix, release.publishedInstallersVerified) : '';
    const icon = mac ? '<img class="download-platform-icon" src="./apple.svg" alt="" width="22" height="22">'
      : platform === 'windows' ? '<svg class="download-platform-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 3h9v8H2zm11 0h9v8h-9zM2 13h9v8H2zm11 0h9v8h-9z"/></svg>'
        : '<span class="download-platform-icon" aria-hidden="true">🐧</span>';
    output = output.replace(pattern, `<section class="platform-panel" id="platform-panel-${platform}" role="tabpanel" aria-labelledby="platform-tab-${platform}" data-platform-panel="${platform}" tabindex="0"${platform === 'macos' ? '' : ' hidden'}>
      ${release.publishedInstallersVerified ? '' : '<p><strong>Local preview — publication has not been verified.</strong></p>'}
      <div class="install-actions"><a class="button mac-download-button" href="${escape(item.url)}" data-electron-download="${item.target}">${icon}${text(`electron.site.download.${platform}`)}</a>${homebrew}</div>
      <div class="installer-details installer-details-compact">
        <span class="installer-summary">${escape(release.version)} <span class="installer-summary-divider" aria-hidden="true">·</span> ${text(`electron.site.requirements.${platform}`)}</span>
        <button class="installer-checksum-copy electron-checksum-copy" id="${prefix}installer-sha256-copy" type="button" data-checksum="${escape(item.sha256)}" aria-describedby="${prefix}installer-sha256-copy-status"><span id="${prefix}installer-sha256-copy-label" data-i18n="installer.sha256.copy">Copy SHA-256</span></button>
        <code class="installer-checksum-fallback" id="${prefix}installer-sha256" data-i18n-skip hidden>${escape(item.sha256)}</code>
        <span class="sr-only" id="${prefix}installer-sha256-copy-status" role="status" aria-live="polite" aria-atomic="true"></span>
      </div>
      <p class="download-assurance"><span class="download-assurance-mark" aria-hidden="true"></span><strong>${text(mac ? 'electron.site.macTrust' : item.target === 'win32-x64' ? 'electron.site.windowsTrust' : 'electron.site.linuxInstall')}</strong> <a href="./docs.html#download-security">${text('electron.site.security')}</a></p>
      </section>`);
  }
  return output;
}

export function renderElectronSiteDocumentation(html) {
  // Privacy keeps its source-owned content; only enable the same local catalog
  // used by Docs so the explicit publication disclosures follow the saved locale.
  if (html.includes('id="hosted-identity"') && html.includes('id="publication"')) {
    return html.replace('<body class="community-site resource-site">', '<body class="community-site resource-site" data-i18n-root>')
      .replace('</body>', '<script type="module" src="./localization.js"></script>\n</body>');
  }
  // Only the existing documentation page has these source-owned sections.
  if (!html.includes('id="download-security"')) return html;
  let output = html.replace(/<article\b[^>]*id="start"[^>]*>[\s\S]*?<\/article>/u,
    `<article class="resource-card" id="start"><h2>Install TiboTattle</h2>
    <p>Choose the matching platform on the <a href="./index.html#download">download page</a>. The app includes its runtime.</p>
    <p>To update an existing Mac installation, quit TiboTattle, replace it in Applications and open the new app. TiboTattle automatically transfers retained history and settings while preserving existing data and credentials. No manual backup or intermediate update is needed.</p>
    <p>On first launch, read the complete local-source and automatic-sharing explanation and select Continue. Sharing can stay off; Settings keeps your choice. This public website never scans local files or accepts contributions.</p></article>`);
  output = output.replace(/<article\b[^>]*id="platforms"[^>]*>[\s\S]*?<\/article>/u,
    `<article class="resource-card" id="platforms"><h2>Platform support</h2><p>Electron downloads are available for macOS 14 or later on Apple silicon and Intel, Windows 10 or later on x64, and Linux x86_64 as an AppImage. See the download page for platform-specific installation requirements.</p></article>`);
  output = output.replace(/macOS is the currently available lane\.[\s\S]*?repository or a checksum\./u,
    'The download page lists the exact final Electron artifacts. macOS installers are Developer ID signed and notarized; the Windows installer is signed. The Linux AppImage is identified by its checksum. Source/build provenance is never inferred from a public repository or a checksum.');
  output = output.replace(/<p class="resource-lede">[\s\S]*?<\/p>/u,
    `<p class="resource-lede">${text('electron.site.docs.intro')}</p>`);
  output = output.replace(/<article\b[^>]*id="local-first"[^>]*>[\s\S]*?<\/article>/u,
    `<article class="resource-card" id="local-first"><h2>Local state and uninstall</h2><p>${text('electron.site.docs.state')}</p></article>`);
  output = output.replace(/<article\b[^>]*id="updates"[^>]*>[\s\S]*?<\/article>/u,
    `<article class="resource-card" id="updates"><h2>Updates and channels</h2><p>${text('electron.site.docs.updates')}</p></article>`);
  output = output.replace('<body class="community-site resource-site">', '<body class="community-site resource-site" data-i18n-root>');
  output = output.replace('</body>', '<script type="module" src="./localization.js"></script>\n</body>');
  return output;
}
