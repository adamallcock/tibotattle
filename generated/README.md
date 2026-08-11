# generated/

Committed release evidence and contract artifacts, revalidated by tests on
every run — never gitignore this directory and never edit these files by
hand. The R7 release receipts are checked against an exact expected file set,
so a hand edit or a stray file fails `npm test`. Regenerate only via the
generators:

```bash
npm run benchmark:r7:release:regenerate   # r7-release-* evidence receipts
npm run telemetry:generate                # telemetry contract artifacts
```
