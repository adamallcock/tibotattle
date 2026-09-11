/** Incoming native Sparkle transport for a signed Electron replacement.
 * This receipt never claims Electron embeds Sparkle or a native build manifest.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { PRODUCT_BRAND } from '../config/product-brand.js';
import distribution from '../config/electron-production-distribution.cjs';
import { assertReleaseChannelPublication, resolveReleaseChannel } from '../config/release-channels.js';
import { validateProductionDistributionMetadata } from '../apps/electron/desktop-updater.js';
import { macOSCredentialApplicationVerificationArguments } from '../apps/electron/desktop-macos-keychain.js';
import { parseWindowsUpdaterYaml } from './verify-electron-windows-update-artifacts.mjs';
import { isAppleMacOSBundleVersion, compareAppleMacOSBundleVersions } from './macos-bundle-version.js';
import { assertStableSparkleKeyContinuity, runMacOSReleaseCommand, validateMacOSApplicationsLink } from './macos-release-core.js';

export const ELECTRON_SPARKLE_TRANSITION_SCHEMA = 'tibotattle-electron-sparkle-transition-v1';
const HASH = /^[a-f0-9]{64}$/u;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join() === [...keys].sort().join();
const fail = code => { throw Object.assign(new Error(`SPARKLE_ELECTRON_TRANSITION_${code}`), { code: `SPARKLE_ELECTRON_TRANSITION_${code}` }); };
export const isElectronSparkleTransition = value => value?.schemaVersion === ELECTRON_SPARKLE_TRANSITION_SCHEMA;

export function validateElectronSparkleTransitionManifest(manifest, dmg, sparklePublicKey, selectedChannel) {
  const channel = resolveReleaseChannel(selectedChannel.name, { architecture: selectedChannel.architecture });
  const app = manifest?.application, artifact = manifest?.artifact, electron = manifest?.electron;
  if (!exact(manifest, ['schemaVersion', 'application', 'artifact', 'source', 'channel', 'sparkle', 'electron', 'evidence'])
      || !isElectronSparkleTransition(manifest) || channel.name !== 'stable'
      || !exact(app, ['bundleIdentifier', 'architecture', 'bundleVersion', 'shortVersion'])
      || app.bundleIdentifier !== PRODUCT_BRAND.bundleIdentifier || app.architecture !== channel.architecture
      || !isAppleMacOSBundleVersion(app.bundleVersion)
      || !distribution.PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(app.shortVersion)
      || !exact(artifact, ['fileName', 'bytes', 'sha256'])
      || artifact.fileName !== basename(dmg.path) || !/^TiboTattle-[0-9]+\.[0-9]+\.[0-9]+-(?:mac-arm64|macOS-arm64|macOS-x64)\.dmg$/u.test(artifact.fileName)
      || (app.architecture === 'x64' ? artifact.fileName !== `TiboTattle-${app.shortVersion}-macOS-x64.dmg`
        : ![`TiboTattle-${app.shortVersion}-mac-arm64.dmg`, `TiboTattle-${app.shortVersion}-macOS-arm64.dmg`].includes(artifact.fileName))
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes !== dmg.size || !HASH.test(artifact.sha256)
      || !exact(manifest.source, ['repository', 'commit', 'tag'])
      || manifest.source.repository !== 'https://github.com/adamallcock/tibotattle'
      || !/^[a-f0-9]{40}$/u.test(manifest.source.commit) || manifest.source.tag !== `v${app.shortVersion}`
      || !exact(manifest.sparkle, ['appcastURL', 'publicEdKeySha256'])
      || manifest.sparkle.appcastURL !== channel.sparkle.appcastURL
      || !HASH.test(manifest.sparkle.publicEdKeySha256) || manifest.sparkle.publicEdKeySha256 !== sparklePublicKey.sha256
      || !exact(electron, ['buildNumber', 'asarSha256', 'updaterConfigurationSha256'])
      || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(electron.buildNumber)
      || !HASH.test(electron.asarSha256) || !HASH.test(electron.updaterConfigurationSha256)
      || !exact(manifest.evidence, ['scope', 'nativeSparkleJourney']) || manifest.evidence.scope !== 'local_qualification'
      || !exact(manifest.evidence.nativeSparkleJourney, ['localPath', 'bytes', 'sha256'])) fail('MANIFEST_INVALID');
  distribution.assertProductionElectronMacOSBundleMetadata({ target: `darwin-${app.architecture}`,
    version: app.shortVersion, buildNumber: electron.buildNumber, bundleVersion: app.bundleVersion,
    bundleShortVersion: app.shortVersion });
  const proof = manifest.evidence.nativeSparkleJourney;
  if (typeof proof.localPath !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(proof.localPath)
      || !HASH.test(proof.sha256) || !Number.isSafeInteger(proof.bytes) || proof.bytes < 1 || proof.bytes > 1024 * 1024) fail('EVIDENCE_INVALID');
  assertReleaseChannelPublication(channel, manifest.channel);
  if (manifest.channel.sparkle.publicEdKeySha256 !== manifest.sparkle.publicEdKeySha256) fail('KEY_MISMATCH');
  return Object.freeze({ artifactSha256: artifact.sha256, bundleVersion: app.bundleVersion, manifest });
}

export function validateElectronSparkleJourney(proof, manifest) {
  const checks = ['nativeSparkleUpdateCompleted', 'migrationCompleted', 'retainedRowsPreserved', 'saltPreserved',
    'preferencesPreserved', 'optOutPreserved', 'restartNoDuplicates', 'sourceUntouched', 'ownedProcessesStopped',
    'signedArtifactVerified', 'disposableAccountVerified', 'checkForUpdatesClicked', 'installUpdateClicked',
    'updaterRelaunchedCandidate', 'feedOverrideApplied'];
  if (proof?.schemaVersion !== 'tibotattle-signed-macos-sparkle-transition-v1' || proof.status !== 'passed'
      || proof.target !== `darwin-${manifest.application.architecture}` || proof.version !== manifest.application.shortVersion
      || proof.buildNumber !== manifest.electron.buildNumber || proof.bundleVersion !== manifest.application.bundleVersion
      || proof.feedScope !== 'isolated_test_feed' || !HASH.test(proof.feedSha256)
      || proof.productionFeedVerified !== false || proof.candidateCopiedByRunner !== false
      || proof.sourceRevision !== manifest.source.commit || proof.dmgSha256 !== manifest.artifact.sha256
      || proof.asarSha256 !== manifest.electron.asarSha256 || proof.nativeVersion !== '0.1.18'
      || !HASH.test(proof.nativeDmgSha256) || checks.some(key => proof[key] !== true)) fail('JOURNEY_INCOMPLETE');
  return proof;
}

async function hashFile(path, maximum = 2 * 1024 ** 3) {
  const selected = resolve(path);
  if (await realpath(selected) !== selected) fail('UNSAFE_PATH');
  const before = await lstat(selected);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail('UNSAFE_FILE');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(selected)) hash.update(chunk);
  const after = await lstat(selected);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('CHANGED_FILE');
  return { sha256: hash.digest('hex'), bytes: before.size };
}

export async function readElectronSparkleJourney(manifest, manifestPath) {
  const spec = manifest.evidence.nativeSparkleJourney;
  if (!exact(spec, ['localPath', 'bytes', 'sha256']) || typeof spec.localPath !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(spec.localPath)
      || !HASH.test(spec.sha256) || !Number.isSafeInteger(spec.bytes) || spec.bytes < 1 || spec.bytes > 1024 * 1024) fail('EVIDENCE_INVALID');
  const path = join(dirname(resolve(manifestPath)), spec.localPath);
  const digest = await hashFile(path, 1024 * 1024);
  if (digest.sha256 !== spec.sha256 || digest.bytes !== spec.bytes) fail('EVIDENCE_MISMATCH');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) fail('EVIDENCE_CHANGED');
  return validateElectronSparkleJourney(JSON.parse(bytes), manifest);
}

/** Previous native receipts retain their unchanged native validator. */
export function assertElectronSparkleContinuity({ manifest, previousManifest, journey = null, stableBootstrap = false }) {
  if (stableBootstrap || previousManifest === null) fail('PREVIOUS_REQUIRED');
  if (!isElectronSparkleTransition(previousManifest)) {
    if (previousManifest.application?.shortVersion !== '0.1.18'
        || journey?.nativeDmgSha256 !== previousManifest.artifact?.sha256) fail('NATIVE_PREDECESSOR_MISMATCH');
    return assertStableSparkleKeyContinuity({ architecture: manifest.application.architecture, channel: 'stable',
      candidateBundleVersion: manifest.application.bundleVersion,
      candidatePublicEdKeySha256: manifest.sparkle.publicEdKeySha256, previousManifest, stableBootstrap: false });
  }
  validateElectronSparkleTransitionManifest(previousManifest,
    { path: previousManifest.artifact?.fileName, size: previousManifest.artifact?.bytes },
    { sha256: manifest.sparkle.publicEdKeySha256 }, resolveReleaseChannel('stable', { architecture: manifest.application.architecture }));
  if (compareAppleMacOSBundleVersions(manifest.application.bundleVersion, previousManifest.application.bundleVersion) <= 0) fail('VERSION_NOT_NEWER');
  return Object.freeze({ mode: 'previous_manifest', previousBundleVersion: previousManifest.application.bundleVersion,
    policy: 'previous_stable_manifest_required' });
}

