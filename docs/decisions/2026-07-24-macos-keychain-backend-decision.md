---
title: macOS Keychain Backend Decision
date: 2026-07-24
type: decision-record
status: proposed
---

# macOS Keychain Backend Decision

## Decision

Use a thin, injectable native Keychain adapter backed by exact-pinned `@github/keytar@7.10.6` for the first macOS arm64 local-review artifact, subject to final packaged-binary signing, SBOM inclusion, adversarial backend tests, and clean-machine validation before acceptance.

Do not make the `/usr/bin/security` CLI the production write path. Its normal add/update interface accepts the password as a process argument, which can expose the secret briefly through process inspection. The existing local `secret` helper has the same limitation and is suitable for interactive developer credentials, not for silently creating the monitor's installation identity.

Do not use the archived Atom `keytar` package. Use only the maintained `@github/keytar` fork and load its exact hash-verified macOS arm64 prebuild directly. The package's ordinary JavaScript loader searches a mutable `build/Release` location before the packaged prebuild, so the release adapter must not use that loader.

The initial `@napi-rs/keyring@1.3.0` candidate is rejected. Its synchronous and asynchronous `getSecret` implementations convert every native read error to an absent value, and `deleteCredential` converts every native deletion result to a boolean. Missing data therefore cannot be distinguished from a locked or denied Keychain, ambiguity, or another operational failure. That violates the fail-closed identity contract even though its byte-secret API and package provenance are otherwise attractive.

## Verified package facts and local smoke

As checked on July 24, 2026:

