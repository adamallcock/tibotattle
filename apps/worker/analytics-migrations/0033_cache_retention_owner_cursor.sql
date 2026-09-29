-- A bounded scheduling cursor for cache retention. It records only a numeric
-- position in the currently eligible owner order, never an owner identity or
-- a claim that a candidate day was completed. A changed owner set is handled
-- by taking the position modulo its current size on every pass.
CREATE TABLE analytics_cache_retention_owner_cursor (
  source_id TEXT NOT NULL,
  shard_count INTEGER NOT NULL CHECK(shard_count BETWEEN 1 AND 256),
  shard_index INTEGER NOT NULL CHECK(shard_index>=0 AND shard_index<shard_count),
  method_version TEXT NOT NULL CHECK(length(method_version)>0 AND length(method_version)<=128),
  next_owner_offset INTEGER NOT NULL CHECK(next_owner_offset>=0),
  revision INTEGER NOT NULL CHECK(revision>0),
  PRIMARY KEY(source_id,shard_count,shard_index),
  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)
) STRICT, WITHOUT ROWID;
