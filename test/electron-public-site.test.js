import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readElectronSitePublication, renderElectronSiteDocumentation } from '../scripts/lib/electron-public-site.mjs';
import { identityDigest } from '../scripts/lib/release-operation.mjs';
import { buildPublicReleaseSite, parseArgs } from '../scripts/build-public-release-site.js';

const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'electron-site-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const origin='https://updates.tibotattle.com', targets=[];
  for (const target of ['darwin-arm64','darwin-x64','win32-x64','linux-x64']) {
    await mkdir(join(root,target));
    const name=target.startsWith('darwin-') ? `TiboTattle-0.1.20-mac-${target.slice(7)}.dmg` : target==='win32-x64' ? 'TiboTattle-0.1.20-Windows-x64.exe' : 'TiboTattle-0.1.20-linux-x86_64.AppImage';
    const object=async name=>{const bytes=Buffer.from('synthetic '+name);await writeFile(join(root,target,name),bytes);return {objectKey:`electron/stable/${target}/${name}`,localPath:`${target}/${name}`,sha256:hash(bytes),bytes:bytes.length};};
    targets.push({target,feedURL:`${origin}/electron/stable/${target}`,artifacts:[await object(name)],feed:await object('latest.yml')});
  }
  const plan={schemaVersion:'tibotattle-electron-stable-publication-plan-v1',origin,version:'0.1.20',buildNumber:'2026091002',sourceRevision:'1'.repeat(40),status:'local_bytes_bound',published:false,targets};
  const planPath=join(root,'plan.json');await writeFile(planPath,JSON.stringify(plan));
  return {root,plan,planPath,options:{planPath,artifactRoot:root,approvedPlanSha256:identityDigest(plan)}};
}
test('Electron intake binds the reviewed identity and all target bytes before exposing exact downloads',async t=>{
  const f=await fixture(t), calls=[];const release=await readElectronSitePublication({...f.options,verifyPublishedInstaller:async value=>{calls.push(value);return {bytes:value.expectedBytes,sha256:value.expectedSha256};}});
  assert.equal(calls.length,4);assert.equal(release.downloads.length,4);
  for (const call of calls) assert.match(call.installerUrl,/^https:\/\/github.com\/adamallcock\/tibotattle\/releases\/download\/v0\.1\.20\/TiboTattle-/u);assert.match(release.downloads[1].url,/mac-x64.dmg$/u);
  await assert.rejects(readElectronSitePublication({...f.options,approvedPlanSha256:'0'.repeat(64)}),/exact reviewed/u);
  await writeFile(join(f.root,f.plan.targets[0].artifacts[0].localPath),'modified');
  await assert.rejects(readElectronSitePublication({...f.options,verifyPublishedInstaller:async()=>assert.fail('must not GET tampered artifact')}),/exact reviewed/u);
});
test('Electron intake refuses foreign feed and symlink artifacts before a download claim',async t=>{
  const f=await fixture(t);f.plan.targets[0].feedURL='https://other.tibotattle.com';await writeFile(f.planPath,JSON.stringify(f.plan));
  await assert.rejects(readElectronSitePublication({...f.options,approvedPlanSha256:identityDigest(f.plan)}),/exact reviewed/u);
  const g=await fixture(t);const path=join(g.root,g.plan.targets[0].artifacts[0].localPath);await rm(path);await symlink(g.planPath,path);
  await assert.rejects(readElectronSitePublication({...g.options,verifyPublishedInstaller:async()=>{}}),/exact reviewed/u);
});
test('actual public generator renders four targets and automatic native replacement, keeps aliases and updates docs without dashboard assets',async t=>{
  const f=await fixture(t);const social=join(f.root,'social.png');await writeFile(social,await readFile(new URL('../apps/web/public/tibotattle-icon.png',import.meta.url)));
  const output=join(f.root,'output'); // Root contains output, but output never contains any intake file.
  const args={output,siteUrl:'https://tibotattle.com/',releaseNotesUrl:'https://github.com/adamallcock/tibotattle/releases/tag/v0.1.20',privacyUrl:'https://tibotattle.com/privacy',securityUrl:'https://tibotattle.com/docs',supportUrl:'https://github.com/adamallcock/tibotattle/issues',socialImage:social,electronPublicationPlan:f.planPath,electronPublicationRoot:f.root,electronApprovedPlanSha256:f.options.approvedPlanSha256};
  let calls=0;await buildPublicReleaseSite(args,{verifyPublishedInstaller:async value=>{calls++;return {bytes:value.expectedBytes,sha256:value.expectedSha256,published:false};}});
  assert.equal(calls,4);const html=await readFile(join(output,'index.html'),'utf8');
  assert.equal((html.match(/data-electron-download=/gu)||[]).length,4);
  assert.doesNotMatch(html,/electron-handover|Updating an existing Mac installation|Download size| bytes<\/p>/u);
  assert.equal((html.match(/class="installer-checksum-copy electron-checksum-copy"/gu)||[]).length,4);
  assert.equal((html.match(/href="https:\/\/github.com\/adamallcock\/tibotattle\/releases\/download\/v0\.1\.20\//gu)||[]).length,4);
  assert.doesNotMatch(html,/href="https:\/\/updates\.tibotattle\.com\/electron/);
  assert.doesNotMatch(html,/native-app|Keep the old app|install native 0\.1\.18/u);
  assert.equal((html.match(/private desktop app for macOS, Windows and Linux/gu)||[]).length,3);
  assert.match(html,/<meta property="og:image:width" content="1024">/u);
  assert.match(html,/<meta property="og:image:height" content="1024">/u);
  assert.match(html,/<meta name="twitter:card" content="summary">/u);
  assert.match(html,/<meta property="og:image:alt" content="TiboTattle logo">/u);assert.doesNotMatch(html,/Your existing data and credentials are preserved/u);
  assert.doesNotMatch(html,/brew install|not available yet|src="\.\/app.js"/u);
  assert.equal(await readFile(join(output,'community.html'),'utf8'),html);
  const privacy=await readFile(join(output,'privacy.html'),'utf8');assert.match(privacy,/<body[^>]*data-i18n-root/u);assert.match(privacy,/<script type="module" src="\.\/localization\.js"><\/script>/u);assert.match(privacy,/data-i18n="community\.privacy\.sample"/u);
  const docs=await readFile(join(output,'docs.html'),'utf8');assert.match(docs,/<body[^>]*data-i18n-root/u);assert.match(docs,/<script type="module" src="\.\/localization\.js"><\/script>/u);assert.match(docs,/Electron downloads are available/u);assert.match(docs,/automatically transfers retained history and settings/u);assert.match(docs,/In native Mac version 0\.1\.18, choose Check for Updates to install the Electron app/u);assert.doesNotMatch(docs,/Signed releases use the Sparkle feed|local-first Mac app/);assert.doesNotMatch(docs,/macOS is the currently available lane/u);
  const manifest=JSON.parse(await readFile(join(output,'release-site-manifest.json'),'utf8'));assert.equal(manifest.electronRelease.downloads.length,4);assert.equal(manifest.electronRelease.publishedInstallersVerified,false);assert.doesNotMatch(JSON.stringify(manifest.electronRelease.verificationScope),/published-installer/u);assert.equal(manifest.installer,undefined);
  await assert.rejects(buildPublicReleaseSite({...args,installerUrl:'https://tibotattle.com/a.dmg'}),/excludes native/u);
});
test('CLI accepts only explicit complete Electron intake flags',()=>{
  const args=parseArgs(['--electron-publication-plan','/plan.json','--electron-publication-root','/root','--electron-approved-plan-sha256','a'.repeat(64)]);
  assert.equal(args.electronPublicationPlan,'/plan.json');assert.equal(args.electronApprovedPlanSha256,'a'.repeat(64));
});

test('automatic replacement copy cannot be built against the legacy 0.1.19 release', async t => {
  const f = await fixture(t); f.plan.version = '0.1.19';
  await writeFile(f.planPath, JSON.stringify(f.plan));
  await assert.rejects(readElectronSitePublication({...f.options, approvedPlanSha256: identityDigest(f.plan), verifyPublishedInstaller: async () => assert.fail('legacy release must fail before any download')}), /exact reviewed/u);
});

test('Electron Privacy localization preserves all source content and uses only the existing local module', async () => {
  const source = await readFile(new URL('../apps/web/public/privacy.html', import.meta.url), 'utf8');
  const rendered = renderElectronSiteDocumentation(source);
  assert.match(rendered, /<body[^>]*data-i18n-root/u);
  assert.equal((rendered.match(/<script\b/gu) ?? []).length, 1);
  assert.match(rendered, /<script type="module" src="\.\/localization\.js"><\/script>/u);
  assert.equal(rendered.replace(' data-i18n-root', '').replace('<script type="module" src="./localization.js"></script>\n', ''), source,
    'privacy sections and content must not receive the Docs-specific rewrites');
  for (const key of ['sample', 'smallSample', 'publicationRules']) assert.ok(rendered.includes(`data-i18n="community.privacy.${key}"`));
  assert.equal(renderElectronSiteDocumentation('<body><p>Unrelated resource</p></body>'), '<body><p>Unrelated resource</p></body>');
});
