# Signed synthetic Keychain migration fixture

These Swift mains are test-only compositions for
`test/helpers/verify-signed-keychain-migration.mjs`. They exercise the shared
production migration protocol and adoption algorithm without reading
application credentials from or changing the login/default Keychain. The
explicit signing stage may use the operator's existing approved signing key;
that is separate from the fixture's Keychain access.

The runner is deliberately inert unless `--run-signed` is supplied. A live run
also requires an explicitly selected legacy app, and a signing-identity label in
`TIBOTATTLE_MIGRATION_SIGNING_IDENTITY`. The label is never rendered or stored.
The runner refuses any legacy Node whose verified designated requirement is not
the reviewed `node` Developer ID requirement.

```sh
# Inert: shows the plan only.
node test/helpers/verify-signed-keychain-migration.mjs

# Builds test fixtures only; no Developer ID signing and no fixture execution.
node test/helpers/verify-signed-keychain-migration.mjs --compile-only

# Explicit protected run, after operator authorization and local label setup.
node test/helpers/verify-signed-keychain-migration.mjs --run-signed \
  --legacy-app "/explicit/path/to/previous/TiboTattle.app"
```

Each signed run creates a new mode-0700 directory, a private file-based Keychain
at its fixed generated path, and a random synthetic 43-character base64url value.
Only default-Keychain selection and search-list metadata are captured in memory
and compared as bytes; their paths are never emitted. Fixture reads always pass the disposable
`SecKeychainRef` as `kSecMatchSearchList` and disable SecurityAgent interaction.
The old item is retained until all assertions complete.

The signed negative cases cover a direct shell, wrong/ad-hoc parent identities,
invalid capabilities, malformed/oversized frames, invalid continuation, missing
requests and malformed values. One fixture stalls inside its injected reader;
another also lets its authenticated parent exit without child cleanup. Both
must stay bounded, and neither stall fixture opens a Keychain. A PID observed
after parent exit is checked with signal zero only, never killed by the runner.

Compilation uses frozen copies of the actual shared source and fixture bytes;
current-source hashes must still match before signing and at completion. The
inert runner contract is safe for ordinary tests:
`node --test test/macos-keychain-migration-runner.test.js`. It is included in
the ordinary root and retained macOS gates; those tests never opt into signing.

Cleanup uses only the signed creator compiled with that run's fixed path. It
validates the root marker, UID, mode, inode and device before calling
`SecKeychainDelete` on the exact disposable Keychain reference. It never changes
the default or search list and has no general path argument. If cleanup cannot
establish ownership, it fails closed and leaves the private fixture directory
for manual review.

### Owned-write receipts

The file-based Keychain legitimately replaces its database inode when a write
commits: Apple's `AtomicTempFile::commit()` preserves security metadata and then
renames a temporary file over the database. Pinning only the inode immediately
after creation is therefore insufficient for the first seed insertion and later
adoption. [Apple Security FileDL implementation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_filedb/lib/AtomicFile.cpp)

`keychain-owner.json` is an immutable version-2 baseline. The fixture records an
immutable `keychain-write-NN-intent.json` before each of its bounded, serial
mutations, then a separate completion only after the exact Security operation
has been verified. Seed and successful adoption require exact-value readback;
rollback requires successful removal of the actual newly created item and an
absent modern-item readback. A no-op/refusal may not change the inode. The
original baseline, intent, and each before/after identity remain available.

Only this ordered, nonce-bound, same-device chain can advance the inode pin.
Normal opens and cleanup match the latest completed identity exactly. Missing,
reordered, unknown, failed, or incomplete writes do not authorize any inode;
best-effort failure receipts contain metadata only. Creation intent alone also
does not authorize cleanup without a baseline. The file must remain an
owner-only, single-link regular file inside the same immutable root.

`OwnershipPolicyTests.swift` exercises the actual pure reducer with synthetic
metadata: the seed/adoption inode-replacement regression, unchanged writes,
rollback, incomplete/failing operations, nonce/sequence/device/identity
tampering, orphan completions, and the write bound. Compile-only builds its
`ownership-policy-tests` executable without linking Security or fixture support.
It does not execute it; the explicitly invoked signed run executes these pure
assertions before signing or accessing the disposable Keychain.

### Separately reviewed orphan cleanup

`RecoveryMain.swift` is **not** part of normal compilation, signing, or cleanup.
It supports only a separately approved recovery of an independently reviewed
failed synthetic fixture. It takes no path, nonce, or inode arguments. The
operator must compile a private `ProbeRecoveryConfiguration` with the exact
canonical `root`, root `device`/`rootInode`, `uid`, `nonce`, `originalInode` from
the preserved baseline, and independently observed `reviewedInode`, `size`,
`mtimeSeconds`/`mtimeNanoseconds`, `ctimeSeconds`/`ctimeNanoseconds`, and
`birthSeconds`/`birthNanoseconds` for the database. Never derive these pins
automatically from the file at execution time, and never edit the old baseline
to make it agree with a replacement.

After compiling and reviewing that pinned composition, its only accepted
argument is `--delete-reviewed-synthetic-keychain`. It revalidates the immutable
root, original markers, and full reviewed database metadata; refuses a target
in the current/user search list or selected default; opens only that exact
`SecKeychainRef`; and rechecks its path and metadata immediately before
`SecKeychainDelete`. It never reads an item or password. New
`reviewed-cleanup-intent.json` and `reviewed-cleanup-result.json` preserve the
separate recovery evidence without rewriting the failed run's receipts. It
compares default/search-list metadata in memory and never changes preferences.
An unmatched pin stops recovery; there is no arbitrary-inode fallback.

The recovery path guard uses exact POSIX `realpath`, not Foundation URL
standardization, which can abbreviate `/private/var` to its `/var` alias on
macOS. Compile `RecoveryMain.swift` alone with `-D PROBE_RECOVERY_PATH_TEST`
and `-framework Foundation` to test that same guard against the reviewed root.
This composition does not import/link Security, read receipts, or write files;
it checks the canonical root and rejects aliases, dot/trailing components,
relative/NUL-bearing paths, and a missing path. The normal cleanup composition
retains every root, owner, nonce, device, inode, and timestamp pin.

This is signed synthetic evidence for the Security API and designated-
requirement approximation. It is not proof about an individual user's existing
item ACL, Keychain lock state, or a notarized old-to-new installer replacement.
