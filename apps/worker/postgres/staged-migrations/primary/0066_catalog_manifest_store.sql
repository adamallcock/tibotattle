-- Catalog manifest store (KM-3, stream KM-CORE).
--
-- The server keeps every signed catalog manifest it has verified, the integer
-- vocabulary of price cards those manifests introduced, their retractions,
-- and an append-only pin log that chooses which version intake pricing and
-- analytics read. src/catalog-manifest.ts owns the manifest contract and its
-- closed validation; src/postgres-catalog-store.ts is the only writer (the
-- loader verifies the signature, the schema and append-only continuity BEFORE
-- inserting) and owns the read APIs. Until a manifest is loaded and active,
-- the read APIs serve the compiled d43c8f92 baseline, which is the cutover
-- state (owner decision round 7: compiled registry at cutover).
--
-- NUMBER. 0066 is a placeholder (the staged harness needs four digits and the
-- staged run must stay contiguous after C-IPR's 0065). The integrator assigns
-- the next free primary number when it promotes this file, after K-STAMP's
-- migration if that lands first, then regenerates src/postgres-runtime-schema.ts
-- and moves the count and tail pins. The migration is purely additive (four
-- tables, four functions, triggers), so it needs no CONTRACT_MIGRATIONS entry.
--
-- CONTENT-FREE. Every row is reviewed public configuration: versions,
-- digests, key ids, price-card ids, vocabulary tokens and the signed envelope
-- itself (vendor price evidence). No owner, participant, device or session
-- column exists, so no erasure inventory (FC-11) applies.
--
-- APPEND-ONLY. No row is ever updated or deleted, and the tables refuse
-- TRUNCATE. A bad manifest is never removed: the operator pins the previous
-- version (catalog_pin_events) and publishes a corrective successor. The
-- manifest chain is enforced here as well as in the loader: version 1 first,
-- then exactly the held version plus one, naming the held digest and never
-- activating before it. Card and retraction rows are written only under the
-- head version being loaded.

-- The payload text inside a catalog-envelope-v1 envelope (base64url, unpadded),
-- or NULL when the envelope is not a JSON object with a string payload.
CREATE FUNCTION catalog_envelope_payload_text(envelope_text text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path FROM CURRENT AS $$
  SELECT convert_from(decode(
    rpad(translate(payload, '-_', '+/'), ((length(payload) + 3) / 4) * 4, '='),
    'base64'), 'UTF8')
  FROM (SELECT CASE WHEN jsonb_typeof(envelope_text::jsonb) = 'object'
      AND jsonb_typeof(envelope_text::jsonb -> 'payload') = 'string'
    THEN envelope_text::jsonb ->> 'payload' END AS payload) AS envelope
$$;

CREATE TABLE catalog_manifests (
  version integer PRIMARY KEY,
  previous_version integer UNIQUE REFERENCES catalog_manifests (version),
  previous_digest text,
  digest text NOT NULL UNIQUE,
  key_id text NOT NULL,
  envelope_text text NOT NULL,
  published_at timestamptz NOT NULL,
  activate_at timestamptz NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (version BETWEEN 1 AND 2147483647),
  CHECK ((version = 1 AND previous_version IS NULL AND previous_digest IS NULL)
    OR (version > 1 AND previous_version = version - 1 AND previous_digest IS NOT NULL)),
  CHECK (digest ~ '^[0-9a-f]{64}$'),
  CHECK (previous_digest IS NULL OR previous_digest ~ '^[0-9a-f]{64}$'),
  CHECK (key_id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  -- src/catalog-manifest.ts CATALOG_MAX_ENVELOPE_BYTES.
  CHECK (octet_length(envelope_text) BETWEEN 2 AND 1048576),
  CHECK (activate_at >= published_at),
  -- The envelope names this key, and the digest is the digest of the payload
  -- bytes it carries. COALESCE: a malformed envelope fails instead of passing
  -- as NULL. The signature itself is verified by the loader (Ed25519 is not
  -- available in SQL); the read APIs re-verify it on every read.
  CHECK (COALESCE(
    jsonb_typeof(envelope_text::jsonb) = 'object'
      AND envelope_text::jsonb ->> 'format' = 'catalog-envelope-v1'
      AND envelope_text::jsonb ->> 'keyId' = key_id
      AND digest = encode(sha256(convert_to(catalog_envelope_payload_text(envelope_text), 'UTF8')), 'hex'),
    false)),
  -- The row's columns are the payload's own fields.
  CHECK (COALESCE(
    (catalog_envelope_payload_text(envelope_text)::jsonb ->> 'version')::integer = version
      AND (catalog_envelope_payload_text(envelope_text)::jsonb -> 'previousVersion')
        = COALESCE(to_jsonb(previous_version), 'null'::jsonb)
      AND (catalog_envelope_payload_text(envelope_text)::jsonb -> 'previousDigest')
        = COALESCE(to_jsonb(previous_digest), 'null'::jsonb)
      AND (catalog_envelope_payload_text(envelope_text)::jsonb ->> 'publishedAt')::timestamptz = published_at
      AND (catalog_envelope_payload_text(envelope_text)::jsonb ->> 'activateAt')::timestamptz = activate_at,
    false))
);

-- One integer per price card ever published, in load order. card_no is the
-- vocabulary the per-card basis (K-PERCARD) records; a card's bytes never
-- change, so its digest is fixed for life.
CREATE TABLE catalog_cards (
  card_no integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id text NOT NULL UNIQUE,
  card_digest text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  service_tier text NOT NULL,
  first_version integer NOT NULL REFERENCES catalog_manifests (version),
  CHECK (card_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  CHECK (card_digest ~ '^[0-9a-f]{64}$'),
  -- The wire grammar (catalog-token-guard-v1).
  CHECK (provider ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CHECK (model ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CHECK (service_tier ~ '^[A-Za-z0-9._:-]{1,64}$')
);

CREATE TABLE catalog_card_retractions (
  card_no integer PRIMARY KEY REFERENCES catalog_cards (card_no),
  retracted_in integer NOT NULL REFERENCES catalog_manifests (version),
  reason text NOT NULL,
  CHECK (retracted_in >= 2),
  CHECK (reason IN ('price_correction', 'withdrawn', 'superseded'))
);

-- The pin log. The current pin is the row with the highest event_no; with no
-- row the pin is latest_verified. latest_verified reads the highest loaded
-- version whose activate_at has passed; pinned reads exactly `version`
-- (rollback, staging); frozen also reads exactly `version` and makes the
-- analytics refresh refuse any other. Reasons are closed codes, never text.
CREATE TABLE catalog_pin_events (
  event_no bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL,
  version integer REFERENCES catalog_manifests (version),
  reason text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (mode IN ('latest_verified', 'pinned', 'frozen')),
  CHECK ((mode = 'latest_verified') = (version IS NULL)),
  CHECK (reason IN ('advance', 'rollback', 'staging', 'freeze', 'release'))
);

-- Chain continuity, checked again here under the loader's table lock: the
-- first manifest is version 1, and every later one is exactly the held
-- version plus one and names the held digest. A lower or equal version is a
-- regression; concurrent loaders of the same version collide on the keys.
-- Activation never moves backwards either: a successor carries all of the
-- held manifest, so an earlier activate_at would make a pending manifest's
-- content live before its own activation (latest_verified reads the highest
-- active version).
CREATE FUNCTION catalog_manifests_continuity()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  held_version integer;
  held_digest text;
  held_activate_at timestamptz;
BEGIN
  SELECT version, digest, activate_at INTO held_version, held_digest, held_activate_at
    FROM catalog_manifests ORDER BY version DESC LIMIT 1;
  IF held_version IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'catalog_manifests_version_gap' USING ERRCODE = 'P1005';
    END IF;
  ELSIF NEW.version <= held_version THEN
    RAISE EXCEPTION 'catalog_manifests_version_regression' USING ERRCODE = 'P1005';
  ELSIF NEW.version <> held_version + 1 THEN
    RAISE EXCEPTION 'catalog_manifests_version_gap' USING ERRCODE = 'P1005';
  ELSIF NEW.previous_digest IS DISTINCT FROM held_digest THEN
    RAISE EXCEPTION 'catalog_manifests_chain_mismatch' USING ERRCODE = 'P1005';
  ELSIF NEW.activate_at < held_activate_at THEN
    RAISE EXCEPTION 'catalog_manifests_activation_regression' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_manifests_continuity
BEFORE INSERT ON catalog_manifests
FOR EACH ROW EXECUTE FUNCTION catalog_manifests_continuity();

-- The derived vocabulary is written only for the manifest being loaded: a
-- card row's first_version and a retraction's retracted_in must equal the
-- held head version (the loader inserts the manifest row first, in the same
-- transaction). A row can therefore never claim an older version than the
-- one it was written under. The loader additionally checks, under its lock,
-- that both tables are exactly the projection of the re-verified head before
-- it appends, so a row written outside the loader is refused at the next load.
CREATE FUNCTION catalog_vocabulary_head_version()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  head_version integer;
  row_version integer;
BEGIN
  SELECT max(version) INTO head_version FROM catalog_manifests;
  IF TG_TABLE_NAME = 'catalog_cards' THEN
    row_version := NEW.first_version;
  ELSE
    row_version := NEW.retracted_in;
  END IF;
  IF head_version IS NULL OR row_version IS DISTINCT FROM head_version THEN
    RAISE EXCEPTION 'catalog_vocabulary_not_head_version' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_cards_head_version
BEFORE INSERT ON catalog_cards
FOR EACH ROW EXECUTE FUNCTION catalog_vocabulary_head_version();
CREATE TRIGGER catalog_card_retractions_head_version
BEFORE INSERT ON catalog_card_retractions
FOR EACH ROW EXECUTE FUNCTION catalog_vocabulary_head_version();

CREATE FUNCTION catalog_append_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'catalog_append_only' USING ERRCODE = 'P1005';
END;
$$;

CREATE TRIGGER catalog_manifests_append_only
BEFORE UPDATE OR DELETE ON catalog_manifests
FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE TRIGGER catalog_manifests_no_truncate
BEFORE TRUNCATE ON catalog_manifests
FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only();

CREATE TRIGGER catalog_cards_append_only
BEFORE UPDATE OR DELETE ON catalog_cards
FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE TRIGGER catalog_cards_no_truncate
BEFORE TRUNCATE ON catalog_cards
FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only();

CREATE TRIGGER catalog_card_retractions_append_only
BEFORE UPDATE OR DELETE ON catalog_card_retractions
FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE TRIGGER catalog_card_retractions_no_truncate
BEFORE TRUNCATE ON catalog_card_retractions
FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only();

CREATE TRIGGER catalog_pin_events_append_only
BEFORE UPDATE OR DELETE ON catalog_pin_events
FOR EACH ROW EXECUTE FUNCTION catalog_append_only();
CREATE TRIGGER catalog_pin_events_no_truncate
BEFORE TRUNCATE ON catalog_pin_events
FOR EACH STATEMENT EXECUTE FUNCTION catalog_append_only();
