-- analytics_v2 saved owner sets and member contributions (E-OWNERSET).
--
-- Design: engine v2 section 6.1-6.3 (design/engine-v2-design-2026-10-02.md in
-- the parity home). Owner decisions: round 2 "keep past contributions" (an
-- owner who disconnects or opts out keeps its past contributions in
-- recomputed history; recomputes use each published day's saved owner set),
-- round 7 "pre-switch owner sets: A, the participants at cutover" and "purge
-- versus kept contributions: delete and republish", round 13 (built before
-- cutover on the full-recompute engine).
--
-- NUMBER. Staged as a placeholder (0931) for the integrator, who assigns the
-- next free primary number at the merge; specs and the rehearsal find the
-- file by its name suffix. It is purely additive (three tables, their
-- functions and triggers, one index), so it needs no CONTRACT_MIGRATIONS
-- entry. It needs the run stamps (analytics_v2_kernels, primary 0069).
--
-- What the tables hold:
--   analytics_v2_daily_owner_sets      S(d): the owners a published day d
--                                       folds, fixed by the publication that
--                                       first added each one (first_revision)
--                                       and only ever growing;
--   analytics_v2_daily_contributions    each member's folded daily values
--                                       for d, versioned: a new version is
--                                       appended only when a publication
--                                       folds different values or devices
--                                       for the member; the highest version
--                                       is the current one;
--   analytics_v2_daily_owner_set_bootstrap
--                                       one content-free receipt per day
--                                       whose set has been recorded: how and
--                                       at which revision it began, its size,
--                                       and, inside the frozen Cloudflare
--                                       window (C-IPR), the frozen export's
--                                       contributingParticipants and window.
--                                       A day without a receipt has no
--                                       recorded set.
-- The refresh store (src/analytics-v2/store-owner-sets.ts) is the only
-- writer, inside the run's one write transaction, with the published head.
--
-- Provenance (owner decision round 7, which replaces the design's archival
-- reconstruction). A day's receipt records how its set began, and the
-- members recorded with it take the same value; a member added to a day
-- whose set already exists takes 1:
-- 1 = recorded at GCP's first publication of a day outside the frozen window;
-- 2 = the participants at GCP's first publication of a frozen-window day,
--     whose count equals the frozen export's contributingParticipants for it;
-- 3 = the same, when the count differs or Cloudflare did not publish the day
--     (disclosed; the receipt names the day and both counts);
-- 4 = adopted: the day already had a published head when its set was first
--     recorded (a head an image without saved owner sets published, on a
--     database that held heads before this migration). The set is the one
--     the recording run folded, at the head's revision when its content was
--     unchanged; owners that left before that run are not in it, and the
--     frozen counts are not compared (engine v2 design section 6.3, last
--     bullet: such heads are "unrecorded" until a run records them).
-- A 2 or 3 receipt keeps the frozen export's digest and window, so a later
-- run knows the window when it can no longer read the export: it then
-- refuses a first recording inside the window rather than record it as 1.
--
-- Privacy: identity columns hold opaque 64-hex owner digests only. The
-- daily values are the d43c8f92 v1.1 daily projection values the community
-- fold reads, the same content-free class as analytics_v2_owner_day.daily:
-- counts, token sums, price figures and model and provider tokens.
--
-- Append-only. UPDATE and TRUNCATE are always refused. DELETE of a set or
-- contribution row is refused unless the transaction names that row's owner
-- in tibotattle.analytics_v2_offline_purge (SET LOCAL), which only the
-- offline owner purge does (owner decision round 7: the purge deletes an
-- erased owner's saved contributions and set rows, and the affected days are
-- republished over the smaller set). The receipt is never deleted, so a
-- purged day keeps the record of how its set began.
-- Both owner-scoped tables are listed in contract.ts
-- ANALYTICS_V2_OWNER_SCOPED_TABLES, the offline purge's analytics_v2
-- inventory, contributions before sets. The runtime role holds DELETE on
-- every table, so the trigger is the barrier: the online-erasure absence
-- gate (scripts/online-erasure-absence.check.mjs) fails when any running
-- service module names the purge setting or deletes from these three tables.
--
-- Every row records the kernel and manifest of the run that wrote it, and a
-- contribution also the kernel that priced its values (price_kernel_id).
-- price_basis_id and evidence_fp stay NULL until K-PERCARD (price bases) and
-- the memo (Tier-2 day fingerprints) record them: unknown, never inferred.
--
-- Grants: none, consistent with every other primary migration. The migrate
-- job grants the runtime role its table privileges; the triggers below, not
-- the grants, make the rows append-only.

