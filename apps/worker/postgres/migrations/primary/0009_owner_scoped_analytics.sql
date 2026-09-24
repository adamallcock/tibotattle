-- Canonical owner identity and publication membership needed by analytical
-- erasure. These rows keep the source's opaque owner identity separate from
-- the participant deletion digest and let aggregate publications be
-- invalidated without deleting another owner's analytical state.
CREATE TABLE storage_v11_owner_links (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  owner_digest text NOT NULL UNIQUE CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('active', 'withdrawn', 'erased')),
  generation_id text,
  head_revision bigint,
  object_digest text,
  manifest_digest text
);
CREATE INDEX storage_v11_owner_links_state
  ON storage_v11_owner_links(state, participant_id);

CREATE TABLE analytics_publication_owner_members (
  source_id text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('daily', 'model', 'graph')),
  generation text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, day, metric, generation, owner_digest)
);
CREATE INDEX analytics_publication_owner_members_owner
  ON analytics_publication_owner_members(source_id, owner_digest, day, metric, generation);

CREATE TABLE analytics_publication_invalidations (
  source_id text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('daily', 'model', 'graph')),
  generation text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('owner-erased', 'owner-withdrawn', 'source-stale')),
  invalidated_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, day, metric, generation, owner_digest)
);
CREATE INDEX analytics_publication_invalidations_lookup
  ON analytics_publication_invalidations(source_id, day, metric, generation);
