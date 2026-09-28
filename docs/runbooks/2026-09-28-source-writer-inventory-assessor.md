---
title: Supplied Cloudflare source-writer inventory assessor
date: 2026-09-28
type: runbook
status: current
---

# Supplied Cloudflare source-writer inventory assessor

This local-only assessor compares a caller-supplied, normalized metadata snapshot
with a separate expected graph. It makes no Cloudflare API calls and reads no
source rows. Even an exact match is `review_required_match`; this tool is not a
production freeze, export, migration, or cutover gate.

No Cloudflare API collector is maintained for this schema. The [provider
feasibility review](../reviews/2026-09-28-cloudflare-source-writer-provider-feasibility.md)
records why the current binding and Queue variants cannot be represented
losslessly and what must change before a collector can be reviewed.

## Maintained interface

Run the Worker package command with two separate JSON files:

```text
npm --prefix apps/worker run source:writer-inventory:assess -- --snapshot <private-snapshot.json> --expected-graph <private-expected-graph.json>
```

Keep both files in a current-user-owned directory private from group/other
access and use file mode `0600`. The command checks each file is owned by the
current user, regular, single-link, has no group/other permissions, is no more
than 2 MiB, and is reached through a path without symlinks; it does not inspect
parent-directory ownership or permissions. The command prints
hashes and a review status only: exit `0` means the supplied graph matched, exit
`2` means drift, and exit `1` means invalid or unsafe input. No status means
readiness.

## Input contract

The snapshot has exactly these top-level fields:

```json
{
  "schema": "cloudflare-source-writer-snapshot-v1",
  "capturedAt": "<UTC timestamp with milliseconds>",
  "sourceProvenance": "caller-supplied-unverified",
  "workers": [],
  "queues": []
}
```

Each Worker has `name`, `activeVersions`, `bindings`, and `crons`. The active
version list must contain exactly one `{ "id": "<version UUID>",
"percentage": 100 }`; split traffic and extra zero-traffic versions refuse.
Each binding has an allowlisted `type`, `name`, `target`, and type-compatible
`role`. Allowed pairs are:

| Binding type | Role |
|---|---|
| `d1`, `r2_bucket`, `durable_object_namespace`, `kv_namespace`, `analytics_engine`, `vectorize` | `writer`, `reader`, `read-write` |
| `service`, `ai`, `dispatch_namespace` | `invoke` |
| `queue` | `produce` |
| `hyperdrive` | `connect` |
| `assets` | `read` |
| `plain_text` | `config` |
| `secret_text`, `secret_key` | `secret` |

Resource bindings require a safe string `target`; D1 targets must be UUIDs and
service targets must name a Worker in the supplied graph. Non-resource assets,
plain-text, and secret bindings require `target: null`. Unknown types, roles,
fields, or service references refuse. R2 bindings additionally require
`transferDisposition` of `transfer`, `exclude`, or `separate-review`. Crons are
exact five-field schedule strings.

Each queue has an opaque safe `id`, `name`, a 64-character `settingsDigest`,
producer `{ "worker", "binding" }` references, and consumer `{ "worker",
"settingsDigest" }` references. The supplied hashes must represent the complete
queue and consumer settings chosen for comparison. The assessor validates their
shape; it cannot establish how they were collected.

The expected-graph file has exactly `schema`, `graph`, and `graphDigest`, with
schema `cloudflare-source-writer-expected-graph-v1`. `graph` contains the same
`workers` and `queues` structures. `graphDigest` must equal the repository's
canonical `identityDigest` of the normalized graph: Worker names, binding
type/name pairs, cron strings, queues, producer pairs, and consumer names are
sorted before hashing. This self-digest detects accidental inconsistency. It
does not authenticate who supplied or reviewed the graph. Reviewers must pin
and approve the expected-graph file independently of the capture being checked;
the CLI accepts no standalone expected-digest flag.

## Evidence and limits

The result separates a capture digest (including timestamp and supplied
provenance marker) from the normalized graph digest. It never prints Worker,
binding, queue, or resource identifiers. A match means only that the two
supplied structures are equal under the schema.

The snapshot cannot prove provider origin or completeness. In particular, the
assessor cannot discover omitted Workers or queues, unknown service targets,
direct operator scripts, external API writers, or other resources absent from
the input. Binding roles and settings hashes are supplied annotations, not
provider-verified facts. A matching digest does not prove a source-wide fence,
request drain, stable cross-store snapshot, export/import reconciliation,
rollback, or cutover readiness. Those require separate implementation,
evidence, and explicit authorization.