CREATE TABLE analytics_v2_daily_owner_sets (
  day date NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  first_revision integer NOT NULL CHECK (first_revision >= 1),
  provenance smallint NOT NULL CHECK (provenance IN (1, 2, 3, 4)),
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  PRIMARY KEY (day, owner_digest)
);
-- The offline purge finds an owner's rows by owner.
CREATE INDEX analytics_v2_daily_owner_sets_owner
  ON analytics_v2_daily_owner_sets(owner_digest);

CREATE TABLE analytics_v2_daily_contributions (
  day date NOT NULL,
  owner_digest text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- The Tier-2 day fingerprint F(o,d) of the evidence folded, when known.
  evidence_fp char(64) CHECK (evidence_fp ~ '^[0-9a-f]{64}$'),
  daily_values jsonb NOT NULL CHECK (jsonb_typeof(daily_values) = 'object'),
  values_schema text NOT NULL
    CHECK (length(values_schema) BETWEEN 1 AND 64 AND values_schema ~ '^[A-Za-z0-9._:-]+$'),
  -- sha256 of the canonical values; the stable digest leaves out the price
  -- identity (registrySha256, pricingMethodVersion), as stable_sha256 will
  -- for a published head (K-REPRICE).
  values_sha256 char(64) NOT NULL CHECK (values_sha256 ~ '^[0-9a-f]{64}$'),
  stable_values_sha256 char(64) NOT NULL CHECK (stable_values_sha256 ~ '^[0-9a-f]{64}$'),
  devices integer NOT NULL CHECK (devices >= 1),
  price_basis_id integer CHECK (price_basis_id >= 1),
  price_kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  first_revision integer NOT NULL CHECK (first_revision >= 1),
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  PRIMARY KEY (day, owner_digest, version),
  FOREIGN KEY (day, owner_digest) REFERENCES analytics_v2_daily_owner_sets(day, owner_digest),
  -- The same bound as one published payload (0059).
  CHECK (octet_length(daily_values::text) <= 262144),
  CHECK (COALESCE(daily_values ->> 'schemaVersion' = values_schema, false))
);

