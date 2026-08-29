## What and why

<!-- What does this change do, and why? Link the issue if one exists. -->

## Verification gates

<!-- Check each gate you ran. If one is not runnable on your platform
     (product:macos:test requires macOS arm64 with Node v26.2.0), say so
     instead of leaving it unchecked silently. -->

- [ ] `npm test`
- [ ] `npm run docs:check`
- [ ] `npm run codex:contract:check`
- [ ] `npm run product:worker:check`
- [ ] `npm run product:macos:test`
- [ ] `npm run architecture:check`
- [ ] `npm run check` (or the environment-blocked lanes are named below)

**Platform tested:** <!-- e.g. macOS 15 arm64, Node v26.2.0 -->

## Content attestation

- [ ] This pull request (code, fixtures, commit messages, and description)
      contains no prompts, model responses, or real file paths from
      coding-agent sessions.

## Maintained documentation

- [ ] Every affected root/component README, public guidance page, maintained
      reference/runbook, support surface, and localized disclosure was updated
      in this change, or obsolete non-evidence documentation was removed with
      `git rm`.
- [ ] Any retained dated evidence still has an enduring audit, recovery,
      decision, or release purpose and accurate lifecycle metadata.

## Notes for the reviewer

<!-- `npm run check` is the complete gate. Focused checks are useful evidence,
     but do not imply that unavailable platform, dependency, signing, release,
     or deployment gates passed. Generated artifacts (generated/, contract artifacts) must come from
     their generators, never hand-edits — see CONTRIBUTING.md. Mention any
     regeneration commands you ran here. -->
