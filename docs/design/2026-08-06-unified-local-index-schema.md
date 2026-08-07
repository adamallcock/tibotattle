---
title: Unified Local Index Schema
date: 2026-08-06
type: design
status: agreed
---

# Unified Local Index Schema

## Why

The product materializes the same source three times: the collector state
(1.7 GB), the analysis index (158 MB), and a transient export scan that runs
again whenever a contribution is prepared. Indexing and preparing are therefore
two passes over the same 42 GiB of Codex rollout logs, and the two passes can
disagree — which is how 309,946 usage records came to carry `model: "unknown"`
in the collector while the analysis index resolved every one of them.

Owner decision: there is one index, it holds everything required to upload, and
what the dashboard shows is what a contribution sends.

## What is wrong with the current record

Measured over a random sample of 3,000 of the 662,454 stored
`codex_rollout_usage_snapshot` records.

Mean stored size **1,529 bytes**; **1,250 bytes** if merely minified, so 18% is
pretty-printing whitespace (~280 MB across the corpus).

| field | bytes/record | distinct in 3,000 |
| --- | ---: | ---: |
| `tierSemantics` | 239 | 971 |
| `windows` | 159 | 607 |
| `components` | 155 | 2,825 |
| `surfaceClassification` | 150 | **6** |
| `accountScope` | 128 | **1** |
| `eventKey` | 78 | 3,000 |
| `accountScopeAttribution` | 72 | **1** |
| `observedAt` | 40 | 2,848 |
| `receivedAt` | 40 | **13** |
| `kind` | 38 | **1** |
| `source` | 31 | **1** |
| `controlledState` | 28 | **1** |
| `provider` | 26 | **1** |
| `stalenessMs` | 24 | 2,848 |
| `schemaVersion` | 22 | **1** |
| `model` | 19 | **4** |

Seven fields are byte-identical on every one of 662,454 rows — 345 B/record,
roughly **228 MB of repeated constant text**. `surfaceClassification` spends
150 B/record encoding one of six values. Times are stored inconsistently:
`observedAt` is a 28-character ISO string while `windows[].resetsAt` is already
an epoch integer. `kind` is stored both as a column and inside the payload.
`stalenessMs` is `receivedAt - observedAt`.

## Agreed decisions

1. **`totalInputContextTokens` is stored as the provider reported it, nullable.**
   It is not the sum of the input components and it selects the pricing context
   band at 272,000 tokens. A band must never be chosen from a number the product
   computed itself, and `NULL` must stay distinguishable from a real total.
2. **The stored session key is the raw Codex session UUID.** Revised
   2026-08-07: an earlier draft stored `HMAC(device_salt, session_id)`, which
   was wrong twice over. It costs 9.77 s to hash 1.06M rows at 9.22 us each -
   more than the entire sub-5-second index budget - and an irreversible hash
   cannot be turned back into `rollout-<timestamp>-<uuid>.jsonl`, destroying
   the path derivation below. The UUID is not content, it identifies no
   person, and it already sits in a filename on the same disk, so storing it
   locally adds no exposure. The upload pseudonym stays
   `HMAC(export_secret, session_id)`, computed at send time over the <=200
   records of one contribution: 1.84 ms measured. Rotating the export secret
   still costs nothing, which matters because two secrets have already been
   retired on this machine.
3. **Quota state moves to its own `quota_observation` table**, referenced by an
   integer FK from each usage event. The exact event-to-quota pairing that the
   calibration depends on is preserved, and the state is deduplicated because
   quota is re-observed every few minutes while turns fire continuously.
4. **Every row is stamped with the parser/contract version that produced it.**
   A parser change re-scans only the affected rows' source files; rows whose
   rollout files have rotated away keep their last-good values and are visibly
   marked as older-parser output. This is what makes "all history is priced, we
   go back as far as we can" survivable across parser changes.

Consequent decisions, following from the above rather than separately chosen:
`stalenessMs` and `accountScopeAttribution` are dropped as derivable, `kind`
is dropped from the payload, `receivedAt` is normalized into `ingest_run`, and
the four nested `schemaVersion` strings become one version per table.

## Schema

