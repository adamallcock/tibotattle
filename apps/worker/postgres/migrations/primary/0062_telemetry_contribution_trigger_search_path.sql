-- PostgreSQL primary migration 0062: pin the search_path of the last runtime
-- function that still resolved its tables through the caller's session.
--
-- Primary 0011 created telemetry_contributions_require_active_participant()
-- without SET search_path, and its body reads `participants` unqualified.
-- The migration runner pins each transaction to the runtime schema and
-- pg_catalog, but the origin's Cloud SQL pools set no search_path, so the
-- BEFORE INSERT trigger telemetry_contributions_active_participant resolved
-- `participants` through the server default ("$user", public). An insert
-- into telemetry_contributions from such a session failed with 42P01 unless
-- the caller pinned the path itself, which only the v0.1 persist did.
-- 0011's other unpinned trigger function,
-- telemetry_contributions_enforce_participant_limit(), was dropped by 0061.
-- Every other function this chain creates already pins its path.
--
-- SET search_path FROM CURRENT captures the path the runner sets for this
-- migration's transaction: the schema the function lives in, then
-- pg_catalog. Every other runtime function in this chain uses the same
-- pin. Only the function's configuration changes; its body, owner and
-- grants stay as they are. postgres-function-search-path.spec.mjs writes
-- through the trigger from a pool without a search_path and asserts that
-- every function in the runtime schema pins one.

ALTER FUNCTION telemetry_contributions_require_active_participant()
  SET search_path FROM CURRENT;
