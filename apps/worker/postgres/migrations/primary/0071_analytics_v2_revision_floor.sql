-- analytics_v2 revision floor: Cloudflare's last published community daily
-- revision per day, so GCP publications continue above it (REV-SEED, owner
-- decisions round 12 "SEED revisions" and round 14).
--
-- NUMBER. Primary 0071, assigned by the integrator at the REV-SEED merge into
-- the fast-path final line (2026-10-03), right after KM-CORE's catalog
-- manifest store (0070). Until then it was staged under the placeholder
-- staged-migrations/primary/0951_analytics_v2_revision_floor.sql; specs and
-- checks find it by its name suffix. Purely additive (two tables, three
-- functions, five triggers; no grants, no DROP): no CONTRACT_MIGRATIONS entry.
--
-- WHY. Cloudflare's analytics D1 published community days at revisions
-- r1..rN (analytics_community_daily_heads). The interim frozen public read
-- (0065) serves those revisions verbatim until the first GCP publication.
-- Without a floor the first GCP refresh would publish every day at r1 again,
-- reusing the identifier community-daily:<day>:r1 for different content.
-- With it, revision = max(head, floor, seed) + 1 (store-publication.ts
-- nextPublishedRevision), so a day Cloudflare published at rN continues at
-- rN+1 and a day Cloudflare never published starts at r1 (round 14: a
-- per-day floor, the current analytics D1 lineage only).
--
-- WRITER. Only the PT-8-lite import's 'analytics-community-history' stage
-- (scripts/postgres-production-transfer.mjs, through
-- scripts/cutover-revision-floor.mjs loadRevisionFloorInTransaction) writes
-- these tables, once, before markLive. The dress rehearsal loads a synthetic
-- floor through the same loader (round 14).
--
-- analytics_v2_revision_floor_source: the singleton provenance of the floor.
--   provenance                 'captured' (the owner's read-only, bookmark-
--                              bracketed SELECT on the production analytics
--                              D1 after the EP-8 fence) or 'synthetic' (the
--                              dress rehearsal);
--   seal_id                    the PT-2-lite seal the import ran from;
--   floor_sha256               sha256 of the owner-pinned floor file;
--   fence_receipt_sha256       the EP-8 fence receipt the seal pinned;
--   analytics_bookmark_sha256  sha256 of the analytics D1 bookmark both sides
--                              of the capture read (NULL only when synthetic);
--   source_commit              the production source commit at the seal;
--   captured_at                when the floor was captured (or generated);
--   day_count, max_revision    the floor's size and its largest revision,
--                              checked against the day rows on insert.
-- analytics_v2_revision_floor: one row per day Cloudflare ever published.
--
-- Content-free: calendar days, integers, digests and a commit.
--
-- Immutable, and only before the first publication. Nothing updates,
-- deletes or truncates either table. The day rows are inserted first and
-- the singleton last, in one transaction; the singleton's insert checks the
-- day rows it summarizes, and once it exists no day row can be added. No row
-- of either table can be inserted once any analytics_v2_published_daily row
-- exists (the insert takes a SHARE lock on that table first, so a concurrent
-- publication either commits before the check sees it or waits for the floor
-- to commit and then meets the trigger below).
--
-- A SEPARATE trigger on analytics_v2_published_daily refuses any insert or
-- update whose revision is at or below the day's floor. It is separate from
-- 0059's forward-only trigger so that a later replacement of that trigger
-- (K-REPRICE's trigger v2) cannot drop it.

CREATE TABLE analytics_v2_revision_floor (
  day date PRIMARY KEY,
  -- 2,000,000,000 is ANALYTICS_V2_MAX_REVISION_SEED (store-run.ts).
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2000000000)
);

CREATE TABLE analytics_v2_revision_floor_source (
  id smallint PRIMARY KEY CHECK (id = 1),
  provenance text NOT NULL CHECK (provenance IN ('captured', 'synthetic')),
  seal_id char(64) NOT NULL CHECK (seal_id ~ '^[0-9a-f]{64}$'),
  floor_sha256 char(64) NOT NULL CHECK (floor_sha256 ~ '^[0-9a-f]{64}$'),
  fence_receipt_sha256 char(64) NOT NULL CHECK (fence_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  analytics_bookmark_sha256 char(64) CHECK (analytics_bookmark_sha256 ~ '^[0-9a-f]{64}$'),
  source_commit char(40) NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  captured_at timestamptz NOT NULL,
  day_count integer NOT NULL CHECK (day_count BETWEEN 1 AND 4000),
  max_revision integer NOT NULL CHECK (max_revision BETWEEN 1 AND 2000000000),
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((provenance = 'captured') = (analytics_bookmark_sha256 IS NOT NULL))
);

CREATE FUNCTION analytics_v2_revision_floor_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_revision_floor_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_revision_floor_immutable
BEFORE UPDATE OR DELETE ON analytics_v2_revision_floor
FOR EACH ROW EXECUTE FUNCTION analytics_v2_revision_floor_immutable();
CREATE TRIGGER analytics_v2_revision_floor_no_truncate
BEFORE TRUNCATE ON analytics_v2_revision_floor
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_revision_floor_immutable();
CREATE TRIGGER analytics_v2_revision_floor_source_immutable
BEFORE UPDATE OR DELETE ON analytics_v2_revision_floor_source
FOR EACH ROW EXECUTE FUNCTION analytics_v2_revision_floor_immutable();
CREATE TRIGGER analytics_v2_revision_floor_source_no_truncate
BEFORE TRUNCATE ON analytics_v2_revision_floor_source
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_revision_floor_immutable();

-- Before any publication only; day rows before the singleton; the singleton
-- summarizes exactly the day rows.
CREATE FUNCTION analytics_v2_revision_floor_insert_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  days integer;
  largest integer;
BEGIN
  LOCK TABLE analytics_v2_published_daily IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM analytics_v2_published_daily) THEN
    RAISE EXCEPTION 'analytics_v2_revision_floor_after_publication' USING ERRCODE = 'P1005';
  END IF;
  IF TG_TABLE_NAME = 'analytics_v2_revision_floor' THEN
    IF EXISTS (SELECT 1 FROM analytics_v2_revision_floor_source) THEN
      RAISE EXCEPTION 'analytics_v2_revision_floor_sealed' USING ERRCODE = 'P1005';
    END IF;
  ELSE
    SELECT count(*)::integer, max(revision) INTO days, largest FROM analytics_v2_revision_floor;
    IF days IS DISTINCT FROM NEW.day_count OR largest IS DISTINCT FROM NEW.max_revision THEN
      RAISE EXCEPTION 'analytics_v2_revision_floor_summary_mismatch' USING ERRCODE = 'P1005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_revision_floor_insert_guard
BEFORE INSERT ON analytics_v2_revision_floor
FOR EACH ROW EXECUTE FUNCTION analytics_v2_revision_floor_insert_guard();
CREATE TRIGGER analytics_v2_revision_floor_source_insert_guard
BEFORE INSERT ON analytics_v2_revision_floor_source
FOR EACH ROW EXECUTE FUNCTION analytics_v2_revision_floor_insert_guard();

-- A published head never sits at or below its day's floor.
CREATE FUNCTION analytics_v2_published_daily_above_floor()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM analytics_v2_revision_floor f
              WHERE f.day = NEW.day AND f.revision >= NEW.revision) THEN
    RAISE EXCEPTION 'analytics_v2_published_daily_below_floor' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_published_daily_above_floor
BEFORE INSERT OR UPDATE ON analytics_v2_published_daily
FOR EACH ROW EXECUTE FUNCTION analytics_v2_published_daily_above_floor();