CREATE TABLE analytics_v2_daily_owner_set_bootstrap (
  day date PRIMARY KEY,
  provenance smallint NOT NULL CHECK (provenance IN (1, 2, 3, 4)),
  set_size integer NOT NULL CHECK (set_size >= 0),
  -- 2 and 3 only (NULL otherwise): the frozen export the set was compared
  -- with, its window, and its contributingParticipants for the day (NULL
  -- when the export carries no publication of the day).
  frozen_participants integer CHECK (frozen_participants >= 0),
  frozen_export_sha256 char(64) CHECK (frozen_export_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_from_day date,
  frozen_through_day date,
  first_revision integer NOT NULL CHECK (first_revision >= 1),
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  CHECK ((provenance IN (2, 3)) = (frozen_export_sha256 IS NOT NULL)),
  CHECK ((frozen_export_sha256 IS NULL) = (frozen_from_day IS NULL)
     AND (frozen_export_sha256 IS NULL) = (frozen_through_day IS NULL)),
  CHECK (frozen_from_day IS NULL OR (frozen_from_day <= day AND day <= frozen_through_day)),
  CHECK (provenance IN (2, 3) OR frozen_participants IS NULL),
  -- Verified (2) exactly when the counts agree.
  CHECK ((provenance = 2) = (frozen_participants IS NOT NULL AND frozen_participants = set_size))
);

-- Set rows and contributions: no update, no truncate, and a delete only for
-- the owner the offline purge names in this transaction.
CREATE FUNCTION analytics_v2_owner_sets_append_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE'
      AND current_setting('tibotattle.analytics_v2_offline_purge', true) = OLD.owner_digest THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'analytics_v2_owner_sets_append_only' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_daily_owner_sets_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_daily_owner_sets
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_sets_append_only();
CREATE TRIGGER analytics_v2_daily_contributions_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_daily_contributions
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_sets_append_only();

CREATE FUNCTION analytics_v2_owner_sets_no_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_owner_sets_append_only' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_daily_owner_sets_no_truncate
BEFORE TRUNCATE ON analytics_v2_daily_owner_sets
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_owner_sets_no_truncate();
CREATE TRIGGER analytics_v2_daily_contributions_no_truncate
BEFORE TRUNCATE ON analytics_v2_daily_contributions
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_owner_sets_no_truncate();

-- The bootstrap receipt is immutable.
CREATE FUNCTION analytics_v2_owner_set_bootstrap_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_owner_set_bootstrap_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_daily_owner_set_bootstrap_immutable
BEFORE UPDATE OR DELETE ON analytics_v2_daily_owner_set_bootstrap
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_set_bootstrap_immutable();
CREATE TRIGGER analytics_v2_daily_owner_set_bootstrap_no_truncate
BEFORE TRUNCATE ON analytics_v2_daily_owner_set_bootstrap
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_owner_set_bootstrap_immutable();

-- Versions are contiguous and each is a later publication: version n + 1
-- follows the member's current version n and was first published at a
-- higher revision. A member's first version is version 1.
CREATE FUNCTION analytics_v2_daily_contributions_next_version()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  current_version integer;
  current_revision integer;
BEGIN
  SELECT version, first_revision INTO current_version, current_revision
    FROM analytics_v2_daily_contributions
   WHERE day = NEW.day AND owner_digest = NEW.owner_digest
   ORDER BY version DESC LIMIT 1;
  IF NEW.version <> COALESCE(current_version, 0) + 1
      OR (current_revision IS NOT NULL AND NEW.first_revision <= current_revision) THEN
    RAISE EXCEPTION 'analytics_v2_daily_contributions_version_order' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_daily_contributions_next_version
BEFORE INSERT ON analytics_v2_daily_contributions
FOR EACH ROW EXECUTE FUNCTION analytics_v2_daily_contributions_next_version();

-- A member always has a contribution, and its day a receipt: checked at
-- commit, so a set row, its first contribution and (for a day's first
-- recording) the day's receipt are written together, and a purge that
-- removes a member's contributions removes its set row too.
CREATE FUNCTION analytics_v2_owner_set_member_contributed()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  checked_day date;
  checked_owner text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_day := OLD.day;
    checked_owner := OLD.owner_digest;
  ELSE
    checked_day := NEW.day;
    checked_owner := NEW.owner_digest;
  END IF;
  IF EXISTS (SELECT 1 FROM analytics_v2_daily_owner_sets
              WHERE day = checked_day AND owner_digest = checked_owner)
     AND NOT EXISTS (SELECT 1 FROM analytics_v2_daily_contributions
                      WHERE day = checked_day AND owner_digest = checked_owner) THEN
    RAISE EXCEPTION 'analytics_v2_owner_set_member_without_contribution' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'INSERT'
     AND NOT EXISTS (SELECT 1 FROM analytics_v2_daily_owner_set_bootstrap WHERE day = checked_day) THEN
    RAISE EXCEPTION 'analytics_v2_owner_set_member_without_receipt' USING ERRCODE = 'P1005';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER analytics_v2_daily_owner_sets_contributed
AFTER INSERT ON analytics_v2_daily_owner_sets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_set_member_contributed();
CREATE CONSTRAINT TRIGGER analytics_v2_daily_contributions_contributed
AFTER DELETE ON analytics_v2_daily_contributions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_set_member_contributed();
