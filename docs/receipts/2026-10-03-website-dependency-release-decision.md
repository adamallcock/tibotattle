---
title: Website dependency release decision packet
date: 2026-10-03
type: decision-record
status: owner-approved-local-implementation-pending-review
---

## Decision ready for review

The owner approved the reviewed narrow mitigation and time-bounded exception on
2026-10-03. Local implementation is prepared for independent review; no remote
branch, merge or publication is changed. The sections describing the proposal
preserve the reviewed scope; the accepted operational decision is
[temporary advisory exception](../decisions/2026-10-03-http-cache-advisory-exception.md).
Hosted OSV and website release remain separate pending gates.

## Fresh official status

Read-only checks at 2026-10-03T21:22:48Z found official
[npm latest metadata](https://registry.npmjs.org/http-cache-semantics/latest)
still reports 4.2.0. The [GitHub advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
remains active, affects versions through 4.2.0 and reports no patched version;
its API update timestamp is 2026-10-02T22:36:44Z. [Upstream PR #58](https://github.com/kornelski/http-cache-semantics/pull/58)
remains open and unmerged at `14a8c2ad51740dc39bf3e8f1a11c845a5003f217`.
There is no newly published compatible fix in these checks. The previous bounded
transitive review found no compatible published replacement; overriding
CommonJS `@electron/get@3.1.0` with the ESM major is not a reviewed remedy.

## Concrete mitigation evidence

The isolated branch `codex/http-cache-mitigation-20261003` has reviewed source
commit `aa8586736c78ae77aae20f0a56072dcfd58481bc`, based on exact PR #262 head
`dd9e03aae0ba685d2d0604aa74ce40dc2de32784`. Its five-file change adds the pnpm
patch, owning root lock metadata, five regressions and a provenance receipt.

| Required identity | SHA256 |
|---|---|
| Installed patched index.js, exact upstream PR head | `fc7b3f0265b7a7d0fee83bafa47186a66495720d3179801c2be3083de6d0cf76` |
| pnpm patch file and lock hash | `6e7076d25b3bdb7a6e9cd709a5d6f63c3b9f0d9308f12659b2dddb08dc904a93` |
| Unchanged builder patch | `5821cdf7573fa16696c7b0440c919f360393e91520a42fd81360eb6a5de555b8` |

Fresh frozen installation with pnpm 11.9.0 and Node 26.2.0 verified exact bytes.
The installed-byte, max-stale restriction, ordinary-cache, CommonJS and loopback
adapter tests plus existing Windows signing-contract tests passed 19/19.
Preflight passed 20/20 and documentation governance passed. These are source and
synthetic compatibility proofs, not signing, native installation or deployment.
An incremental installation previously retained stale source despite a patch-hash
path; acceptance must use installed-byte proof, not installation success alone.
See [full mitigation receipt](2026-10-03-http-cache-semantics-mitigation.md).

Independent review accepted the exact advisory max-stale repair. It separately
found stale-if-error required-validation reuse for no-cache and shared
proxy-revalidate with an explicitly enabled shared HTTP cache. That is outside
the selected advisory patch. Set-Cookie alone with explicit stale-if-error is
not an RFC violation; the actual adapter did not store shared private responses.
Installed downloader HTTP caching defaults disabled; its artifact filesystem
cache is distinct. No default application or cross-user exploit was demonstrated.
The separate synthetic reproduction remains local at
`/private/tmp/tibotattle-http-cache-review-repro.cjs`.

## Approved proposal scope and original decision boundary

Proposed scope: only GHSA-ch52-4w7c-c8xp and its CVE alias, for the root pnpm lock's
patched http-cache-semantics 4.2.0 in the reviewed builder chain. No blanket package
exclusion, other advisory suppression, identity rewrite or fail-on-vuln change.
Acceptance is conditional on the exact three hashes above, passing 19 focused
tests on the integrated source, and continued disabled downloader HTTP caching.
The owner must explicitly accept the separately documented residual limitation.
A change enabling shared HTTP caching, changing the patch bytes or dependency
chain invalidates this proposal and requires new review before release.

Proposed expiry: 2026-10-10 UTC, without automatic renewal. Remove sooner when a
compatible published fix is validated and adopted, the advisory is withdrawn or
corrected, or any evidence condition fails. At expiry the finding must block
again unless the owner separately reviews a replacement decision. Review npm
and advisory status before release; a published fix supersedes this proposal.

At proposal time no repository advisory-exception policy or scanner configuration
was found. The owner subsequently approved this exact temporary scope,
accountability and expiry; the linked accepted decision now supplies authority. The [scanner's documented mechanism](https://google.github.io/osv-scanner/configuration/)
is a directory-local `osv-scanner.toml` with `[[IgnoredVulns]]`, the advisory ID,
`ignoreUntil` and a reason. IDs also suppress their aliases. A root-local config
applies to root locks, not child lock directories; using global `--config` would
broaden scope and is outside this proposal. The mechanism itself does not match
package version or enforce patch hashes, so those conditions need an independently
reviewed mechanical gate before an exception could safely be implemented.
The approved local implementation supplies that proof gate and root-local config.
Pinned OSV 2.5.1 synthetic tests confirmed unrelated findings still fail, expired
config restores the finding, and child locks do not inherit the root exception.
Scanner failures are not continued, so operational errors fail the same job.
Independent review and actual integrated hosted CI remain pending.

## Original owner options and remaining release gates

1. Choose waiting for a published fix, or explicitly approve the proposal's
   narrow advisory scope, residual limitation, expiry and required proof gate.
2. If approved, authorize a separate policy/configuration implementation and
   independent review; this packet cannot grant that authority.
3. Integrate the reviewed mitigation into the owner-controlled PR source,
   refresh frozen-install byte proof and focused tests, and obtain the actual
   OSV result. The parser currently extracts npm versions rather than attesting
   pnpm patch contents, so the local patch alone cannot clear the finding.
4. The owner separately merges and releases the website prerequisite after its
   owning CI/release gates. No website/deployment claim follows from this packet.
