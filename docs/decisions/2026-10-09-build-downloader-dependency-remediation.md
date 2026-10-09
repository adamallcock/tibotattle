---
title: Remove the legacy build downloader dependency chains
date: 2026-10-09
type: decision-record
status: implemented
---

## Scope and source contract

Root build tooling retains `electron-builder` and `app-builder-lib` **26.15.7**.
A scoped pnpm override selects **@electron/get 5.1.0**, with its optional proxy
dependency pinned to **undici 7.29.1**. The existing builder patch retains the
Windows signing ledger and Linux sandbox changes and adds only the downloader
adaptation. This changes source tooling; it does not qualify or publish a new
client artifact and does not deploy the Worker.

The old `got`, `cacheable-request`, `http-cache-semantics`, `global-agent`,
`roarr` and `sprintf-js` packages are absent from both recursive root lock
sections and the isolated installed dependency inventory. Consequently the
root HTTP-cache patch, OSV exception and expiring guard are retired in this
source. The [earlier exception decision](2026-10-03-v0-1-27-http-cache-advisory-exception.md)
remains historical evidence for its exact earlier source and artifacts; its
scope and exclusive October 10 expiry are not extended to replacement builds.

This is dependency removal, not a finding that stock HTTP-cache 4.3.0 is fixed.
The [published 4.3.0 source](https://registry.npmjs.org/http-cache-semantics/4.3.0)
still contains the reviewed max-stale path, and the
[advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) did not identify a
patched version when this change was prepared.

## Downloader compatibility

The fetch deadline, proxy and retry adaptation follows the published
[builder 27.0.0-alpha.10 source](https://registry.npmjs.org/app-builder-lib/27.0.0-alpha.10)
without adopting that alpha builder or its unrelated dependencies. The reviewed
`dist/util/electronGet.js` SHA-256 is
`bfe282556ef6333b60c828c52a094e2f384512355a5b974c78af7fd12fbb72fd`.

Both stable builder download entrypoints use the adapter. Artifact naming,
mirrors, archive locks, cache modes and checksum verification remain owned by
the existing builder and get. Each retry receives a fresh request deadline;
caller cancellation is retained. The adapter handles fetch error status and
nested network error codes and closes only dispatchers it creates. Proxy
selection honors HTTP_PROXY, HTTPS_PROXY and NO_PROXY and their lowercase
forms. Missing proxy support fails rather than silently downloading directly.

Legacy request deadlines and explicit HTTPS trust options are translated.
Default TLS certificate verification stays enabled. A caller-supplied fetch
dispatcher remains caller-owned. Arbitrary legacy Got options, phase-specific
Got deadlines, and conflicting dispatcher/HTTPS options are explicitly refused;
they must not be silently ignored by fetch. A caller-provided downloader retains
its own option contract. No repository packaging configuration currently uses
an unsupported custom Got option.

## Permanent validation boundary

`scripts/check-build-download-dependencies.mjs` checks the exact scoped pins,
patch/lock agreement, all recursive root lock package records and the isolated
installed package inventory. It refuses reintroduced legacy packages, another
root lock or a root OSV suppression file. Its negative tests cover changed
pins, missing inventories, changed patch bytes and each removed package.

`test/electron-build-downloader.test.js` uses content-free loopback fixtures to
exercise actual downloads, the stable builder entrypoint, progress callbacks,
transient retries, fresh deadlines, cancellation, checksum rejection, corrupt
cache recovery, explicit disk-cache reuse, HTTP-response non-reuse, proxies and
TLS trust. No fixture launches an app or uses signing credentials.

The OSV workflow runs these checks and retains the Windows signing-patch tests
and executable scanner-shell failure tests. It still scans all committed locks
recursively using the same checksum-pinned scanner, without suppression or
continue-on-error. The independent Worker lock remains separately owned.

Root dependency/source tests do not establish a clean future advisory scan,
native platform behavior or release trust for new binaries. A replacement
candidate requires an exact-source scan, the maintained source and release
gates, and fresh four-platform artifact qualification under the release
runbook. Production candidate preparation uses Node **26.2.0** and pnpm
**11.9.0**.
