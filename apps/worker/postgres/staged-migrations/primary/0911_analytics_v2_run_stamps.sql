-- analytics_v2 run stamps: the kernel stamps (K-STAMP, owner decision round 7:
-- two integers) and the community aggregate exclusions a run applied (N-EXCL,
-- owner decision round 5: "their use in GCP analytics").
--
-- STAGED. 0911 is a placeholder, chosen outside every sibling stream's
-- staged range (D-PT4X used 0901 and 0902; the catalog manifest store is
-- staged as 0066): the integrator assigns the next free primary number at
-- promotion. Specs and checks find it by its name suffix.
--
-- Every analytics_v2 row a run writes records the kernel that computed it
-- (kernel_id, a smallint the repository assigns in
-- src/analytics-v2/kernel-registry.json, identical in every environment) and
-- the configuration it priced and classified with (manifest_version, an int;
-- 1 is the compiled baseline, the catalog and price registry vendored with
-- the kernels, and it is never 0 or unknown). Run rows also record their
-- compatibility class (compatibility_sha256: the compute closure, the method
-- and the resource configuration that decides refusals).
--
-- analytics_v2_kernels is the registry's copy. It is seeded with nothing: the
-- refresh store inserts a run's kernel row (ON CONFLICT DO NOTHING) in the
-- run's write transaction and refuses a stored row that disagrees
-- (ANALYTICS_V2_KERNEL_CONFLICT). Rows are never updated or deleted.
--
-- Rows written before this migration (K-CORE-A review). They were written by
-- fast-path refresh images that predate the registry, whose code no registry
-- entry names (kernel 1 is the first registered closure, not theirs). So:
--   * their kernel_id is NULL: unattributed, never inferred. A NOT VALID
--     CHECK requires a kernel on every row inserted or updated after this
--     migration, and leaves those rows as they are. Do not VALIDATE it. A
--     later run that rewrites such a row stamps it with its own kernel;
--   * their manifest_version is 1: before this migration the vendored
--     d43c8f92 catalog was the only configuration any run could price with,
--     so this records a fact, not an inference;
--   * their run rows keep compatibility_sha256 NULL: it was not recorded.
-- The column default that stamps manifest_version 1 on those rows is used
-- only to avoid an UPDATE (0059's forward-only trigger on
-- analytics_v2_published_daily is not fired) and is dropped at the end: every
-- new row must name its kernel and manifest.
--
-- Applied exclusions (N-EXCL). analytics_v2_runs.exclusions_sha256 is the
-- digest of every community_aggregate_exclusions row (any state) the run read
-- and applied (owners.ts readAnalyticsV2Exclusions). When the next run reads a
-- different digest it republishes every published day (a day whose content is
-- unchanged keeps its revision), so a new, revoked or edited exclusion reaches
-- the days it covers. Runs written before this migration applied no exclusion
-- (the code applied them to no output), so their NULL means the empty set
-- (ANALYTICS_V2_NO_EXCLUSIONS_SHA256): that records what the code did, not an
-- inference. A NOT VALID CHECK requires the digest on every run row written
-- after this migration.
--
-- Fails closed: it refuses unless every stored run is a full recompute (the
-- only mode before this migration).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM analytics_v2_runs WHERE mode <> 'full') THEN
    RAISE EXCEPTION 'analytics_v2_kernel_stamps_unexpected_mode' USING ERRCODE = 'P1005';
  END IF;
END;
$$;

CREATE TABLE analytics_v2_kernels (
  kernel_id smallint PRIMARY KEY CHECK (kernel_id > 0),
  production_commit char(40) NOT NULL CHECK (production_commit ~ '^[0-9a-f]{40}$'),
  vendor_manifest_sha256 char(64) NOT NULL CHECK (vendor_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  compute_closure_sha256 char(64) NOT NULL CHECK (compute_closure_sha256 ~ '^[0-9a-f]{64}$'),
  price_registry_sha256 char(64) NOT NULL CHECK (price_registry_sha256 ~ '^[0-9a-f]{64}$'),
  price_registry_version text NOT NULL
    CHECK (length(price_registry_version) BETWEEN 1 AND 64 AND price_registry_version ~ '^[A-Za-z0-9._:-]+$'),
  method_version text NOT NULL CHECK (method_version ~ '^analytics-v2-method-v[1-9][0-9]{0,5}$'),
  registered_at timestamptz NOT NULL,
  UNIQUE (vendor_manifest_sha256, compute_closure_sha256, method_version)
);

CREATE FUNCTION analytics_v2_kernels_append_only()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'analytics_v2_kernels_append_only' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER analytics_v2_kernels_append_only
BEFORE UPDATE OR DELETE ON analytics_v2_kernels
FOR EACH ROW EXECUTE FUNCTION analytics_v2_kernels_append_only();

ALTER TABLE analytics_v2_runs
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1),
  ADD COLUMN compatibility_sha256 char(64) CHECK (compatibility_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN exclusions_sha256 char(64) CHECK (exclusions_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE analytics_v2_owner_day
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_cache_bands
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_owner_fits
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_owner_model_dates
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_published_daily
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_preview
  ADD COLUMN kernel_id smallint REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);

ALTER TABLE analytics_v2_runs ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_runs_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT analytics_v2_runs_exclusions_recorded CHECK (exclusions_sha256 IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_owner_day ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_owner_day_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_cache_bands ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_cache_bands_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_owner_fits ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_owner_fits_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_owner_model_dates ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_owner_model_dates_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_published_daily ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_published_daily_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;
ALTER TABLE analytics_v2_preview ALTER COLUMN manifest_version DROP DEFAULT,
  ADD CONSTRAINT analytics_v2_preview_kernel_stamped CHECK (kernel_id IS NOT NULL) NOT VALID;

-- The newest kernel that wrote: the store refuses a run whose kernel is older
-- (ANALYTICS_V2_KERNEL_REGRESSION). Every stamped write commits with its run row.
CREATE INDEX analytics_v2_runs_kernel ON analytics_v2_runs(kernel_id);
