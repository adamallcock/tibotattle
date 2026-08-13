-- 0036: v1 community-fit analyzer read index.
--
-- accountScopedQuotaAnalysisV1 (apps/worker/src/quota-analysis-v1.ts) reads the
-- participant's v1 records windowed and ordered by observed_at for two purposes:
-- a run-endpoint quota downsample and a keyset-paginated usage stream. Before
-- this index only telemetry_v1_records_aggregate_day (observed_day, stream,
-- provider, model_id) and the UNIQUE(participant_id, device_id, stream,
-- occurrence_id) prefix existed, so both reads scanned the whole participant
-- partition. This composite makes the windowed + ordered reads a range scan:
-- (participant_id, stream) selects the branch, observed_at gives the ordered
-- range the WHERE observed_at >= cutoff / keyset cursor walk.
CREATE INDEX telemetry_v1_records_participant_stream_observed
  ON telemetry_v1_records(participant_id, stream, observed_at);
