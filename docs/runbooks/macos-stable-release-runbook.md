# macOS stable release runbook (canonical)

The end-to-end sequence to cut a stable TiboTattle release, with every sharp edge
worth remembering. Do the steps in order. Placeholders: `X.Y.Z` = new version,
`P.Q.R` = previous stable version.

> Secrets (the appcast guard token, its storage location, exact retrieval
> commands) are intentionally **not** in this file. They live in the gitignored
> `docs/runbooks/release-secrets.local.md` on the release machine. This runbook
> references them by env-var name only.

---

## 0. Version lockstep (BEFORE building — these are all "release commits")
A version bump is **not** just `package.json`. Bump/​regenerate all of:
1. `package.json` **and** `packages/{accounting,identity-core,quota-analysis,telemetry-contract}/package.json` → `X.Y.Z`. (Not `apps/worker` / `packages/i18n` — independent.)
2. `schemas/telemetry-v0.1/compatibility.schema.json` → `"packageVersion": { "const": "X.Y.Z" }` (**hand-edited every release**; the generator only *reads* it).
3. Regenerate derived artifacts: `npm run telemetry:generate` (writes `generated/telemetry-v0.1-compatibility.json` **and** `-field-dictionary.json` — commit both).
4. If `apps/worker/worker-configuration.d.ts` drifts: `cd apps/worker && npx wrangler types worker-configuration.d.ts --env-file .dev.vars.example` and commit.
5. **Refresh worker workspace copies** (they are COPIES, not symlinks — they go stale): `cd apps/worker && npm ci`. Otherwise `product:worker:check` and the bundle use old package versions.

Gates: `npm test`, `npm run product:worker:check` (needs step 5), `npm run architecture:check`, `cd apps/worker && npx vitest run`. Known pre-existing non-blockers: `staging-readiness.check.mjs`, the export allow-list drift (`apps/local/server.js → src/contribution-device-renewal.js`), and two Fix-B quota-tracks reference snapshots.

## 1. Clean tree + annotated tag (REQUIRED before signing)
`release-macos-app` runs `git status --porcelain --untracked-files=all` (must be **empty**, incl. untracked) and `git describe --exact-match --tags HEAD` (HEAD must be on an **annotated** tag).
```bash
git status --porcelain=v1 --untracked-files=all   # must print nothing
git tag -a vX.Y.Z <sha> -m "TiboTattle X.Y.Z ..." && git push origin vX.Y.Z
```

