import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPIRES = "2026-10-10T00:00:00.000Z";
export const PUBLISHED_VERSIONS = Object.freeze([
  "1.0.0",
  "2.0.0",
  "3.0.0",
  "3.1.0",
  "3.2.0",
  "3.3.0",
  "3.3.1",
  "3.3.2",
  "3.3.3",
  "3.4.0",
  "3.5.0",
  "3.5.1",
  "3.6.0",
  "3.6.1",
  "3.7.0",
  "3.7.1",
  "3.7.3",
  "3.8.0",
  "3.8.1",
  "4.0.0",
  "4.0.1",
  "4.0.2",
  "4.0.3",
  "4.0.4",
  "4.1.0",
  "4.1.1",
  "4.2.0",
  "4.2.0-beta.1",
  "4.2.0-beta.2"
]);
export const CONFIG = '# Approved temporary exact-patch exception; see dated decision.\n[[IgnoredVulns]]\nid = "GHSA-ch52-4w7c-c8xp"\nignoreUntil = 2026-10-10\nreason = "Reviewed upstream max-stale patch 14a8c2ad; exact-byte CI gate; expires 2026-10-10 UTC."\n';
const FILES = {
  "pnpm-lock.yaml": "4a0cb72c3ad8cc6147518e6b937c662ef4844a64e6e5cd618578c52edcccd004",
  "pnpm-workspace.yaml": "27e1d718a6a5e5525635c0e2571e53627a3bedbdfe827f64a2c012edee1005ff",
  "config/patches/http-cache-semantics@4.2.0.patch": "6e7076d25b3bdb7a6e9cd709a5d6f63c3b9f0d9308f12659b2dddb08dc904a93",
  "config/patches/app-builder-lib@26.15.7.patch": "5821cdf7573fa16696c7b0440c919f360393e91520a42fd81360eb6a5de555b8",
  "test/http-cache-semantics-security.test.js": "68f186a52a2e31e68893ae449d5dd70f03663bb02d8fe30f5ed1149d47b28b1d",
  "test/electron-windows-production-signing.test.js": "0c21f98c9abf9708b57c1683618e5535f64a9be2823e90b533d4413bf0e395c9",
  "test/http-cache-exception.test.js": "7b308dc14ac36127549412cadad60d1199b0e9d9afc873fcff544cbc348ab38d",
  "test/http-cache-exception-workflow.test.mjs": "5a5ed4205d562e8157ba7a50f06ddc3979e6f601f57ef968730198146e5e5e60",
  ".github/workflows/osv-scanner.yml": "9b0442d67f7dbe8a57f0b4534a3dcfb40e99ba6512ec21766fa3a04d54a908a9",
  "scripts/check-root-workspace-hygiene.mjs": "8f769ccded081318b187dbdadf84064e4d6247e29b4aaeae981ae1216810aa5f"
};
const INSTALLED = [
  [
    "electron-builder",
    "88bdbc15527e0345b44c9a92a6e2ae53f18ba182f383ef0b26a51befdda5e18e"
  ],
  [
    "app-builder-lib",
    "4e0e1049e5018fae804b082318cd4546d600b0b6a09f191537f6bb0f9ad774be"
  ],
  [
    "app-builder-lib/out/util/electronGet.js",
    "568fc3b1f394a9f0cfaecd2d1de02491894eb18febb2e057e160378c22e8f313"
  ],
  [
    "@electron/get",
    "d81c9a2354bb2769b4d8205b04c991aef2e93b79e7e3d1e792663aee5813ac4f"
  ],
  [
    "@electron/get/dist/cjs/GotDownloader.js",
    "9173d2564e6685674e9b52807f5fa9ce65d60507357bd41716611074c595f7c0"
  ],
  [
    "got",
    "bd013ea2c1e2809a951d6c95b9b9309180d5f5fbdc9c1952d45e2643e24a955b"
  ],
  [
    "got/dist/source/core/index.js",
    "66719545130ebb4d4091e9bd211ebfec1ca3df31e260c18191a3c67f72a1227a"
  ],
  [
    "cacheable-request",
    "3ce05ac3531f61529210bf6390f18d5e709ec110e37dee22af7e72b4065ca627"
  ],
  [
    "http-cache-semantics",
    "fc7b3f0265b7a7d0fee83bafa47186a66495720d3179801c2be3083de6d0cf76"
  ]
];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function checkStatus({ now, latest, registry, advisory }) {
  assert.ok(Number.isFinite(now.getTime()) && now >= new Date("2026-10-03T00:00:00Z") && now < new Date(EXPIRES), "Exception expired or clock invalid");
  assert.equal(latest.name, "http-cache-semantics");
  assert.equal(latest.version, "4.2.0", "New published release requires fresh review and removal decision");
  assert.deepEqual(Object.keys(registry.versions).sort(), PUBLISHED_VERSIONS, "Published version inventory changed; fresh review and removal decision required");
  assert.equal(advisory.ghsa_id, "GHSA-ch52-4w7c-c8xp");
  assert.equal(advisory.withdrawn_at, null, "Withdrawn advisory requires exception removal");
  assert.equal(advisory.vulnerabilities.length, 1);
  const vulnerability = advisory.vulnerabilities[0];
  assert.deepEqual(vulnerability.package, { ecosystem: "npm", name: "http-cache-semantics" });
  assert.equal(vulnerability.vulnerable_version_range, "<= 4.2.0", "Advisory scope changed");
  assert.equal(vulnerability.first_patched_version, null, "Published fix requires exception removal");
}

export async function checkLocal(root) {
  const locks = (await readdir(root)).filter(name => /^(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/.test(name));
  assert.deepEqual(locks.sort(), ["pnpm-lock.yaml"], "Exception must apply only to reviewed root lock");
  assert.equal(await readFile(resolve(root, "osv-scanner.toml"), "utf8"), CONFIG, "Exception scope/config drift");
  for (const [path, expected] of Object.entries(FILES)) assert.equal(digest(await readFile(resolve(root, path))), expected, "Reviewed input drift: " + path);
  let require = createRequire(resolve(root, "package.json"));
  for (const [id, expected] of INSTALLED) {
    const isExtra = id.includes("/out/") || id.includes("/dist/");
    if (!isExtra) require = createRequire(require.resolve(id + "/package.json"));
    assert.equal(digest(await readFile(require.resolve(id))), expected, "Installed source drift: " + id);
    if (id === "got") assert.equal(require(id).defaults.options.cache, undefined, "Downloader HTTP cache default changed");
  }
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "TiboTattle-exception-proof" } });
  assert.ok(response.ok, "Official status unavailable; exception refused");
  return response.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkLocal(resolve(fileURLToPath(new URL("..", import.meta.url))));
    const [registry, advisory] = await Promise.all([
      json("https://registry.npmjs.org/http-cache-semantics"),
      json("https://api.github.com/advisories/GHSA-ch52-4w7c-c8xp"),
    ]);
    checkStatus({ now: new Date(), latest: { name: registry.name, version: registry["dist-tags"]?.latest }, registry, advisory });
    console.log("Temporary HTTP cache exception exact-source/status proof passed");
  } catch { console.error("Temporary HTTP cache exception refused; review expiry, official status and exact-source evidence"); process.exitCode = 1; }
}
