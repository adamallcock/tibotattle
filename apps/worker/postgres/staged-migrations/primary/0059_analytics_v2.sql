-- analytics_v2: the outputs of the analytics-refresh Cloud Run Job (A-3).
--
-- One full-recompute run reads accepted evidence from the typed source tables,
-- runs the vendored d43c8f92 analytics kernels in one process, and writes
-- every output below in ONE transaction (src/analytics-v2/store.ts). Table and
-- column names are fixed by src/analytics-v2/contract.ts; this file is the
-- only DDL for them.
--
-- Placement: primary role, runtime schema (the per-transaction search_path the
-- migration runner sets). No schema is created here.
--
-- Grants: none, consistent with every other primary migration. The migrate
-- job grants the runtime role SELECT, INSERT, UPDATE and DELETE on all tables
-- in the schema and sets matching default privileges
-- (cloud-run/test-migrations.mjs grantAndVerifyRuntimePrivileges); the
-- refresh Job and the origin share that one runtime user.
--
-- Privacy: identity columns hold opaque 64-hex owner digests only. Kernel
-- values are stored as jsonb exactly as the vendored kernels produce them;
-- fits may carry the pseudonymous participantId production's
-- CommunityAllowanceFit carries, and nothing carries a prompt, path, session
-- content, raw account identifier or credential.
--
-- Erasure is the manual offline runbook (owner decision): it deletes an
-- owner's analytics_v2 owner_* rows and never retracts published rows. Before
-- promotion, the owner_* relations must join the owner-retirement inventory
-- (FC-11(a)); see the A-3 hand-off.
--
-- Day columns are date. Readers select to_char(day, 'YYYY-MM-DD'); node-pg
-- would otherwise parse a date into a local-midnight Date object.

-- One row per completed run. A run that fails rolls back with everything else
-- and leaves no row; LOCK_HELD exits write nothing. 'failed' is reserved by
-- the contract for a future out-of-transaction failure record.
CREATE TABLE analytics_v2_runs (
  run_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('full')),
  state text NOT NULL CHECK (state IN ('complete', 'failed')),
  owners integer NOT NULL CHECK (owners >= 0),
  owner_days integer NOT NULL CHECK (owner_days >= 0),
  refusals jsonb NOT NULL CHECK (jsonb_typeof(refusals) = 'array'),
  publication jsonb NOT NULL CHECK (
    jsonb_typeof(publication) = 'object'
    AND jsonb_typeof(publication -> 'published') = 'array'
    AND jsonb_typeof(publication -> 'unchanged') = 'array'
    AND jsonb_typeof(publication -> 'blocked') = 'array'
  ),
  timings jsonb NOT NULL CHECK (jsonb_typeof(timings) = 'object'),
  CHECK (finished_at >= started_at)
);
CREATE INDEX analytics_v2_runs_recent
  ON analytics_v2_runs(finished_at DESC, started_at DESC);

-- Prepared daily values per owner-day, or the explicit refusal that replaced
-- them. Exactly one of the two is present; a refusal is never a zero.
CREATE TABLE analytics_v2_owner_day (
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  daily jsonb,
  refusal text CHECK (refusal IN (
    'non_effective_source_unported', 'usage_window_unrepresentable',
    'day_occurrences_exceeded', 'source_conflict_or_order',
    'invalid_day', 'invalid_owner', 'day_row_limit', 'day_byte_limit',
    'quota_day_unrepresentable', 'usage_day_unrepresentable',
    'cache_usage_row_refused', 'window_pin_or_capacity', 'duplicate_day',
    'incomplete_window', 'window_capacity', 'quota_window_unrepresentable',
    'usage_day_absent', 'owner_mismatch', 'incomplete_cache_day',
    'incomplete_cache_lookback'
  )),
  run_id uuid NOT NULL,
  PRIMARY KEY (owner_digest, day),
  CHECK ((daily IS NULL) <> (refusal IS NULL))
);

