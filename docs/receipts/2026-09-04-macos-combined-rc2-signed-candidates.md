---
title: macOS combined 0.1.18 RC2 signed candidates
date: 2026-09-04
type: receipt
status: verified
---

# macOS combined 0.1.18 RC2 signed candidates

Both combined Astra/Intel RC2 installers are signed, notarized and independently
artifact-verified. They are private qualification candidates, **not ready for
public stable publication**. No system installation or actual installed upgrade,
manual Login Item rehearsal, physical Intel qualification, push, public release,
feed activation or hosted deployment occurred.

The owner approved the local RC2 source tag, existing Developer ID signing and
Apple notarization for both architectures without installation or publication,
then authorized publication conditionally on readiness. The remaining hardware,
installed-runtime and stable-release gates are not waived by that condition.

## Frozen identity and exact artifacts

Both finalizers exited 0 from the same clean source
`4ea16586d83c72d0a4af506b102a267251f45a2b`, using local annotated tag
`tibotattle-internal-dogfood-0.1.18-rc2-source-20260904`. The tag was not pushed.
Both installers have version `0.1.18`, bundle build `1025.1`, app identity
`com.usagemonitor.local`, channel `internal-dogfood` and minimum macOS `14.0`.
Stable build `1026` remains unbuilt and unpublished.

| Artifact property | Apple silicon | Intel |
| --- | --- | --- |
| Filename | `TiboTattle-0.1.18-macOS-arm64.dmg` | `TiboTattle-0.1.18-macOS-x64.dmg` |
| Bytes | 49,906,189 | 52,133,760 |
| Final DMG SHA-256 | `5b09b788c963225e74df29efc25f7200213b03e0c18b2216ecc528e3589d6874` | `e0e007af76460d76557db8fad8aabf0c0dcc0bb0536c2e6db1b3848eebd14f3b` |
| Adjacent release receipt SHA-256 | `c92378cc1ec992d7a1752aac06d0c62e12635dc2cd3eed109727582396f5e8ad` | `490e4899bf9152f8b6fe8d72bcb61839dbce574c1b5d012764784d7a08545766` |
| Normalized signed-app payload SHA-256 | `b7ba979c1d781b985784c0e09e72f0a8084f2550de501f5780e4221defed14ac` | `af9fcb74db550d83e872d9aa300aa3d2f540bd3805c053b405f893bf8069bfdd` |
| Architecture-specific source-input SHA-256 | `e230a2778504cefd944f9732a1e31711c559354694a3233badde2409200da492` | `39a1cda3d2b7a5b50e0c23cdab135b8f23e01f6a76977a589e7b46f1fb3ad4ee` |

Artifacts and sanitized local validation logs are retained under ignored
`.release-build/combined-signed-rc2-20260904/`. DMGs are regular, non-linked,
read-only `0444` files; adjacent sanitized receipts are `0400`. Transfer only
the selected DMG, checksum and tester guide, not the entire working directory.
Do not modify the final DMGs or overwrite the earlier RC1 evidence.

## Verification performed

The builder/validation host was Apple silicon, macOS `26.6.2`, with pinned ARM
Node `26.2.0`, verified Intel Node `26.2.0` and pinned Sparkle `2.9.3`. Intel
execution here uses Rosetta and does not establish physical Intel behavior.

- Both production finalizers reproduced their review candidate from clean
  tagged source, applied Developer ID hardened signing, obtained Apple
  acceptance and stapled tickets for app and DMG, and passed Gatekeeper and
  isolated-profile checks.
- Independent exact-artifact validation bound each receipt to the final DMG
  size/SHA, explicitly required the expected app identity/version/build, and
  compared the inspected sealed source commit/tag with the frozen RC2 source.
  The mounted build manifests' payload/source-input digests matched each
  receipt. No native signing identity was serialized into the report.
- Read-only mounting verified each final app's Finder creation and modification
  dates both equal the sealed source timestamp, `2026-09-04T22:38:13Z`.
  Mounts were detached and final DMG hashes remained unchanged.
