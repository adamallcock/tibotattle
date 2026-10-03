-- analytics_v2 per-card price staleness (K-PERCARD, engine v2 design section
-- 5; owner decisions round 7 "memo scope" and round 13: built before the
-- cutover because it shapes stored data).
--
-- NUMBER. Staged as 0912, a placeholder; the integrator assigns the primary
-- number at promotion. Specs and checks find it by its name suffix
-- (analytics_v2_price_cards). It needs the run stamps (primary 0069): every
-- table below names analytics_v2_kernels, so on an earlier schema the first
-- CREATE TABLE fails and nothing is created.
--
-- Additive only: seven new tables, their indexes, triggers and one CHECK
-- helper. It alters no existing table and no stored row, so a previous
-- image keeps working on the migrated schema (it writes none of these
-- tables; the new image refuses to write without them).
--
-- What is stored (src/analytics-v2/store-price.ts writes it, in the refresh
-- Job's one write transaction):
--   * analytics_v2_kernel_prices: per kernel, its compute class
--     (compute_sha256: the compute closure without the vendored price
--     registry; NULL when the bundle stated none, which is never a
--     compatibility claim), the digest and count of its price cards and the
--     price-input projection version. Written by the kernel's first write.
--   * analytics_v2_price_cards: a card is (card_id, sha256 of its canonical
--     JSON); a changed card is a new card_ref. Shared by every kernel.
--   * analytics_v2_kernel_cards: which cards each kernel prices with.
--   * analytics_v2_price_bases: a deduplicated, sorted set of card refs and
--     its environment-independent digest (ids and contents).
--   * analytics_v2_owner_day_price: one row per owner-day row that has daily
--     values (same owner, day, run and kernel): its price basis, its usage,
--     unpriced and partially priced event counts, and its price inputs (each
--     usage event's projection onto exactly what the kernel's pricer reads,
--     with the result this kernel gave it; canonical JSON, deflated). It is
--     replaced with its owner-day row (the delete cascades) and is never
--     updated.
--   * analytics_v2_kernel_transitions and analytics_v2_transition_stale: a
--     run on a newer kernel records, once per older kernel still stamping
--     stored owner-days, the verdict (compatible only when the compute
--     classes are equal and the proof over the stored inputs holds) and the
--     owner-days whose prices it makes stale (cause 1 a removed or changed
--     card, 2 repriced, 3 price unknown).
--
-- Integer ids are assigned by the store (stored maximum plus a rank, under
-- the refresh lock): local surrogates, gap-free, identical for identical
-- histories. Every table but the price rows is append-only: UPDATE, DELETE
-- and TRUNCATE are refused. Owner-scoped rows (price rows, stale rows) hold
-- the opaque owner digest only, like analytics_v2_owner_day.
--
-- The stale set is price staleness only. A transition across a
-- price-registry change (analytics_v2_kernels.price_registry_sha256) also
-- leaves every daily-valued owner-day of the older kernel to restamp, since
-- its daily values carry the older registry identity; the store derives that
-- from the immutable kernel rows when it reports dirtiness, and records
-- nothing for it here.
--
-- ERASURE (owner decision D2, Variant B; round 7 "delete and republish").
-- analytics_v2_owner_day_price leaves with its owner-day rows (ON DELETE
-- CASCADE). analytics_v2_transition_stale is owner-keyed and append-only,
-- and it cannot cascade from analytics_v2_owner_day: every refresh replaces
-- the owner-day rows it recomputes, so a cascade would erase the stale set in
-- the run that records it. The offline purge (PURGE-1), connected as the
-- schema owner and inside its one purge transaction, removes an erased
-- owner's stale rows with exactly these three statements, so the row
-- trigger is disabled only inside that uncommitted transaction (ALTER TABLE
-- is transactional and holds the table lock until COMMIT; a rollback
-- restores it):
--   ALTER TABLE analytics_v2_transition_stale
--     DISABLE TRIGGER analytics_v2_transition_stale_append_only;
--   DELETE FROM analytics_v2_transition_stale WHERE owner_digest = $1;
--   ALTER TABLE analytics_v2_transition_stale
--     ENABLE TRIGGER analytics_v2_transition_stale_append_only;
-- It never uses session_replication_role (that disables every trigger,
-- foreign keys included) and never truncates. The transition rows keep their
-- content-free counts (owner_days, stale_owner_days). The runtime role holds
-- DML grants only, not ownership, so the running service cannot do this.
-- postgres-test/analytics-v2-price-cards.spec.mjs rehearses it.

CREATE TABLE analytics_v2_kernel_prices (
  kernel_id smallint PRIMARY KEY REFERENCES analytics_v2_kernels(kernel_id),
  compute_sha256 char(64) CHECK (compute_sha256 ~ '^[0-9a-f]{64}$'),
  cards_sha256 char(64) NOT NULL CHECK (cards_sha256 ~ '^[0-9a-f]{64}$'),
  cards integer NOT NULL CHECK (cards BETWEEN 1 AND 4096),
  projection_version text NOT NULL CHECK (projection_version ~ '^analytics-v2-price-input-v[1-9][0-9]{0,5}$'),
  registered_at timestamptz NOT NULL
);

CREATE TABLE analytics_v2_price_cards (
  card_ref integer PRIMARY KEY CHECK (card_ref > 0),
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 256 AND card_id ~ '^[A-Za-z0-9._:-]+$'),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  first_kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  UNIQUE (card_id, content_sha256),
  UNIQUE (card_ref, card_id)
);