-- Per-owner cache continuity bands: the ten closed bands and the seven
-- integer counters of d43c8f92 analytics_cache_retention_day_bands (v3), with
-- the same scope checks and counter inequalities. A rate is computed at read
-- time, never stored rounded.
CREATE TABLE analytics_v2_cache_bands (
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 64 AND model ~ '^[A-Za-z0-9._:-]+$'),
  effort text NOT NULL CHECK (length(effort) BETWEEN 1 AND 64 AND effort ~ '^[A-Za-z0-9._:-]+$'),
  band text NOT NULL CHECK (band IN (
    'under_one_minute', 'one_to_two_minutes', 'two_to_five_minutes',
    'five_to_ten_minutes', 'ten_to_thirty_minutes', 'thirty_minutes_to_one_hour',
    'one_to_two_hours', 'two_to_six_hours', 'six_to_twenty_four_hours',
    'over_twenty_four_hours'
  )),
  adjacencies bigint NOT NULL CHECK (adjacencies >= 0),
  reused_more_than_half bigint NOT NULL CHECK (reused_more_than_half >= 0),
  matched_or_exceeded bigint NOT NULL CHECK (matched_or_exceeded >= 0),
  unordered_ties bigint NOT NULL CHECK (unordered_ties >= 0),
  excluded_insufficient_evidence bigint NOT NULL CHECK (excluded_insufficient_evidence >= 0),
  excluded_context_contracted bigint NOT NULL CHECK (excluded_context_contracted >= 0),
  sessions bigint NOT NULL CHECK (sessions >= 0),
  run_id uuid NOT NULL,
  PRIMARY KEY (owner_digest, day, model, effort, band),
  CHECK (reused_more_than_half <= adjacencies AND matched_or_exceeded <= reused_more_than_half
    AND unordered_ties <= adjacencies AND sessions <= adjacencies)
);
-- Read-time windows aggregate by day range across owners.
CREATE INDEX analytics_v2_cache_bands_day
  ON analytics_v2_cache_bands(day, band);

-- The owner's scalar fits as of one day (CommunityAllowanceFit values carry
-- only participantId, planType, capacityNanousd and lastObservedAt).
CREATE TABLE analytics_v2_owner_fits (
  owner_digest text PRIMARY KEY CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  as_of_day date NOT NULL,
  fits jsonb NOT NULL,
  run_id uuid NOT NULL
);

-- One evaluateSharedModelDate result per owner and preview date.
CREATE TABLE analytics_v2_owner_model_dates (
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  result jsonb NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (owner_digest, day)
);

-- The served head of each community day. The payload is production's
-- community-daily payload; its aggregateId, day and revision agree with the
-- row. payload_sha256 digests the payload WITHOUT its revision-bound fields
-- (aggregateId, revision, releasedAt), so an unchanged recomputation is
-- recognized and keeps its revision. A row only moves forward: a new revision
-- requires a new digest, and a published day is never deleted.
CREATE TABLE analytics_v2_published_daily (
  day date PRIMARY KEY,
  revision integer NOT NULL CHECK (revision >= 1),
  released_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  CHECK (octet_length(payload::text) <= 262144),
  -- COALESCE: a missing payload field fails the check instead of passing as NULL.
  CHECK (COALESCE(payload ->> 'day' = to_char(day, 'YYYY-MM-DD'), false)),
  CHECK (COALESCE(payload ->> 'revision' = revision::text, false)),
  CHECK (COALESCE(payload ->> 'aggregateId'
    = 'community-daily:' || to_char(day, 'YYYY-MM-DD') || ':r' || revision::text, false))
);

CREATE FUNCTION analytics_v2_published_daily_forward_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'analytics_v2_published_daily_no_delete' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.day <> OLD.day OR NEW.revision <= OLD.revision
      OR NEW.payload_sha256 = OLD.payload_sha256 THEN
    RAISE EXCEPTION 'analytics_v2_published_daily_forward_only' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_published_daily_forward_only
BEFORE UPDATE OR DELETE ON analytics_v2_published_daily
FOR EACH ROW EXECUTE FUNCTION analytics_v2_published_daily_forward_only();

-- The admin community allowance preview, or NULL when the run could not build
-- one (explicitly unavailable, never a stale preview presented as current).
CREATE TABLE analytics_v2_preview (
  id smallint PRIMARY KEY CHECK (id = 1),
  preview jsonb,
  computed_at timestamptz NOT NULL,
  run_id uuid NOT NULL
);

-- The storage_ingestion_changes sequence the last run consumed. It is absent
-- until a run reads a journal position and then only moves forward.
CREATE TABLE analytics_v2_journal_cursor (
  id smallint PRIMARY KEY CHECK (id = 1),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  run_id uuid NOT NULL
);

CREATE FUNCTION analytics_v2_journal_cursor_forward_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.last_sequence < OLD.last_sequence THEN
    RAISE EXCEPTION 'analytics_v2_journal_cursor_forward_only' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_journal_cursor_forward_only
BEFORE UPDATE OR DELETE ON analytics_v2_journal_cursor
FOR EACH ROW EXECUTE FUNCTION analytics_v2_journal_cursor_forward_only();
