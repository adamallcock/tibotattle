# GitHub automation guidance

Scope: all files under `.github/`. Apply the repository root guidance first.

## Trust and permissions

- Treat workflow and composite-action changes as executable supply-chain changes,
  not documentation. Read the called scripts, action definitions, event model,
  permissions, environments, and artifact flow end to end.
- Grant the least GitHub token and OIDC permission at the narrowest job. Keep
  default permissions read-only and isolate jobs that need attestations,
  packages, releases, or other writes.
- Pin third-party actions to reviewed immutable commit SHAs. A version tag or
  floating branch is not an immutable dependency.
- Treat pull requests, forks, issue text, branch names, artifacts, caches, and
  downloaded files as untrusted. Never expose secrets or write-capable tokens to
  fork-controlled code or interpolate untrusted values into shell commands.
- Do not use `pull_request_target`, privileged checkout, artifact reuse, or cache
  sharing to bypass the fork trust boundary.

## Release evidence

- Keep build, finalization, checksum, SBOM, attestation, provenance, signature,
  publication, and deployment as distinct jobs and claims. Bind evidence to the
  exact final bytes it names.
- A generated SBOM or attestation is not release publication, platform signing,
  notarization, installer qualification, or live availability.
- Preserve nullable release-evidence semantics. Missing evidence stays null and
  must not be replaced by an unverified path, placeholder, or earlier artifact.
- Keep artifact names, subjects, digests, retention, and handoff explicit. Reject
  ambiguous multi-file subjects and prevent a later job from silently rebuilding
  bytes already attested.
- Current workflow presence or an absent failing check does not prove general CI
  coverage. State which workflow, event, commit, platform, and job actually ran.

## Change and validation discipline

- Do not enable, dispatch, rerun with writes, approve environments, publish
  releases, or change repository settings/secrets without explicit authorization.
- Preserve fail-closed policy checks, action permissions, immutable pins, fork
  guards, and manual platform gates. Do not weaken them to make a workflow green.
- Run `node scripts/check-release-workflow-policy.mjs` and
  `npm run release:trust:check` for release-trust/action changes, plus the owning
  SBOM, attestation, web, native, or Worker tests.
- Validate YAML structure and inspect the fully expanded shell/action boundary.
  A local policy test cannot prove hosted runner images, secrets, OIDC issuance,
  environment approval, or a successful GitHub run.
- Keep manual Windows portability evidence separate from packaging/signing/support,
  and keep OSV scanning separate from the repository's general test status.
