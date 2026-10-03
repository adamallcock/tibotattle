-- analytics_v2 kernel stamps (K-STAMP, owner decision round 7: two integers).
--
-- STAGED. 0066 is a placeholder: the integrator assigns the number at
-- promotion (new primary migrations start after 0065).
--
-- Every analytics_v2 row records the kernel that computed it (kernel_id, a
-- smallint the repository assigns in src/analytics-v2/kernel-registry.json,
-- identical in every environment) and the configuration it priced and
-- classified with (manifest_version, an int; 1 is the compiled baseline, the
-- catalog and price registry vendored with the kernels, and it is never 0 or
-- unknown). Run rows also record their compatibility class
-- (compatibility_sha256: the compute closure, the method and the resource
-- configuration that decides refusals).
--
-- analytics_v2_kernels is the registry's copy: the refresh store inserts a
-- run's kernel row (ON CONFLICT DO NOTHING) and refuses a stored row that
-- disagrees (ANALYTICS_V2_KERNEL_CONFLICT). Rows are never updated or deleted.
--
-- Backfill. Kernel 1 is d43c8f92's vendored kernels with the compute closure
-- registered as entry 1. Every analytics_v2 row that exists before this
-- migration was written by the fast-path refresh on the same vendored
-- kernels; its compute code was refactored into kernel 1's closure without a
-- change in output (the K-CORE-A receipt holds the Q-1 and dense rehearsals
-- byte-identical across it), so those rows are stamped kernel 1, manifest 1.
-- Their run rows keep compatibility_sha256 NULL: it was not recorded, and an
-- unknown class is never inferred.
--
-- Fails closed: it refuses unless every stored run is a full recompute (the
-- only mode before this migration). Column defaults are used only to stamp
-- existing rows without an UPDATE (so 0059's forward-only trigger on
-- analytics_v2_published_daily is not fired) and are dropped at the end:
-- every new row must name its kernel and manifest.

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

-- Registry entry 1 (src/analytics-v2/kernel-registry.json; the registry check
-- pins this row to it).
INSERT INTO analytics_v2_kernels (kernel_id, production_commit, vendor_manifest_sha256, compute_closure_sha256,
  price_registry_sha256, price_registry_version, method_version, registered_at)
VALUES (1, 'd43c8f92a059d9c577776f7eca8a331eb305b8a6',
  '97acb9afc16e5cf18c11e2c33d18e60e38b46484ace3a9df4fa5a85d6b52ef66',
  '687e74b30f9b2a6320af003e05c2def6b010ca65ae1ac37d247998c5f4e706c3',
  '48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9',
  'app-official-api-prices-v0.8', 'analytics-v2-method-v1', '2026-10-02T00:00:00Z');

ALTER TABLE analytics_v2_runs
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1),
  ADD COLUMN compatibility_sha256 char(64) CHECK (compatibility_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE analytics_v2_owner_day
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_cache_bands
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_owner_fits
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_owner_model_dates
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_published_daily
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);
ALTER TABLE analytics_v2_preview
  ADD COLUMN kernel_id smallint NOT NULL DEFAULT 1 REFERENCES analytics_v2_kernels(kernel_id),
  ADD COLUMN manifest_version integer NOT NULL DEFAULT 1 CHECK (manifest_version >= 1);

ALTER TABLE analytics_v2_runs ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_owner_day ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_cache_bands ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_owner_fits ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_owner_model_dates ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_published_daily ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;
ALTER TABLE analytics_v2_preview ALTER COLUMN kernel_id DROP DEFAULT, ALTER COLUMN manifest_version DROP DEFAULT;

-- The newest kernel that wrote: the store refuses a run whose kernel is older
-- (ANALYTICS_V2_KERNEL_REGRESSION). Every stamped write commits with its run row.
CREATE INDEX analytics_v2_runs_kernel ON analytics_v2_runs(kernel_id);