```sql
-- Dimensions. Small, deduplicated, joined by integer id.
CREATE TABLE parser_version(
  id INTEGER PRIMARY KEY,
  parser_version TEXT NOT NULL,      -- provider adapter source-format version
  contract_version TEXT NOT NULL,    -- telemetry contract version
  UNIQUE(parser_version, contract_version));

CREATE TABLE ingest_run(
  id INTEGER PRIMARY KEY,
  received_at_ms INTEGER NOT NULL,
  parser_version_id INTEGER NOT NULL REFERENCES parser_version);

-- One row per Codex session. Revised 2026-08-07: the session identifier was
-- going to live on every usage_event, which was wrong in both directions. As
-- a raw 36-char UUID it cost ~61 MB across 1,934,526 events; as a per-event
-- HMAC it cost 17.8 s of hashing on a full-history upload, since the owner
-- intends bulk incremental contribution rather than a 200-record sample. A
-- pseudonym is a property of a session, not of an event: 3,709 sessions cost
-- 34 ms to hash once, and usage_event carries a 4-byte foreign key instead of
-- 36 bytes of text. Cheaper than storing the raw UUID per row, and the upload
-- reads a value that is already computed.
CREATE TABLE session(
  id INTEGER PRIMARY KEY,
  session_uuid TEXT NOT NULL UNIQUE,  -- raw; derives the rollout filename
  upload_pseudonym BLOB NOT NULL,     -- HMAC(device_salt, session_uuid)
  archived INTEGER NOT NULL);         -- hint only; corrected on a miss

CREATE TABLE model(
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE,
  recognition TEXT NOT NULL);        -- recognized | unrecognized | missing

CREATE TABLE tier_semantics(
  id INTEGER PRIMARY KEY,
  api_service_tier TEXT NOT NULL,
  billing_surface TEXT NOT NULL,
  codex_speed_mode TEXT NOT NULL,
  tier_source TEXT NOT NULL,
  provider_tier_raw TEXT,
  UNIQUE(api_service_tier, billing_surface, codex_speed_mode,
         tier_source, provider_tier_raw));

CREATE TABLE surface_class(
  id INTEGER PRIMARY KEY,
  agent_scope TEXT NOT NULL,
  surface TEXT NOT NULL,
  thread_source TEXT NOT NULL,
  lineage_disposition TEXT NOT NULL,
  UNIQUE(agent_scope, surface, thread_source, lineage_disposition));

CREATE TABLE account_scope(
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  plan_type TEXT,
  scope_local BLOB,                  -- local form; pseudonymized at upload
  UNIQUE(status, reason, plan_type, scope_local));

-- Quota observations as their own series, referenced by usage events.
CREATE TABLE quota_observation(
  id INTEGER PRIMARY KEY,
  observed_at_ms INTEGER NOT NULL,
  limit_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  plan_type TEXT,
  used_percent REAL,
  resets_at_ms INTEGER,
  duration_mins INTEGER,
  UNIQUE(observed_at_ms, limit_id, slot));

-- Facts. Fixed width, typed, no JSON.
CREATE TABLE usage_event(
  event_key BLOB PRIMARY KEY,        -- 32 raw bytes, was 64 hex chars
  observed_at_ms INTEGER NOT NULL,
  ingest_run_id INTEGER NOT NULL REFERENCES ingest_run,
  parser_version_id INTEGER NOT NULL REFERENCES parser_version,
  session_pk INTEGER NOT NULL REFERENCES session,
  account_scope_id INTEGER NOT NULL REFERENCES account_scope,
  model_id INTEGER NOT NULL REFERENCES model,
  tier_id INTEGER NOT NULL REFERENCES tier_semantics,
  surface_id INTEGER NOT NULL REFERENCES surface_class,
  quota_observation_id INTEGER REFERENCES quota_observation,
  reasoning_effort INTEGER NOT NULL, -- enum ordinal, 9 values
  outcome INTEGER NOT NULL,          -- enum ordinal, 6 values
  -- Token counts. Integers only. No prompt, reply, reasoning or file content
  -- is read, parsed or stored anywhere in this schema.
  tokens_in_uncached INTEGER,
  tokens_in_cache_read INTEGER,
  tokens_in_cache_write INTEGER,
  tokens_in_cache_write_5m INTEGER,
  tokens_in_cache_write_1h INTEGER,
  tokens_out_text INTEGER,
  tokens_out_reasoning INTEGER,
  tokens_out_combined INTEGER,
  total_input_context INTEGER);      -- provider-reported, nullable

CREATE TABLE tool_class_count(
  session_pk INTEGER NOT NULL REFERENCES session,
  tool_class TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(session_pk, tool_class));

CREATE INDEX usage_event_observed ON usage_event(observed_at_ms);
CREATE INDEX usage_event_session ON usage_event(session_pk);
```

Field names are chosen so nothing reads as content. `output_text_tokens`
invited the question "are we storing the text?" — `tokens_out_text` does not.

## Expected size

| | now | proposed |
| --- | ---: | ---: |
| bytes per usage row (payload) | 1,529 | ~115 |
| bytes per usage row (incl. row overhead + 2 indexes) | ~2,300 | ~180 |
| store for 662k records (62% of corpus) | 1.7 GB | ~120 MB |
| store for ~1.06M records (whole corpus) | ~2.7 GB | ~190 MB |

Roughly a 92% reduction, with typed columns and real indexes replacing JSON
parsing on every read.

## Fields the collector must start capturing

The upload contract needs seven fields the collector does not record today, so
unification requires a full re-index (accepted by the owner):

- `reasoningEffort`, `outcome`, `totalInputContextTokens`, `modelRecognition`
- `inputCacheWrite5mTokens`, `inputCacheWrite1hTokens`, `outputCombinedTokens`

The two cache-write TTL fields matter for pricing: a missing cache-write TTL
split is one of the failure modes the pricing tests deliberately pin.

## What must not regress

- No prompt, reply, reasoning or file content is ever read or stored. Only
  `turn_context`, `token_count` and `thread_settings_applied` records are parsed.
- `session_id` and `scope_local` never leave the Mac in raw form. The values
  sent are always `HMAC(export_secret, ...)`, computed at send time.

## Resolving a rollout file without storing its path

A rollout path is not stored. The date directory derives from the event
timestamp and the filename from the session UUID, so the only thing that is not
derivable is which of the two roots holds the file: `~/.codex/sessions/` and
`~/.codex/archived_sessions/` both contain files from every month, and no
session appears in both (measured: 1,398 and 2,311 files, zero UUID overlap).

So `usage_event` carries a one-bit `archived` hint. It is a hint, not a fact: on
a miss the other root is checked and the record corrected. A stale hint
therefore costs one extra `stat` and can never produce a wrong answer, which
matters because Codex moves sessions between roots. Storing the absolute path
instead would go stale exactly when a session is archived.
- Memory stays bounded regardless of rollout file size.
- The export owner boundary tests remain the gate for any change here.
