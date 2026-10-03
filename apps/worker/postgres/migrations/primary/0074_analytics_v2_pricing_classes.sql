-- analytics_v2 pricing classes (W1E, refresh optimization program 2026-10-03
-- section 3.2.1; owner decision round 18: price each row once per pricing
-- version, cached forever).
--
-- Promoted as primary 0074 by the Wave25 integration. Purely
-- additive: no CONTRACT_MIGRATIONS entry. It needs K-PERCARD's price cards
-- (primary 0072): every table below names analytics_v2_kernel_prices or
-- analytics_v2_kernel_transitions and uses its append-only trigger function,
-- so on an earlier schema the first CREATE TABLE fails and nothing is created.
--
-- Additive only: three new tables, their triggers and one trigger function.
-- It alters no existing table and no stored row, so a previous image keeps
-- working on the migrated schema (it writes none of these tables). An image
-- built with a pricer (cloud-run/analytics-kernel-closure.mjs) writes them in
-- its run's write transaction and refuses to write without them.
--
-- What is stored (src/analytics-v2/store-price.ts writes it):
--   * analytics_v2_pricing_classes: a pricing class is (pricer_sha256, the
--     pricing method version, the price-input projection version,
--     cards_sha256), with its digest (src/analytics-v2/kernel.ts
--     analyticsV2PricingClass). pricer_sha256 is the build's digest of the
--     tree-shaken pricing code alone, so the class is narrower than the
--     compute class: a kernel bump that changes no pricing code keeps it.
--   * analytics_v2_kernel_pricing_classes: the class each kernel prices
--     under, registered by the kernel's first write with a pricer. Its
--     cards and projection must be the kernel's registered ones
--     (analytics_v2_kernel_prices). A kernel without a row (registered before
--     W1E, or by a bundle that stated no pricer) has an UNKNOWN class, which
--     is never equal to another.
--   * analytics_v2_transition_proofs: how a recorded transition's proof was
--     established. Method 1 repriced every stored event; method 2 found both
--     kernels in the same pricing class and repriced a deterministic sample
--     of their owner-days (about 1 in sample_divisor, at least one when any
--     owner-day has a price), all exactly as stored. The verdict and stale
--     set (analytics_v2_kernel_transitions, analytics_v2_transition_stale)
--     are the same either way; only how the proof was established differs.
--     A transition recorded without a row (by a bundle that stated no
--     pricer, or before W1E) was proven by method 1.
--
-- Integer ids are assigned by the store (stored maximum plus one, under the
-- refresh lock): local surrogates; the identity is the class digest. Every
-- table is append-only: UPDATE, DELETE and TRUNCATE are refused. No table
-- holds an owner digest or any other owner-scoped value, so none joins the
-- offline purge inventory.

CREATE TABLE analytics_v2_pricing_classes (
  pricing_class_id integer PRIMARY KEY CHECK (pricing_class_id > 0),
  class_sha256 char(64) NOT NULL UNIQUE CHECK (class_sha256 ~ '^[0-9a-f]{64}$'),
  pricer_sha256 char(64) NOT NULL CHECK (pricer_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_method_version text NOT NULL CHECK (pricing_method_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  projection_version text NOT NULL CHECK (projection_version ~ '^analytics-v2-price-input-v[1-9][0-9]{0,5}$'),
  cards_sha256 char(64) NOT NULL CHECK (cards_sha256 ~ '^[0-9a-f]{64}$'),
  first_kernel_id smallint NOT NULL REFERENCES analytics_v2_kernel_prices(kernel_id),
  registered_at timestamptz NOT NULL
);

CREATE TABLE analytics_v2_kernel_pricing_classes (
  kernel_id smallint PRIMARY KEY REFERENCES analytics_v2_kernel_prices(kernel_id),
  pricing_class_id integer NOT NULL REFERENCES analytics_v2_pricing_classes(pricing_class_id),
  registered_at timestamptz NOT NULL
);
CREATE INDEX analytics_v2_kernel_pricing_classes_class ON analytics_v2_kernel_pricing_classes(pricing_class_id);

-- A kernel's class names exactly the cards and projection the kernel registered.
CREATE FUNCTION analytics_v2_kernel_pricing_class_matches_kernel()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM analytics_v2_kernel_prices k
                   JOIN analytics_v2_pricing_classes c ON c.pricing_class_id = NEW.pricing_class_id
                  WHERE k.kernel_id = NEW.kernel_id AND k.cards_sha256 = c.cards_sha256
                    AND k.projection_version = c.projection_version) THEN
    RAISE EXCEPTION 'analytics_v2_kernel_pricing_class_mismatch' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_kernel_pricing_class_matches_kernel
BEFORE INSERT ON analytics_v2_kernel_pricing_classes
FOR EACH ROW EXECUTE FUNCTION analytics_v2_kernel_pricing_class_matches_kernel();

CREATE TABLE analytics_v2_transition_proofs (
  transition_id integer PRIMARY KEY REFERENCES analytics_v2_kernel_transitions(transition_id),
  -- 1 full reprice, 2 pricing-class identity with a sampled reprice.
  method smallint NOT NULL CHECK (method IN (1, 2)),
  pricing_class_id integer REFERENCES analytics_v2_pricing_classes(pricing_class_id),
  sample_divisor integer CHECK (sample_divisor BETWEEN 1 AND 1000000),
  -- Owner-days and events repriced (all of them for method 1, the sample for method 2).
  repriced_owner_days integer NOT NULL CHECK (repriced_owner_days >= 0),
  repriced_events bigint NOT NULL CHECK (repriced_events >= 0),
  CHECK ((method = 2) = (pricing_class_id IS NOT NULL)),
  CHECK ((method = 2) = (sample_divisor IS NOT NULL))
);

-- Method 2 is recorded only for two kernels registered in the same class.
CREATE FUNCTION analytics_v2_transition_proof_same_class()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.method = 2 AND NOT EXISTS (
       SELECT 1 FROM analytics_v2_kernel_transitions t
         JOIN analytics_v2_kernel_pricing_classes f ON f.kernel_id = t.from_kernel
         JOIN analytics_v2_kernel_pricing_classes c ON c.kernel_id = t.to_kernel
        WHERE t.transition_id = NEW.transition_id
          AND f.pricing_class_id = NEW.pricing_class_id AND c.pricing_class_id = NEW.pricing_class_id) THEN
    RAISE EXCEPTION 'analytics_v2_transition_proof_class_unproven' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_transition_proof_same_class
BEFORE INSERT ON analytics_v2_transition_proofs
FOR EACH ROW EXECUTE FUNCTION analytics_v2_transition_proof_same_class();

CREATE TRIGGER analytics_v2_pricing_classes_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_pricing_classes
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_pricing_classes_no_truncate
BEFORE TRUNCATE ON analytics_v2_pricing_classes
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_pricing_classes_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_kernel_pricing_classes
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_kernel_pricing_classes_no_truncate
BEFORE TRUNCATE ON analytics_v2_kernel_pricing_classes
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_transition_proofs_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_transition_proofs
FOR EACH ROW EXECUTE FUNCTION analytics_v2_price_append_only();
CREATE TRIGGER analytics_v2_transition_proofs_no_truncate
BEFORE TRUNCATE ON analytics_v2_transition_proofs
FOR EACH STATEMENT EXECUTE FUNCTION analytics_v2_price_append_only();
