---
title: Repeatable GCS release adapter tests
date: 2026-09-15
type: runbook
status: maintained
---

# Repeatable GCS release adapter tests

This is the synthetic release-object qualification lane. The hosted contribution
API still uses D1 and R2. GCS quarantine erasure and a deployed GCP runtime are
not qualified. Use the Worker README for normal development commands.

## Resource plan

Run from `apps/worker`:

```sh
npm run gcs:test:assets:plan -- --project tibotattle \
  --bucket tibotattle-gcs-test-release-20260915-a7c92f \
  --region us-east1 \
  --service-account gcs-adapter-test@tibotattle.iam.gserviceaccount.com
```

This prints a JSON plan without authenticating, invoking gcloud, or changing
resources. The named resources already exist; compare the read-only preflight
results with the plan's postconditions. Creation commands document reproducible
setup for an explicitly selected test target, not an update procedure for an
existing bucket. Every command specifies its project.

Preserve uniform bucket-level access, public access prevention, bucket-scoped
object permissions and the recovery policy. Use short-lived impersonation;
never create a service-account key. Capture token command stdout directly into
an owner-only temporary file, never a visible terminal or task log. Record its
actual expiry separately. Caller impersonation permission may expire and must
not be silently broadened or renewed.

## Repeatable smoke run

The smoke CLI requires `--bucket`, `--access-token-file`, `--expires-at` (Unix
seconds), and `--receipt-file`. `--run-id` is optional; omission generates a fresh
random namespace. Use `node scripts/gcs-live-smoke.mjs --help` for the interface.
The credential must be a regular owner-only 0600 file, without symlinks or extra
hard links. Each run writes only beneath `gcs-test/runs/<run-id>/`.

The CLI starts its own loopback Worker with isolated local D1 state and synthetic
signing material. It checks signed publication, nonce replay refusal, exact-byte
read-back, conditional replacement and a concurrent create race. A run receipt
records attempted keys before writes and observed generations after success.
Keep receipts outside the repository; they contain no credentials. The CLI stops
its own processes and removes temporary local credentials on completion.

For manual local development, copy `gcs-test/.dev.vars.example` into an ignored
owner-only `.dev.vars` and fill every required value, including `GCS_TEST_RUN_ID`.
Then use `gcs:test:db:local` and `gcs:test:dev`. The local host can still write to
real GCS: use only the approved test bucket and synthetic data.

## Review cleanup separately

`node scripts/gcs-live-cleanup.mjs --help` describes the cleanup command.
Supply the exact bucket, run prefix and successful smoke receipt. The default is
an offline dry run listing exact keys and generations. It never lists or deletes
an entire prefix or bucket. Failed, interrupted or uncertain receipts require
read-back and reconciliation; they must not be promoted to successful receipts.

An explicitly authorized `--execute` uses generation preconditions and stops on
an uncertain result. Review the targets first. A replaced generation must never
cause a newer object to be deleted. Existing objects from the original test
receipt are outside this run namespace and are not cleanup targets here.

Deletion requests are not proof of physical erasure: soft-deleted or retained
versions can remain. This tooling does not qualify contribution erasure.

## Local validation and remaining gates

`gcs:test:smoke:check` and `gcs:test:assets:check` run offline CLI safety tests.
`test:portable` covers GCS permission errors, deadlines, conditional writes and
lost-response recovery with synthetic transports. In an uncertain publication,
keep the consumed nonce, read the exact current generation and bytes, then
reconcile before signing any new attempt. Never blindly replay the old request.

The [first live test receipt](../reviews/2026-09-15-gcs-test-assets.md) records
actual GCS behavior for the earlier fixed namespace. The
[repeatability receipt](../reviews/2026-09-15-gcs-repeatability-and-recovery.md)
records two successful isolated runs and cleanup dry runs. These do not prove a GCP-hosted application, PostgreSQL parity, production
migration, or permanent deletion.