/** Inspect final signed bytes, without launching the app or touching user state. */
export async function validateElectronSparkleDMG(path, { manifest, manifestPath,
  commandRunner = runMacOSReleaseCommand, readAsarPackage = null } = {}) {
  await readElectronSparkleJourney(manifest, manifestPath);
  const before = await hashFile(path);
  if (before.sha256 !== manifest.artifact.sha256 || before.bytes !== manifest.artifact.bytes) fail('DMG_MISMATCH');
  const run = (command, args, options = {}) => commandRunner(command, args, { timeout: 300_000,
    failureMessage: 'Electron transition artifact inspection failed', ...options });
  run('/usr/bin/hdiutil', ['verify', path]);
  run('/usr/bin/codesign', ['--verify', '--strict', path]);
  run('/usr/bin/xcrun', ['stapler', 'validate', path]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
  const attached = run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', path]);
  const response = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: attached.stdout }).stdout);
  const mount = response['system-entities']?.find(value => typeof value['mount-point'] === 'string');
  if (!mount || typeof mount['dev-entry'] !== 'string') fail('MOUNT_INVALID');
  try {
    const names = (await readdir(mount['mount-point'])).filter(name => !['.DS_Store', '.background', '.VolumeIcon.icns', '.fseventsd', '.Trashes'].includes(name)).sort();
    if (names.join() !== ['Applications', PRODUCT_BRAND.bundleName].sort().join()) fail('LAYOUT_INVALID');
    await validateMacOSApplicationsLink(join(mount['mount-point'], 'Applications'));
    const app = join(mount['mount-point'], PRODUCT_BRAND.bundleName);
    run('/usr/bin/codesign', macOSCredentialApplicationVerificationArguments(app));
    const identity = run('/usr/bin/codesign', ['-dv', '--verbose=4', app]);
    if (!/flags=.*\bruntime\b/u.test(identity.stderr + identity.stdout)) fail('HARDENED_RUNTIME_REQUIRED');
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]).stdout);
    if (plist.CFBundleIdentifier !== manifest.application.bundleIdentifier
        || plist.CFBundleVersion !== manifest.application.bundleVersion
        || plist.CFBundleShortVersionString !== manifest.application.shortVersion
        || plist.CFBundleExecutable !== 'TiboTattle' || plist.LSMinimumSystemVersion !== '14.0') fail('APP_IDENTITY_MISMATCH');
    distribution.assertProductionElectronMacOSBundleMetadata({ target: `darwin-${manifest.application.architecture}`,
      version: manifest.application.shortVersion, buildNumber: manifest.electron.buildNumber,
      bundleVersion: plist.CFBundleVersion, bundleShortVersion: plist.CFBundleShortVersionString });
    distribution.assertProductionElectronMacOSIncomingUpgradeMetadata({
      target: `darwin-${manifest.application.architecture}`, publicEDKey: plist.SUPublicEDKey });
    if (createHash('sha256').update(Buffer.from(plist.SUPublicEDKey, 'base64')).digest('hex')
        !== manifest.sparkle.publicEdKeySha256) fail('KEY_MISMATCH');
    const expectedArch = manifest.application.architecture === 'x64' ? 'x86_64' : 'arm64';
    if (run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/TiboTattle')]).stdout.trim() !== expectedArch) fail('ARCHITECTURE_MISMATCH');
    const asar = join(app, 'Contents/Resources/app.asar');
    if ((await hashFile(asar, 512 * 1024 ** 2)).sha256 !== manifest.electron.asarSha256) fail('ASAR_MISMATCH');
    let readPackage = readAsarPackage;
    if (readPackage === null) {
      const require = createRequire(import.meta.url), builderRequire = createRequire(require.resolve('electron-builder'));
      const loaded = builderRequire('@electron/asar'), api = loaded.default ?? loaded;
      readPackage = file => { if (api.statFile(file, 'package.json').size > 128 * 1024) fail('PACKAGE_TOO_LARGE');
        return JSON.parse(api.extractFile(file, 'package.json').toString('utf8')); };
    }
    const pkg = readPackage(asar), target = `darwin-${manifest.application.architecture}`;
    const meta = validateProductionDistributionMetadata(pkg?.tibotattleDistribution,
      { platform: 'darwin', architecture: manifest.application.architecture });
    if (pkg.name !== 'app-usagemonitor' || pkg.version !== manifest.application.shortVersion
        || Object.keys(pkg).some(key => key.startsWith('tibotattleAccountless'))
        || meta.sourceRevision !== manifest.source.commit || meta.buildNumber !== manifest.electron.buildNumber
        || meta.channel !== distribution.PRODUCTION_ELECTRON_CHANNEL
        || meta.contributionPolicy !== distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY) fail('DISTRIBUTION_MISMATCH');
    const updatePath = join(app, 'Contents/Resources/app-update.yml');
    if ((await hashFile(updatePath, 128 * 1024)).sha256 !== manifest.electron.updaterConfigurationSha256) fail('UPDATER_MISMATCH');
    const updater = parseWindowsUpdaterYaml(await readFile(updatePath));
    if (updater.provider !== 'generic' || updater.url !== distribution.PRODUCTION_ELECTRON_TARGETS[target].feedURL
        || Object.keys(updater).some(key => !['provider', 'url', 'updaterCacheDirName'].includes(key))) fail('UPDATER_MISMATCH');
    for (const helper of [join(app, 'Contents/MacOS', distribution.PRODUCTION_ELECTRON_NATIVE_HANDOVER_HELPER_RESOURCE_RELATIVE_PATH.at(-1)),
      join(app, 'Contents/Resources', ...distribution.PRODUCTION_ELECTRON_MACOS_KEYCHAIN_ADAPTER_RESOURCE_RELATIVE_PATH)]) {
      await hashFile(helper, 8 * 1024 ** 2);
      if (run('/usr/bin/lipo', ['-archs', helper]).stdout.trim() !== expectedArch) fail('HELPER_ARCHITECTURE_MISMATCH');
    }
    return Object.freeze({ source: { commit: manifest.source.commit, tag: manifest.source.tag } });
  } finally {
    run('/usr/bin/hdiutil', ['detach', mount['dev-entry']]);
    if ((await hashFile(path)).sha256 !== before.sha256) fail('DMG_CHANGED');
  }
}