CREATE TABLE analytics_v2_kernel_cards (
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernel_prices(kernel_id),
  card_ref integer NOT NULL,
  card_id text NOT NULL,
  PRIMARY KEY (kernel_id, card_ref),
  -- One content per card id per kernel.
  UNIQUE (kernel_id, card_id),
  FOREIGN KEY (card_ref, card_id) REFERENCES analytics_v2_price_cards(card_ref, card_id)
);

-- A price basis: positive card refs, ascending, unique, at most 4,096.
CREATE FUNCTION analytics_v2_card_refs_valid(card_refs integer[])
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path FROM CURRENT AS $$
  SELECT cardinality(card_refs) <= 4096
     AND (cardinality(card_refs) = 0 OR (array_ndims(card_refs) = 1 AND array_lower(card_refs, 1) = 1))
     AND card_refs = ARRAY(SELECT DISTINCT ref FROM unnest(card_refs) AS ref WHERE ref > 0 ORDER BY ref)
$$;

CREATE TABLE analytics_v2_price_bases (
  price_basis_id integer PRIMARY KEY CHECK (price_basis_id > 0),
  basis_sha256 char(64) NOT NULL UNIQUE CHECK (basis_sha256 ~ '^[0-9a-f]{64}$'),
  card_refs integer[] NOT NULL CHECK (analytics_v2_card_refs_valid(card_refs))
);

CREATE FUNCTION analytics_v2_price_bases_cards_exist()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.card_refs) AS ref
              WHERE NOT EXISTS (SELECT 1 FROM analytics_v2_price_cards c WHERE c.card_ref = ref)) THEN
    RAISE EXCEPTION 'analytics_v2_price_bases_card_unknown' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_price_bases_cards_exist
BEFORE INSERT ON analytics_v2_price_bases
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_bases_cards_exist();

