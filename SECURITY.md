# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories on this repository](https://github.com/adamallcock/tibotattle/security/advisories/new).
Do not open a public issue for a security problem.

You should receive an acknowledgement within a few days. There is **no bounty
program**; reports are handled on a best-effort basis by the maintainer.

## Scope

Two distinct surfaces share this repository:

- **Local macOS app** (`apps/macos`, `apps/local`, `apps/web`, `src/`,
  `packages/`): runs entirely on your machine, binds to loopback only, and
  works fully offline. Issues that break the privacy model — content leaving
  the machine without consent, prompts/responses/paths entering derived
  artifacts, loopback exposure — are in scope and treated as high priority.
- **Hosted contribution service** (`apps/worker`, served at
  [tibotattle.com](https://tibotattle.com)): operated by the maintainer.
  Issues affecting the hosted aggregates, contributor pseudonymity, or the
  upload/deletion endpoints are in scope. Please do not run disruptive
  testing (load, enumeration, or exhaustion) against the live service.

## Do not include session content in reports

TiboTattle's whole purpose is keeping coding-agent session content private.
**Never include prompts, model responses, or real file paths from Codex
sessions in a security report.** Reproduce with redacted or synthetic data;
if the issue genuinely requires real session evidence, say so in the private
advisory and the maintainer will arrange a safe way to verify.

## Verify a release

For a specific published release, its checksum, platform signature, SBOM, and
any build attestation establish different parts of the distribution chain.
Follow [Verify a TiboTattle release](docs/verify-release.md) for the exact
commands and the current macOS, Windows, and Linux availability boundary. The
GitHub release is canonical for the v1 manifest, any non-null SBOM, and any
non-null attestation bundles; the website exposes download availability and
digest. A v1 artifact may explicitly set `sbom`, `sbom.attestation`, or
`provenance` to `null`, meaning that evidence was not published. A checksum
confirms exact bytes; it is not, by itself, a safety or source-provenance claim.
Source-to-binary provenance is claimed only when a trusted hosted workflow
generated/finalized and cryptographically verified the exact final bytes for
that release.
