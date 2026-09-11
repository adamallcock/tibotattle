# Native platform security guidance

Scope: all files under `native/`. Apply the repository root guidance first.

## macOS Keychain adapter

- For `macos-keychain/`, read its README and `apps/macos/AGENTS.md`.
- Keep only the fixed logical credential capabilities. The signed Electron
  main process owns the adapter; renderer input cannot select Keychain items.
- Preserve existing credential bytes and ACLs. Locked, denied, unknown and
  legacy-only items must never become proof of absence or a fresh identity.
- Source compilation and injected tests must not access real Keychain items.
  Signed, prompt-free native-to-Electron continuity is a separate release gate.

## Windows security boundary

- Read `native/windows-filesystem/README.md` before changing the binding, loader,
  manifest, or credential-mutex integration.
- Keep the native module a small, content-free C N-API security adapter. JavaScript
  path checks are not substitutes for Windows handle, ACL, reparse-point, link,
  owner, and canonical-path validation.
- Native capability booleans are claims to verify against the adjacent manifest
  and approved policy, not self-enabling feature flags.
- Preserve fail-closed behavior for unsupported OS/architecture, missing or
  mismatched manifest/binary, invalid ACL/owner/link state, reparse points,
  abandoned or foreign leases, and replacement races.
- Path operations bind decisions to open handles and expected file identity.
  Never split validation from mutation through a later path-based reopen when a
  same-user race could replace the object.
- Keep credential storage, filesystem safety, cross-process mutex, operation audit,
  and production selection as distinct capabilities. Passing one cannot enable
  another.

## Windows qualification and release truth

- The current binding and manifest deliberately leave overall production/path
  safety disabled. Do not flip an approval flag, add a JavaScript fallback, or
  claim Windows support without the exact native qualification and release gates.
- A sidecar hash detects mismatch; it is not source provenance or publisher
  authentication. Packaging/signing must authenticate exact final bytes
  separately.
- Keep the binding Windows x64-only unless a new architecture receives its own
  build, ABI, security, physical-runtime, packaging, and artifact-integrity proof.
- Use protected owner-only DACLs and non-inheritable handles. Any service-account
  or broader-principal policy requires an explicit threat-model decision.
- Never log private paths, SIDs, credentials, file bytes, or raw Windows error
  context. Return fixed content-free categories to JavaScript.

## Windows validation

- Run portable JavaScript contract tests for loader/refusal behavior, but label
  them partial. macOS, Linux, Wine, and cross-compilation do not qualify Windows
  kernel behavior.
- Use the manual native Windows x64 workflow for authoritative build, binding,
  ACL/reparse/race, credential-mutex, and content-free audit qualification.
- Rebuild the binary and manifest together with the pinned toolchain. Verify exact
  bytes, ABI, manifest policy, and loader refusal for tampering before integration.
- Windows packaging, signing, installer, updater, and physical GUI behavior remain
  separate release gates even after native security tests pass.