CREATE TABLE analytics_v2_owner_day_price (
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  price_basis_id integer NOT NULL REFERENCES analytics_v2_price_bases(price_basis_id),
  usage_events integer NOT NULL CHECK (usage_events BETWEEN 0 AND 250000),
  unpriced_events integer NOT NULL CHECK (unpriced_events >= 0),
  partially_priced_events integer NOT NULL CHECK (partially_priced_events >= 0),
  projection_version text NOT NULL CHECK (projection_version ~ '^analytics-v2-price-input-v[1-9][0-9]{0,5}$'),
  codec text NOT NULL CHECK (codec = 'deflate-raw-canonical-json-v1'),
  inputs bytea NOT NULL CHECK (octet_length(inputs) > 0),
  inputs_sha256 char(64) NOT NULL CHECK (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  input_events integer NOT NULL,
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernel_prices(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  PRIMARY KEY (owner_digest, day),
  -- Replaced with its owner-day row: the store deletes owner-day rows and
  -- their price rows go with them.
  FOREIGN KEY (owner_digest, day) REFERENCES analytics_v2_owner_day(owner_digest, day) ON DELETE CASCADE,
  CHECK (unpriced_events + partially_priced_events <= usage_events),
  CHECK (input_events = usage_events)
);
-- The stale-owner-day search (engine v2 section 5.3) is by basis and kernel.
CREATE INDEX analytics_v2_owner_day_price_basis ON analytics_v2_owner_day_price(price_basis_id);
CREATE INDEX analytics_v2_owner_day_price_kernel ON analytics_v2_owner_day_price(kernel_id);

-- A price row belongs to an owner-day row with daily values, written by the
-- same run and kernel; it is never updated (the store replaces it).
CREATE FUNCTION analytics_v2_owner_day_price_matches_owner_day()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'analytics_v2_owner_day_price_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM analytics_v2_owner_day d
                  WHERE d.owner_digest = NEW.owner_digest AND d.day = NEW.day AND d.daily IS NOT NULL
                    AND d.run_id = NEW.run_id AND d.kernel_id = NEW.kernel_id) THEN
    RAISE EXCEPTION 'analytics_v2_owner_day_price_without_daily_values' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_owner_day_price_matches_owner_day
BEFORE INSERT OR UPDATE ON analytics_v2_owner_day_price
FOR EACH ROW EXECUTE FUNCTION analytics_v2_owner_day_price_matches_owner_day();

CREATE TABLE analytics_v2_kernel_transitions (
  transition_id integer PRIMARY KEY CHECK (transition_id > 0),
  from_kernel smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  to_kernel smallint NOT NULL REFERENCES analytics_v2_kernel_prices(kernel_id),
  compute_equal boolean NOT NULL,
  proof_holds boolean NOT NULL,
  compatible boolean NOT NULL,
  -- The card diff, NULL when the older kernel's cards were never registered.
  cards_added integer CHECK (cards_added >= 0),
  cards_removed integer CHECK (cards_removed >= 0),
  cards_changed integer CHECK (cards_changed >= 0),
  owner_days integer NOT NULL CHECK (owner_days >= 0),
  events bigint NOT NULL CHECK (events >= 0),
  stale_owner_days integer NOT NULL CHECK (stale_owner_days BETWEEN 0 AND owner_days),
  -- The run that proved it (its row is inserted later in the same transaction).
  proof_run uuid NOT NULL REFERENCES analytics_v2_runs(run_id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL,
  UNIQUE (from_kernel, to_kernel),
  CHECK (from_kernel < to_kernel),
  CHECK (compatible = (compute_equal AND proof_holds)),
  CHECK ((cards_added IS NULL) = (cards_removed IS NULL) AND (cards_added IS NULL) = (cards_changed IS NULL)),
  -- Compatibility is proven, never assumed: unknown cards are never compatible.
  CHECK (cards_added IS NOT NULL OR NOT compatible)
);

CREATE TABLE analytics_v2_transition_stale (
  transition_id integer NOT NULL REFERENCES analytics_v2_kernel_transitions(transition_id),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  cause smallint NOT NULL CHECK (cause BETWEEN 1 AND 3),
  PRIMARY KEY (transition_id, owner_digest, day)
);

CREATE FUNCTION analytics_v2_price_append_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_price_append_only' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_kernel_prices_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_kernel_prices
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_prices_no_truncate
BEFORE TRUNCATE ON analytics_v2_kernel_prices
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_price_cards_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_price_cards
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_price_cards_no_truncate
BEFORE TRUNCATE ON analytics_v2_price_cards
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_cards_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_kernel_cards
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_cards_no_truncate
BEFORE TRUNCATE ON analytics_v2_kernel_cards
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_price_bases_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_price_bases
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_price_bases_no_truncate
BEFORE TRUNCATE ON analytics_v2_price_bases
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_transitions_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_kernel_transitions
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_transitions_no_truncate
BEFORE TRUNCATE ON analytics_v2_kernel_transitions
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_transition_stale_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_transition_stale
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_transition_stale_no_truncate
BEFORE TRUNCATE ON analytics_v2_transition_stale
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
