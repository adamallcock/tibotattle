---
title: macOS Intel 0.1.18 signed tester candidate
date: 2026-09-03
type: receipt
status: verified
---

# macOS Intel 0.1.18 signed tester candidate

The owner authorized a signed Intel candidate with normal opt-in uploads, then
explicitly authorized existing signing-credential use and submission of the
built app and DMG to Apple for notarization. The candidate is ready for the
owner to give to the Intel tester. It is not a public stable Intel release.

## Exact artifact

| Field | Verified value |
|---|---|
| Version / build | 0.1.18 / 1025 |
| Channel | `internal-dogfood` |
| Minimum system | macOS 14.0, Intel x86_64 |
| Filename | `TiboTattle-0.1.18-macOS-x64.dmg` |
| Bytes | 52,112,006 |
| SHA-256 | `ba0bba18730a4d97d93120ecfc9a354eb1bba141b187120c1a77b5066c98f336` |
| Source commit | `18c7065b780b3ff2eb11b0c60f2f0725ec8a3aeb` |
| Local annotated source tag | `tibotattle-internal-dogfood-0.1.18-rc1-source-20260904` |
| App identity | `com.usagemonitor.local` |
| Hosted service | `https://tibotattle.com`, sealed `internal_dogfood_https` mode |
| Update feed | `https://dogfood-updates.tibotattle.com/internal-dogfood/intel/appcast.xml` |

The exact DMG, sanitized `.dmg.release.json` receipt, checksum file and
`TESTER-README.md` are retained locally under `.release-build/intel-signed-rc1/`.
Only the finalized DMG and tester instructions/checksum are intended for handoff;
the directory also contains local preparation scripts and logs. Do not send the
whole working directory. The final DMG is read-only and must not be modified.

## Validation performed

- Existing finalizer completed with exit code 0, including a reproducible
  rebuild from the frozen clean source, Developer ID hardened signing, Apple
  acceptance and stapling for both app and DMG, Gatekeeper and isolated
  clean-profile companion checks.
- A separate `validateMacOSSignedReleaseArtifact` run completed with exit code
  0, binding the actual DMG bytes to the sanitized receipt and rechecking
  signatures, native trust and isolated clean-profile behavior.
- Independent read-only mounting found exactly eight regular Mach-O binaries,
  each containing only x86_64. Version, minimum OS, channel, source, service and
  updater metadata matched the receipt. Strict deep signature verification
  passed; Developer ID authority and hardened runtime were present.
- The mounted outer app's creation and modification times both equal the sealed
  source commit epoch, `1788483494`. The final mounted layout contains only
  `TiboTattle.app` and the Applications link. The audit mount was detached.
- Public health and readiness checks at 2026-09-04 03:38 UTC returned HTTP 200,
  open enrollment, enabled upload registration/processing, and enabled v1.0
  incremental contributions. A later public health check at 03:57 UTC identified
  deployment source `b4c8f103bf697fb530434e6de196f2c187645661`.

No signing identity, notary profile, submission identifier, credentials or
private session data is included in this receipt. The built app and installer
were submitted to Apple; no usage-history upload was performed by this work.

## Tester and release boundaries

The app contains the normal Community sign-in, review, consent and upload flow.
Uploads are real contributions to the production service. They remain optional
and require the tester's own consent; service readiness does not prove that
their pairing or upload succeeded. Optional successor transport still requires
its separate hosted capability and consent checks.

Dogfood shares the normal app identity, state and Keychain namespace. It is not
an isolated Preview profile. The tester must not run two copies concurrently,
reset credentials or delete local data to force success. The handoff explains
installation, upload status, stopping future uploads, and privacy-safe feedback.

Physical Intel operation, prompt-free real Keychain behavior, login items,
actual consented upload and installed Intel candidate-to-candidate updates
remain unproven until tested. Local Rosetta and signing checks do not substitute
for them. No system-wide installation, message to the tester, tag push, public
GitHub release, update-feed publication or website deployment occurred.
