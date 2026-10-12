-- PostgreSQL primary migration 0012: resumable provider preparation.
--
-- A generation's stream is an explicit row, rather than a convention in the
-- generation string.  Control and derived output records share the prepared
-- page's transaction and CAS, so a retry can rehydrate the exact compression
-- state and a final empty physical page can still publish its flushed output.

CREATE TABLE analytics_prepared_source_streams (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  observed_day date NOT NULL,
  generation text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('quota', 'usage')),
  PRIMARY KEY (source_id, owner_digest, observed_day, stream),
  UNIQUE (source_id, owner_digest, observed_day, generation)
);

CREATE TABLE analytics_prepared_source_controls (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  observed_day date NOT NULL,
  generation text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('quota', 'usage')),
  control_json text NOT NULL,
  control_sha256 text NOT NULL CHECK (control_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, owner_digest, observed_day, generation, stream),
  FOREIGN KEY (source_id, owner_digest, observed_day, stream)
    REFERENCES analytics_prepared_source_streams(source_id, owner_digest, observed_day, stream)
    ON DELETE CASCADE
);

CREATE TABLE analytics_prepared_source_outputs (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  observed_day date NOT NULL,
  generation text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('quota', 'usage')),
  output_kind text NOT NULL CHECK (output_kind IN ('plan', 'fit', 'usage_price', 'usage_fragment')),
  output_key text NOT NULL,
  output_index bigint NOT NULL CHECK (output_index >= 0),
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, owner_digest, observed_day, generation, stream, output_kind, output_key),
  FOREIGN KEY (source_id, owner_digest, observed_day, stream)
    REFERENCES analytics_prepared_source_streams(source_id, owner_digest, observed_day, stream)
    ON DELETE CASCADE,
  CHECK ((stream = 'quota' AND output_kind IN ('plan', 'fit'))
      OR (stream = 'usage' AND output_kind IN ('usage_price', 'usage_fragment')))
);
CREATE INDEX analytics_prepared_source_outputs_page
  ON analytics_prepared_source_outputs(source_id, owner_digest, observed_day,
    generation, stream, output_kind, output_index, output_key);
