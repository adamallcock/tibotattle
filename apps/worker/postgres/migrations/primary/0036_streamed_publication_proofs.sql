-- Persist the bounded per-owner proof fields needed to verify streamed graph
-- publications. Older captures retain their version-1 JSON member proof and
-- continue to be read through that compatibility path.
ALTER TABLE analytics_publication_owner_members
  ADD COLUMN source_kind text
    CHECK (source_kind IS NULL OR source_kind IN ('effective', 'v1.1', 'v1', 'mixed', 'v0.2')),
  ADD COLUMN input_fingerprint text
    CHECK (input_fingerprint IS NULL OR input_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN result_sha256 text
    CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT analytics_publication_member_proof_shape CHECK (
    (source_kind IS NULL AND input_fingerprint IS NULL AND result_sha256 IS NULL)
    OR (source_kind IN ('effective', 'v1.1', 'v1')
      AND input_fingerprint IS NOT NULL AND result_sha256 IS NOT NULL)
    OR (source_kind IN ('mixed', 'v0.2')
      AND input_fingerprint IS NULL AND result_sha256 IS NULL)
  );
