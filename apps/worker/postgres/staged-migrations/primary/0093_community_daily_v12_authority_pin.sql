-- Add an immutable, nullable pin for the v1.2 runtime and accountless
-- authorization window captured by each community daily revision. Historical
-- publications stay NULL: their publication-time v1.2 authority is unknown.
-- This pin does not authorize typed-v1.2 inclusion; authorization writes and
-- the expiry boundary must also be fenced through commit before that source is enabled.

ALTER TABLE community_daily_aggregates
  ADD COLUMN telemetry_v12_runtime_state text
    CHECK (telemetry_v12_runtime_state IN ('staged', 'active', 'blocked')),
  ADD COLUMN telemetry_v12_runtime_revision bigint
    CHECK (telemetry_v12_runtime_revision IS NULL OR telemetry_v12_runtime_revision >= 0),
  ADD COLUMN telemetry_v12_typed_runtime_state text
    CHECK (telemetry_v12_typed_runtime_state IN ('staged', 'active')),
  ADD COLUMN telemetry_v12_typed_runtime_policy_revision bigint
    CHECK (telemetry_v12_typed_runtime_policy_revision IS NULL
      OR telemetry_v12_typed_runtime_policy_revision >= 1),
  ADD COLUMN telemetry_v12_accountless_authorization_count bigint
    CHECK (telemetry_v12_accountless_authorization_count IS NULL
      OR telemetry_v12_accountless_authorization_count >= 0),
  ADD COLUMN telemetry_v12_next_accountless_authorization_expiry timestamptz;

ALTER TABLE community_daily_aggregates
  ADD CONSTRAINT community_daily_v12_authority_pin_complete CHECK (
    (
      telemetry_v12_runtime_state IS NULL
      AND telemetry_v12_runtime_revision IS NULL
      AND telemetry_v12_typed_runtime_state IS NULL
      AND telemetry_v12_typed_runtime_policy_revision IS NULL
      AND telemetry_v12_accountless_authorization_count IS NULL
      AND telemetry_v12_next_accountless_authorization_expiry IS NULL
    ) OR (
      telemetry_v12_runtime_state IS NOT NULL
      AND telemetry_v12_runtime_revision IS NOT NULL
      AND telemetry_v12_typed_runtime_state IS NOT NULL
      AND telemetry_v12_typed_runtime_policy_revision IS NOT NULL
      AND telemetry_v12_accountless_authorization_count IS NOT NULL
      AND ((telemetry_v12_accountless_authorization_count = 0
        AND telemetry_v12_next_accountless_authorization_expiry IS NULL)
        OR (telemetry_v12_accountless_authorization_count > 0
          AND telemetry_v12_next_accountless_authorization_expiry IS NOT NULL))
    )
  );

-- Runtime state is a publication authority input. Require every state change
-- to advance its existing monotonic revision; never infer or repair operator
-- policy changes inside a trigger.
CREATE FUNCTION community_daily_v12_runtime_revision_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.revision < OLD.revision
      OR (NEW.state IS DISTINCT FROM OLD.state AND NEW.revision <= OLD.revision) THEN
    RAISE EXCEPTION 'community_daily_v12_runtime_revision_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_v12_runtime_revision_guard
BEFORE UPDATE ON telemetry_v12_runtime
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_runtime_revision_guard();

-- Typed runtime policy includes activation state, accepted contract versions,
-- and input bounds. A change to any pinned policy field needs a strictly newer
-- policy revision so an active -> staged -> active round trip cannot recreate
-- an earlier daily pin.
CREATE FUNCTION community_daily_v12_typed_runtime_revision_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.policy_revision < OLD.policy_revision
      OR ((to_jsonb(NEW) - ARRAY['policy_revision', 'changed_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['policy_revision', 'changed_at'])
          AND NEW.policy_revision <= OLD.policy_revision) THEN
    RAISE EXCEPTION 'community_daily_v12_typed_runtime_revision_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_v12_typed_runtime_revision_guard
BEFORE UPDATE ON telemetry_v12_typed_runtime
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_typed_runtime_revision_guard();

-- These singleton rows are the source of the monotonic counters above. They
-- cannot be removed and recreated with an older value to evade those guards.
CREATE FUNCTION community_daily_v12_runtime_no_removal()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_daily_v12_runtime_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER community_daily_v12_runtime_no_delete
BEFORE DELETE ON telemetry_v12_runtime
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_runtime_no_removal();
CREATE TRIGGER community_daily_v12_runtime_no_truncate
BEFORE TRUNCATE ON telemetry_v12_runtime
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_runtime_no_removal();
CREATE TRIGGER community_daily_v12_typed_runtime_no_delete
BEFORE DELETE ON telemetry_v12_typed_runtime
FOR EACH ROW EXECUTE FUNCTION community_daily_v12_runtime_no_removal();
CREATE TRIGGER community_daily_v12_typed_runtime_no_truncate
BEFORE TRUNCATE ON telemetry_v12_typed_runtime
FOR EACH STATEMENT EXECUTE FUNCTION community_daily_v12_runtime_no_removal();