- npm reports `@github/keytar@7.10.6`, MIT license, repository [`github/node-keytar`](https://github.com/github/node-keytar), and a February 6, 2026 publication date;
- the npm tarball SHA-256 is `6581f2c5a79c77ff0edd9f143d50e03c7ae2ec5b2d0781a8704b67fabeed55cf` and its included macOS arm64 prebuild SHA-256 is `855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a`;
- the native macOS implementation treats `errSecItemNotFound` as the one nonfatal missing case and propagates every other Security Framework error as a rejected promise;
- the package contains no network-capable runtime dependency; its install script only copies the included platform prebuild into `build/Release`;
- the included native prebuild is arm64 and links only Apple system frameworks/libraries, but is merely ad-hoc linker-signed rather than Developer ID signed;
- npm provides a registry signature but no provenance attestation for this release; and
- a throwaway random service/account smoke under the bundled Node `v24.14.0` successfully completed create, exact read-back, replacement, deletion, and confirmed-missing read-back. The throwaway credential was deleted in a `finally` cleanup path.

The rejected `@napi-rs/keyring@1.3.0` audit remains useful evidence: its wrapper and macOS arm64 tarballs have npm integrity/signature metadata and SLSA provenance, but the tagged source contains no committed `Cargo.lock`, its JavaScript loader honors `NAPI_RS_NATIVE_LIBRARY_PATH`, version enforcement is opt-in, and the published native binary is only ad-hoc linker-signed. Most importantly, the native binding deliberately erases read/delete error distinctions, which is an application-level stop condition.

These facts establish feasibility, not acceptance. Registry signatures, source review, and a local smoke do not prove reproducible native bytes or safe behavior under every Keychain policy state.

The release runtime should use a pinned Node 24 LTS build rather than the developer machine's Node 26 Current build. The [official Node release table](https://nodejs.org/en/about/previous-releases) marks v24 as LTS and v26 as Current, while the [Node 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) confirms the required `DatabaseSync` surface. The exact patch release remains an artifact-build input and must pass the full suite before freeze.

## Capability separation

Use fixed service/account pairs that are public constants, never participant data:

| Capability | Service | Account |
|---|---|---|
| Export participant identity | `app-usagemonitor.export-identity.v1` | `installation` |
| Account-observation HMAC | `app-usagemonitor.account-observation.v1` | `installation` |

Future upload authentication, recovery, device pairing, and notification references require different services and independent random values. They must not derive from either local telemetry capability.

## Adapter contract

The application-facing backend should expose only:

- `read(capability) -> 32-byte secret or missing`;
- `createIfMissing(capability, generated32Bytes) -> created or existing`;
- `replaceExact(capability, expectedOld, replacement) -> replaced or conflict`;
- `deleteExact(capability, expectedValue) -> deleted, missing, or conflict`; and
- `describe(capability) -> backend/status` without returning values.

The core identity module must depend on this interface, not import a native package directly. Tests use an in-memory adversarial backend. The production adapter must load only the declared macOS arm64 binary after verifying its exact SHA-256 and package version, and fail closed with a content-free backend code when unavailable. It must map native errors to fixed codes without surfacing upstream messages.

Keytar stores a string rather than arbitrary bytes. Encode the exact 32-byte secret as canonical unpadded base64url and reject anything other than 43 characters that decodes back to exactly 32 bytes. The adapter must never call credential enumeration APIs.

Keytar does not expose compare-and-swap. `createIfMissing`, `replaceExact`, and `deleteExact` therefore require the existing application identity lease, exact pre-read comparison, mutation, and exact read-back verification. This serializes this application but cannot prevent a malicious same-user process from racing the Keychain directly; that residual is explicit and does not justify silently accepting disagreement.

## Migration and rotation

1. Inspect Keychain and the strict owner-file backend without creating either.
2. If only Keychain exists, use it.
3. If only the owner file exists, copy its exact 32 bytes into an absent Keychain item under a process/installation lock, verify read-back equality, then write a non-secret file-retirement marker. Do not delete the old file automatically in the same release.
4. If both exist and differ, fail closed; never pick the newer one or merge histories.
5. Rotation requires a non-mutating preflight and target-specific confirmation. Hold the identity lease, compare the exact old secret, replace with a new 32-byte value, verify read-back, and return only whether pseudonyms changed.
6. A rotation is a continuity break. Incomplete workspaces created under the old identity remain non-resumable and must use the separate safe discard flow.

## Uninstall behavior

Normal uninstall preserves both Keychain capabilities so reinstall keeps the participant/account continuity track. Permanent local identity removal is a separate destructive command with its own preflight and confirmation. It must explain that old local bundles remain pseudonymous artifacts but future exports cannot reproduce their participant/account identifiers.

Deleting the Keychain item is logical credential deletion, not a secure-media-erasure claim.

## Acceptance tests

- Exact dependency and native binary are pinned by lockfile, registry integrity, hard-coded selected-prebuild digest, release checksum inventory, and final artifact checksum.
- Static source/tarball audit finds no install scripts, network calls, logging, credential enumeration, or unrelated filesystem access on the selected API path.
- A dedicated throwaway service passes create, concurrent create, read, compare, rotate, missing, conflict, delete, cancellation, locked-Keychain, and denied-access cases. The basic create/read/replace/delete/missing smoke has passed; policy-denial and concurrency cases remain open.
- Unit tests prove secrets never appear in thrown errors, stdout, stderr, test names, fixtures, process arguments, environment variables, logs, receipts, or generated reports.
- Migration from the strict owner file is idempotent and refuses disagreement.
- Export, status-line capture, verification, deletion/discard, and uninstall retain correct behavior when Keychain access is unavailable.
- The clean-machine artifact triggers only the expected macOS Keychain access behavior and documents any user prompt accurately.

## Residual risks

- A native dependency increases the signed release's supply-chain and ABI surface; the selected npm release lacks provenance attestation and its prebuild is not independently reproducible from a committed native dependency lock.
- Keytar necessarily holds the base64url secret in immutable JavaScript strings as well as native memory during an operation; the application makes no reliable memory-erasure claim.
- There is no Keychain compare-and-swap primitive in the adapter, so a same-user process can race an operation outside the application lease.
- macOS may prompt, deny, lock, or change access-control behavior across OS versions.
- Any malicious process already running as the same logged-in user may call the same user-authorized Keychain interface; this project does not claim same-UID sandbox isolation.
- Keychain deletion does not guarantee physical erasure from backups or storage media.

The decision becomes accepted only after the package/native audit, live throwaway-service smoke, backend tests, packaging/SBOM integration, and clean-machine validation all pass.

## Addendum (2026-08-11): durable ACL for the contribution-device credential

This record rejected the `security(1)` write path for the **installation
identity**. The contribution-device credential is a different, weaker bearer:
revocable, rate-limited, auto-renewing (~25-day rotation), and scoped only to
uploading privacy-safe aggregate telemetry — not an identity or password.

Its keytar-minted item was lost on every signed app update: the default
`SecItemAdd` ACL trusts the creating binary by code-identity snapshot, so a
Sparkle re-sign of `runtime/bin/node` was denied read access
(`device_unavailable`), forcing the user to re-authenticate every few days —
defeating the "sign in once" design. keytar exposes no `SecAccessRef` /
`kSecAttrAccessGroup`, so a designated-requirement ACL is not expressible
through it; the alternatives (access-group entitlement; partition-list) need
native code or the interactive login password.

**Owner decision (explicit, 2026-08-11):** for THIS credential only, mint via
`security add-generic-password -T <node reader>` so read access is bound to the
reader's **designated requirement** (`anchor apple generic and
certificate leaf[subject.OU]="43RTH622SB" and identifier "node"`), which is
stable across every same-team signed build. The accepted cost is a brief
argv exposure of the secret during the one-time mint (visible to same-user /
root process inspection for milliseconds). This is weighed acceptable because
the credential is revocable, auto-renewing, and low-value, and because a CLI
failure falls back to keytar's default ACL so availability never regresses.
The installation identity's rejection of this path stands unchanged.
