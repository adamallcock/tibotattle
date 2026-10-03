---
title: HTTP cache semantics max-stale mitigation checkpoint
date: 2026-10-03
type: review
status: independently-reviewed-local-checkpoint
---

## Scope and release boundary

This client `max-stale` mitigation checkpoint is based on PR #262 head
`dd9e03aae0ba685d2d0604aa74ce40dc2de32784`, on branch
`codex/http-cache-mitigation-20261003`. It changes the root pnpm dependency
installation only. No website, hosted runtime, native app, release or installed
artifact qualification is claimed.

The OSV gate remains enabled with `fail-on-vuln: true`, its existing immutable
action pin and existing scan inputs. There is no waiver, advisory exclusion,
package rename or version relabel. The dependency still identifies itself as
`http-cache-semantics@4.2.0`. The advisory has no published fixed version as of
this review. A verified source patch does not establish an OSV pass; PR #262's
reported dependency failure remains a release prerequisite until separately
resolved under the existing policy.

## Patch provenance and source review

[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
(CVE-2026-93748) describes client `max-stale` overriding shared-cache reuse
restrictions. The selected change is [upstream PR #58](https://github.com/kornelski/http-cache-semantics/pull/58),
pinned to `14a8c2ad51740dc39bf3e8f1a11c845a5003f217`, based on
`f01112e954b83cfa8765b633ba880e5e980aa54c`. At review the PR was open and
unmerged, and GitHub returned no review approvals or check runs. Adoption is
based on local source review and tests, not an upstream approval claim.

The change extracts the existing response reuse restrictions into
`_requiresRevalidation()` and checks them before request stale allowances.
It preserves the package's CommonJS export, public API and package version.
The local patch changes only `index.js`; its source content equals the pinned
PR head. The source byte digests are:

| Input | SHA256 |
|---|---|
| Installed registry 4.2.0 `index.js`, identical to upstream base | `01b7d66c854b2fe53ac05c98feb6e0d64722ab8898a778e2d2426a8b468d178f` |
| Patched `index.js`, identical to pinned upstream head | `fc7b3f0265b7a7d0fee83bafa47186a66495720d3179801c2be3083de6d0cf76` |
| Local pnpm patch | `6e7076d25b3bdb7a6e9cd709a5d6f63c3b9f0d9308f12659b2dddb08dc904a93` |
| Preserved `app-builder-lib@26.15.7` patch | `5821cdf7573fa16696c7b0440c919f360393e91520a42fd81360eb6a5de555b8` |

The existing builder patch and lockfile hash are unchanged. Only the root
`pnpm-workspace.yaml` mapping, new patch file, and corresponding root
`pnpm-lock.yaml` patch metadata and snapshots change. Worker npm locks and
OSV automation are unchanged.

## Local verification

Environment: macOS arm64, Node 26.2.0, pnpm 11.9.0.

- Baseline frozen installation reproduced the security regression: a shared
  cookie response accepted client `max-stale` despite its zeroed lifetime.
- `pnpm install --lockfile-only --ignore-scripts` regenerated the owning lock.
- Patch context blank lines omit their otherwise whitespace-only context prefix
  to satisfy repository whitespace policy. pnpm patch application still produces
  exactly the pinned upstream head source hash.
- A fresh `pnpm install --frozen-lockfile --ignore-scripts` installed the patched
  bytes. Dependency install scripts were disabled; no native signing ran.
- `node --test test/http-cache-semantics-security.test.js test/electron-windows-production-signing.test.js`
  passed 19/19: five new checks and fourteen existing signing-contract tests.
- Client `max-stale` security cases cover shared cookies, `proxy-revalidate`, `no-cache`, `no-store`
  and shared `private` responses. Positive cases cover normal fresh/stale reuse,
  explicit public cookie responses, and private cache behavior.
- Tests resolve through the actual builder dependency chain:
  `electron-builder` → `app-builder-lib` → `@electron/get@3.1.0` → `got` →
  `cacheable-request` → `http-cache-semantics`. CommonJS entrypoints load.
- Loopback `cacheable-request` integration checks cookie-response revalidation
  and ordinary cache reuse. Its adapter may expire zero-lifetime entries; the
  standalone policy tests exercise retained entries and reproduce the flaw.

An incremental pnpm install initially linked a patch-hash path whose contents
remained unpatched. This was diagnosed by hashing the installed source; a fresh
installation produced the pinned patched hash and passing tests. A dedicated
installed-byte regression now refuses that stale state. A successful install
command or patch-hash directory name alone must not be treated as mitigation
proof.

Repository documentation governance and `npm run test:preflight` also passed
(the preflight documentation tests passed 20/20).

## Independent review limitation

Independent review accepted the exact pinned patch for the advisory's client
`max-stale` path and independently verified the patch, installed-source and
preserved builder-patch hashes.

A separate required-validation defect remains in `revalidatedPolicy()` when an
explicit shared cache uses `stale-if-error`: `no-cache` and shared
`proxy-revalidate` responses can be reused after an origin error without
successful validation. [RFC 9111 section 4.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.4),
[section 5.2.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4)
and [section 5.2.2.8](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.8)
require validation for these cases. The pinned
[upstream source](https://github.com/hellonewday/http-cache-semantics/blob/14a8c2ad51740dc39bf3e8f1a11c845a5003f217/index.js#L835)
has an unguarded error fallback. This is separate from the selected advisory
path; this checkpoint does not repair it. A cookie response alone with explicit
`stale-if-error` is not itself an RFC violation, and the actual adapter did not
store the shared private response.

The reviewer reproduced the separate path through the installed adapter using
an explicit Map cache and default shared-cache behavior. Its local synthetic
reproduction is preserved at
`/private/tmp/tibotattle-http-cache-review-repro.cjs`; no private data is used.
The installed got adapter activates HTTP caching only when `options.cache` is
truthy; `got.defaults.options.cache` is undefined. Builder downloader options
add progress and agent behavior without enabling that cache. The downloader's
artifact filesystem cache is a separate mechanism. No default application or
cross-user exploit was demonstrated. The source checkpoint and regression tests
remain scoped to the accepted client `max-stale` fix.

## Remaining gates

Independent source review is complete for the narrow advisory path. OSV advisory
resolution remains pending. The pinned scanner's
[pnpm parser](https://github.com/google/osv-scalibr/blob/23fa66ca68dd/extractor/filesystem/language/javascript/pnpmlock/pnpmlock.go)
extracts the npm package version and does not attest the local patch bytes.
Consequently this version-preserving patch leaves `http-cache-semantics@4.2.0`
subject to the existing finding. No compatible published fixed version or
existing repository advisory-exception policy was found during the bounded
review. The remaining owner choice is to wait for a compatible published fix,
or explicitly establish and approve a narrowly scoped exception policy for this
reviewed patch. No exception mechanism is applied or proposed as a workflow edit
here.
No scanner pass, Azure signing, Windows packaging, website release or deployed
behavior is claimed. The existing OSV parser recognizes the npm version rather
than attesting these patch bytes; do not remove or reinterpret the finding to
make this mitigation green. The owner controls release and any separate policy
decision; this change establishes no exception.