- Signed replacement artifact validation passed independently for ARM dogfood
  RC9 `1023.7` to RC2 `1025.1`, and Intel RC1 `1025` to RC2 `1025.1`. Each
  operation revalidated both same-architecture DMGs and their native trust in
  isolated copies. These checks prove artifact compatibility, **not an actual
  installed A-to-B update or user-state continuity**.
- An independent read-only pass rechecked both finalized metadata/digests and
  preserved RC1/runtime inputs. All eight finalizer assurance fields are true;
  all three privacy-recording flags are false.

The isolated Login Item smoke uses a fake manager by contract. It neither
changes the operator's Login Item nor creates a real manual-v2 receipt. No
automatic Keychain prompt was approved, no ACL was changed and no usage history
was uploaded. The only credentialed external operation was the approved Apple
submission of built app archives and installers.

### Handoff validation

The test-runner scope was the new evidence/current-status documentation and
unchanged release-evidence contracts. Verdict: **PASS**, no skipped or failed
tests and no test weakening. A read-only review identified two stale status
sentences; they were corrected before handoff.

| Suite | Result |
| --- | --- |
| Documentation governance and preflight | 20/20 tests pass; links/frontmatter and root hygiene pass |
| Node 26.2.0 R7 freshness, release notes and release evidence | 35/35 pass |
| Node 24.14.0 R7 freshness and exact decision reconstruction | 2/2 pass |
| Tester checksum file against both final DMGs | Both match |

The checks preserve all ten retained R7 receipts; no workload regeneration or
app-source edit was made during this credentialed finalization step. Subsequent
documentation commits do not move the frozen RC2 source tag or relabel its bytes.

## Retained rollback and input evidence

ARM RC9 `1023.7` remains bound to source
`394c8a03a986e0daadbe662679fd002202682e44`, DMG SHA
`e073868a3553a57438266495f6cbc06d771bb090e02189ee6852033160c0b277`
(49,871,193 bytes), and receipt SHA
`43f436921135627dde2397b0da5226781e457d3a6faee1b138ef34ac0e673c40`.

The earlier [Intel RC1 receipt](./2026-09-03-macos-intel-signed-candidate.md)
remains historical Intel-only evidence. Its four retained files were checked
before and after RC2 finalization with no changes:

| RC1 file | SHA-256 |
| --- | --- |
| Intel DMG, 52,112,006 bytes | `ba0bba18730a4d97d93120ecfc9a354eb1bba141b187120c1a77b5066c98f336` |
| Adjacent release receipt | `18037223a37ec4a512d8394670b91bd23455e6f61fbb878e99e68ebb76a6d831` |
| Checksum file | `6941c4cd1b4de88e46fe2126939a2f64eab0611dac280b679ba9adf8e0021cb0` |
| Tester README | `f045c79d0d8856c826541bc2f825b2c043788832e79d478b72a0ad45dd967660` |

The README hash is a before/after RC2 preservation baseline, not an assertion
about an unavailable earlier checksum. Verified Intel Node remains SHA
`51ef33e35c9cd96192baba41dfb592a9568380a5b2190d64e63332c4bd807e0f`
with LICENSE SHA
`148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5`.

## Publication stop boundary

Continue under the [publication preparation plan](../plans/2026-09-04-release-0-1-18-publication-preparation.md)
and canonical [macOS runbook](../runbooks/macos-stable-release-runbook.md).

1. Obtain installation authority and verify the exact signed ARM same-identity
   state-preserving upgrade, prompt-free operations and source/payload-bound
   manual-v2 lifecycle evidence.
2. Obtain physical Intel/macOS 14+ clean-install, discovery/offline, Keychain,
   Login Item and installed A-to-B evidence, or resolve a narrower public
   architecture scope with the owner. Any real upload needs the tester's own
   consent. Rosetta is not a substitute.
3. Finalize stable `1026` separately from exact annotated `v0.1.18`, with ARM
   previous-stable continuity and explicit Intel first-stable bootstrap when
   Intel is in scope; repeat final-byte gates. Complete exact-source CI/merge,
   public assets/feed validation and hosted schema/deployment checks before
   the corresponding publication. RC2 `1025.1` must not be relabeled stable.

The 0.1.17 manual-matrix deferral remains release-specific. No newly completed
step in this receipt supplies the missing physical or installed-runtime proof.
