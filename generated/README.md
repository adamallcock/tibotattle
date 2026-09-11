# Generated artifacts

Committed release evidence and contract artifacts—never gitignore this
directory and never edit its files by hand. Generators and exact-set tests
validate artifact shape and provenance rules; a retained receipt still proves
only its recorded source digest, environment, and date. It does not become
current merely because the file remains checked in or its schema still passes.

Telemetry contract outputs are routine generated mirrors. R7 receipts are
private-corpus, dual-runtime release evidence: any bound source change makes
the retained set historical until an owner-authorized regeneration completes.
Do not regenerate R7 merely to make a documentation or source checkout appear
current.

Owning commands:

```bash
npm run benchmark:r7:release:regenerate   # r7-release-* evidence receipts
npm run telemetry:generate                # telemetry contract artifacts
```

Use `npm run telemetry:check` for routine telemetry validation. Follow the
maintained R7 receipt runbook before the protected regeneration command.
