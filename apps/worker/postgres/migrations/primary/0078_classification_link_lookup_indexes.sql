-- Classification-link lookups that domain activation makes per corrected row.
--
-- postgresClassificationLinkPredicate (v1.1 typed-v1, legacy and
-- previous-generation closures, and the v1.2 same-day successor closure)
-- matches links by device and occurrence, and readLinks (the activation proof
-- and every effective reader) by participant, stream and occurrence. Neither
-- binds the column after participant_id in 0076's only covering index
-- (participant_id, device_id, stream, occurrence_id, ...), and PostgreSQL 17
-- has no skip scan, so each probe walked every link: a correction activation
-- cost (corrected rows x links), and the links it writes grow during that
-- same activation. Locally a 12,008-correction activation spent 9.3 s in one
-- v1.2 same-day closure statement and timed out a v1.1 previous-generation
-- probe at 60 s; with these two indexes the slowest of those statements took
-- 8 ms and 0.51 s.
--
-- NUMBER. Primary 0078, right after 0077_analytics_v2_reprice.sql. Purely
-- additive (two indexes): it drops, rewrites and constrains nothing, so it
-- needs no CONTRACT_MIGRATIONS entry. No reader's SQL changes.
--
-- COST. CREATE INDEX takes a SHARE lock on the links table for the build, so
-- an activation that would write a link waits; the runner's lock and
-- statement timeouts bound it, and a failure rolls the migration back.
-- Production held no link rows when this was written (2026-10-10), so each
-- build reads an empty heap.
CREATE INDEX telemetry_classification_correction_occurrence
  ON telemetry_classification_correction_links (device_id, occurrence_id);
CREATE INDEX telemetry_classification_correction_reader
  ON telemetry_classification_correction_links (participant_id, stream, occurrence_id);