## 2. Build + sign + notarize (ONE command)
`--external-distribution` is **refused on the CLI by design** — never call `build-macos-app.js --external-distribution` directly. Drive it through `release-macos-app --prepare-candidate`. Delete any stale candidate first (it refuses a non-fresh output). Set the `USAGE_MONITOR_*` release env vars first — the exact Developer ID / notary-profile values are in `release-secrets.local.md`; the Sparkle public key below is public by design.
```bash
rm -rf .release-build/macos-production
export USAGE_MONITOR_DEVELOPER_ID_APPLICATION="Developer ID Application: … (…)"   # see release-secrets.local.md
export USAGE_MONITOR_NOTARY_PROFILE="…"                                          # see release-secrets.local.md
export USAGE_MONITOR_BUNDLE_VERSION="X.Y.Z"
export USAGE_MONITOR_SPARKLE_FRAMEWORK=".release-deps/Sparkle.framework"
export USAGE_MONITOR_SPARKLE_APPCAST_URL="https://updates.tibotattle.com/appcast.xml"
export USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY="jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw="
node scripts/release-macos-app.js --app ".release-build/macos-production/TiboTattle.app" \
  --channel stable --prepare-candidate \
  --previous-stable-manifest "<path to P.Q.R .release.json>"
```
Codesign prompts the Keychain once → **Always Allow** (won't prompt again). Prints the **DMG SHA-256** → save it. DMG lands at `.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg`.

## 3. Generate the signed appcast
```bash
npm run product:macos:appcast -- --channel stable \
  --app ".release-build/macos-production/TiboTattle.app" \
  --dmg ".release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --bundle-version "X.Y.Z" \
  --sparkle-public-ed-key "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw="
```
This uses the pinned `generate_appcast` → embeds the feed signature the app's `SURequireSignedFeed=true` requires. A hand-built "minimal" appcast is rejected by every installed client — do not do that.

## 4. Publish to R2 — the flags the npm wrapper does NOT add
Export `SPARKLE_APPCAST_GUARD_TOKEN` from your secret store first (retrieval is in `release-secrets.local.md`). The npm wrapper omits `--publish`; without it the script only *validates*. A new version also needs `--replace-appcast` (permitted for a real upgrade — the code refuses only regressions + same-version artifact swaps) and `--previous-stable-manifest`.
```bash
export SPARKLE_APPCAST_GUARD_TOKEN="…"   # see release-secrets.local.md (never hardcode / commit)
node scripts/publish-sparkle-update.js --publish --replace-appcast --channel stable \
  --appcast ".release-build/macos-release/appcast.xml" \
  --dmg ".release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --release-manifest ".release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg.release.json" \
  --previous-stable-manifest "<path to P.Q.R .release.json>" \
  --bucket tibotattle-updates \
  --sparkle-public-ed-key "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw=" \
  --atomic-appcast-guard-endpoint "https://tibotattle.com/api/v1/internal/release/appcast" \
  --atomic-appcast-guard-token-env SPARKLE_APPCAST_GUARD_TOKEN
```
Verify: `curl -s https://updates.tibotattle.com/appcast.xml | grep -E 'sparkle:version|enclosure url'` shows `X.Y.Z`.

## 5. GitHub release — DMG ONLY
```bash
gh release create vX.Y.Z ".release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --repo adamallcock/tibotattle --title "TiboTattle X.Y.Z" --notes-file <notes.md>
```
**Never attach `*.dmg.release.json`** — it embeds a private source SHA + infra details (that was the historical leak).

## 6. Rebuild the website + deploy the worker  ← THE STEP MISSED ON 0.1.11
The site the worker serves is **pre-built** with the installer version/SHA **baked at build time** — a `wrangler deploy` alone leaves the site on the *old* version and does NOT ship web-code changes (this is what showed 0.1.1 and dropped the community band on the 0.1.11 launch). Rebuild it FIRST.

**CRITICAL — `env.production` serves a DIFFERENT dir than the top-level config.** Per `apps/worker/wrangler.jsonc`: top-level + `env.staging` = `.release-build/worker-assets`, but **`env.production` = `.release-build/public-release-site`**. For a production release you MUST rebuild **`public-release-site`** (rebuilding `worker-assets` deploys nothing to prod). Verify the target with:
`python3 -c "import json,re;d=json.loads(re.sub(r'^\s*//.*$','',open('apps/worker/wrangler.jsonc').read(),flags=re.M));print(d['env']['production']['assets']['directory'])"`
```bash
npm run product:release-site -- \
  --output "$PWD/.release-build/public-release-site" --replace \
  --site-url "https://tibotattle.com/" \
  --installer-path "$PWD/.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-release-manifest "$PWD/.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg.release.json" \
  --installer-url "https://github.com/adamallcock/tibotattle/releases/download/vX.Y.Z/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-version X.Y.Z \
  --installer-sha256 "<DMG SHA-256 from step 2>" \
  --minimum-macos 14.0 --architectures arm64 \
  --release-notes-url "https://tibotattle.com/docs.html" \
  --privacy-url "https://tibotattle.com/privacy.html" \
  --security-url "https://tibotattle.com/docs.html" \
  --support-url "https://tibotattle.com/docs.html" \
  --social-image "$PWD/.release-build/public-release-site/social-preview.png"
cd apps/worker && npx wrangler deploy --env production && cd ../..
```
Note: `--installer-path`/`--installer-release-manifest`/`--social-image`/`--output` must be **absolute**. Deploying the worker here also ships worker code changes and the rebuilt web assets. After deploy the live version may flip old↔new for ~2 min (edge propagation) then converges. No new D1 migrations unless you added one (`d1 migrations list … --remote` to check).

## 7. Go public + announce
```bash
gh repo edit adamallcock/tibotattle --visibility public --accept-visibility-change-consequences   # once, if not already
```
Then the launch post. Verify a real update: on an installed older build, Check for Updates → should offer X.Y.Z and install.

---

## Owner-credential steps (need Cloudflare / Apple / Keychain access on the release machine)
`wrangler deploy`, the R2 publish (`publish-sparkle-update` uses wrangler), `d1 migrations apply`, reading the guard token from your secret store, and `gh repo edit --visibility`. Everything else (build, sign+notarize, appcast generation, `gh release create`) is a plain local/CLI step. The secret values + exact retrieval commands are in `docs/runbooks/release-secrets.local.md` (gitignored).
