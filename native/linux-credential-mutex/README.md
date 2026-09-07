# Linux credential mutex

This directory contains a small Linux x86_64 N-API boundary for the existing
`linux-credential-mutex-v1` contract. It is a qualification component, not a
selected credential backend or Linux support claim.

The binding holds its primary lease by binding a fixed Linux abstract AF_UNIX
socket name. It records a durable operation journal in the persistent XDG state
tree:

- socket namespace: `app-usagemonitor/linux-credential-mutex-v1/<effective-uid>/<capability>`
- persistent journal: `XDG_STATE_HOME/app-usagemonitor/linux-credential-mutex-v1`

When `XDG_STATE_HOME` is unset, the persistent base follows the XDG fallback
under the current account's home directory. The binding reopens roots with
Linux handle-based no-symlink checks, validates owner and mode constraints, and
refuses missing or unsafe roots. It does not accept a caller-selected socket or
journal path.

Acquiring a lease pins one journal file descriptor and fsyncs its `active`
state before returning to JavaScript. A normal, explicitly settled release
writes and fsyncs `normal` through that same descriptor. A callback failure,
process exit, or hard kill preserves `active`. The next acquirer receives an
opaque lease with `abandoned: true`; the JavaScript lease layer releases only
the socket and reports `recovery_required`. It never clears the active state.
Before every journal transition, the binding compares the pinned descriptor
with the fixed directory entry; a replacement fails closed without writing or
unlinking the replacement. A future explicit recovery workflow must bind any
clearing action to a durable credential-operation journal.

The abstract socket claim covers ordinary desktop application and companion
processes in the **same Linux network namespace**. It does not claim
cross-network-namespace exclusion, hostile same-UID filesystem tamper
resistance, Secret Service support, or production safety. Persistent
same-UID journal substitution is treated as unsafe and rejected when observed;
protecting a user-owned state tree against a hostile process with that same UID
is outside this qualification boundary.

The native lease is an external object with no enumerable authority fields.
The binding maintains an issued-lease registry, so forged, foreign, or
double-release tokens fail with fixed content-free codes. There is no JavaScript
or lockfile fallback.

Build and create the adjacent sidecar only on native Linux x86_64:

```text
node "$(npm root --global)/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild --directory native/linux-credential-mutex
node scripts/build-linux-credential-mutex-manifest.mjs
node scripts/qualify-linux-credential-mutex.mjs
```

The manifest checks exact bytes and closed native claims before the loader
requires the module. It is an integrity/mismatch check, not signing or source
provenance. `productionSafe` is deliberately false in both the binding and
manifest. Source tests, native Ubuntu x86_64 qualification, or this README do
not select Secret Service, participant identity, Electron composition,
packaging, update feeds, or Linux support.
