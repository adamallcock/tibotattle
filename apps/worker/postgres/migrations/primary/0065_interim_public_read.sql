-- community_daily_frozen_export: the interim frozen public read (OD-10, C-IPR).
--
-- Between the edge switch and the first GCP publication, GET
-- /api/v1/community/daily answers from ONE frozen copy of the Cloudflare
-- production response, captured read-only just before the seal. This table holds that
-- copy and nothing else. src/analytics-v2/interim-public-read.ts owns the
-- export format and its closed validation, scripts/gcp-interim-public-read-load.mjs
-- is the only writer, and src/analytics-v2/community-daily-route.ts serves it.
--
-- NUMBER. Primary 0065, assigned by the integrator at the C-SIMP-RECON merge
-- (2026-10-02), right after the append-only residue (0064). Until then it was
-- staged as staged-migrations/primary/0065_interim_public_read.sql. The
-- migration is purely additive (one table, one function, one trigger), so it
-- needs no CONTRACT_MIGRATIONS entry.
--
-- One row, written once. The row records:
--   payload_text    the exact bytes of the export (the response body of
--                   GET /api/v1/community/daily?from=<to-365 days>&to=<seal day>
--                   on the production Worker), stored as text so the digest
--                   below is checkable in the database itself;
--   payload_sha256  sha256 of those bytes, pinned by the owner at the seal and
--                   re-computed by the CHECK below on every insert;
--   captured_at     when the export was taken;
--   source_commit   the production source commit that served it (/api/health);
--   evidence_date   the UTC day the frozen window ends on, labelled to readers;
--   loaded_at       when the loader wrote the row.
--
-- The row is content-free public data: every string in the export is a
-- calendar day, an instant, a digest or a closed token (the loader refuses
-- anything else, and the route re-validates on every read). It carries no
-- participant, device, owner digest or session content.
--
-- Immutable. A loaded copy is never updated or deleted; the way it stops being
-- served is the first GCP publication (any analytics_v2_published_daily row,
-- which is itself never deleted), after which the route never reads it again.
-- Reloading the identical export is a no-op in the loader; a different export
-- is refused there and by the primary key here.
--
-- RETENTION IS NOT SETTLED. The owner's answer sets 90 days, then delete, for
-- "sealed and frozen copies", and this row is a frozen copy if that answer
-- covers it; nothing decides that. Until the owner or the integrator does, the
-- row stays. If it is covered, the retirement is a later migration that drops
-- the table and its function: the route already answers as "no export" when
-- the table is absent (to_regclass), and DROP is a contract operation, so that
-- migration needs its own CONTRACT_MIGRATIONS entry. See the receipt
-- docs/receipts/2026-10-02-gcp-c-ipr.md, "Retention of the frozen copy".
--
-- Grants: none, consistent with every other primary migration. The migrate job
-- grants the runtime role its table privileges; the trigger below, not the
-- grant, makes the row immutable.

CREATE TABLE community_daily_frozen_export (
  id smallint PRIMARY KEY CHECK (id = 1),
  payload_text text NOT NULL,
  payload_sha256 text NOT NULL,
  captured_at timestamptz NOT NULL,
  source_commit text NOT NULL,
  evidence_date date NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The loader and the route cap the export at 8 MiB.
  CHECK (octet_length(payload_text) BETWEEN 2 AND 8388608),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  -- The pinned digest is the digest of the stored bytes, enforced here.
  CHECK (payload_sha256 = encode(sha256(convert_to(payload_text, 'UTF8')), 'hex')),
  CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  -- The export is taken at the seal (just before it): on the evidence date or the day after.
  CHECK (evidence_date <= (captured_at AT TIME ZONE 'UTC')::date
    AND (captured_at AT TIME ZONE 'UTC')::date - evidence_date <= 1),
  -- COALESCE: a missing schemaVersion fails the check instead of passing as NULL.
  CHECK (COALESCE(
    jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb ->> 'schemaVersion' = 'community-daily-read-v1.0',
    false))
);

CREATE FUNCTION community_daily_frozen_export_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_daily_frozen_export_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER community_daily_frozen_export_immutable
BEFORE UPDATE OR DELETE ON community_daily_frozen_export
FOR EACH ROW EXECUTE FUNCTION community_daily_frozen_export_immutable();
