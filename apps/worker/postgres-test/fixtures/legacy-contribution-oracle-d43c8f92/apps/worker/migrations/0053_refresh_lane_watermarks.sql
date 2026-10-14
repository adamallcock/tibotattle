PRAGMA foreign_keys = ON;

-- Compact completion receipts, not new sources of analytical truth. A receipt
-- is reusable only at its exact source epoch, UTC day and method version.
CREATE TABLE community_refresh_lanes (
  lane TEXT PRIMARY KEY CHECK (lane IN ('current', 'daily')),
  source_epoch INTEGER NOT NULL CHECK (source_epoch >= 0),
  utc_day TEXT NOT NULL,
  method_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'complete')),
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  restart_reason TEXT CHECK (restart_reason IN ('input_changed', 'method_changed', 'retry'))
) STRICT;

-- Completion is revoked in the same transaction as any material cache change.
-- This makes missing/corrupt cache repair possible without an idle cohort scan.
-- Identical writes and timestamp-only touches do not restart analytical work.
CREATE TRIGGER community_refresh_fit_insert AFTER INSERT ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
CREATE TRIGGER community_refresh_fit_delete AFTER DELETE ON community_allowance_fit_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
CREATE TRIGGER community_refresh_fit_update AFTER UPDATE ON community_allowance_fit_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.fits_json IS NOT NEW.fits_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
  OR OLD.model_observations_json IS NOT NEW.model_observations_json
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
CREATE TRIGGER community_refresh_model_insert AFTER INSERT ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
CREATE TRIGGER community_refresh_model_delete AFTER DELETE ON community_model_composition_cache
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
CREATE TRIGGER community_refresh_model_update AFTER UPDATE ON community_model_composition_cache
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.cache_key IS NOT NEW.cache_key
  OR OLD.composition_json IS NOT NEW.composition_json OR OLD.input_fingerprint IS NOT NEW.input_fingerprint
  OR OLD.source_method_version IS NOT NEW.source_method_version
BEGIN
  UPDATE community_refresh_lanes SET state='queued',completed_at=NULL,restart_reason='retry'
    WHERE state='complete';
END;
