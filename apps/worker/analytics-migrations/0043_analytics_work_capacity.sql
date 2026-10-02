-- Compact source-wide queue populations, atomic pending-work capacity and
-- last observed runtime controls. These global aggregates contain no subjects.
-- Of65536 pending slots,256 are reserved from background/recovery work;
-- the last64 are available only to withdrawals. Existing work is never removed.
CREATE TABLE analytics_partition_work_counts (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 stage TEXT NOT NULL CHECK(stage IN('canonical','features','activity','fits','cache','publication','cleanup')),
 state TEXT NOT NULL CHECK(state IN('ready','leased','complete','refused')),
 jobs INTEGER NOT NULL CHECK(jobs>=0),
 last_claimed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(last_claimed)='integer' AND last_claimed BETWEEN 0 AND 9007199254740990),
 claim_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(claim_count)='integer' AND claim_count BETWEEN 0 AND 9007199254740990),
 PRIMARY KEY(source_id,stage,state),
 CHECK(state='leased' OR (last_claimed=0 AND claim_count=0))
);
INSERT INTO analytics_partition_work_counts(source_id,stage,state,jobs)
 SELECT source_id,stage,state,count(*) FROM analytics_partition_work GROUP BY source_id,stage,state;
-- Stage scheduling has at most seven rows per source. Retain the zero-job
-- leased row; its recency/count is separate from the exact queue population.
INSERT INTO analytics_partition_work_counts(source_id,stage,state,jobs,last_claimed,claim_count)
 SELECT source_id,stage,'leased',0,MAX(last_claimed),sum(attempts)
 FROM analytics_partition_work WHERE true GROUP BY source_id,stage
 ON CONFLICT(source_id,stage,state) DO UPDATE SET last_claimed=excluded.last_claimed,claim_count=excluded.claim_count;
ALTER TABLE analytics_partition_work ADD COLUMN reason_code TEXT
 CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^a-z_]*'));
-- Observational reasons do not change a lease revision. Every other mutable
-- column still requires the original transition CAS and immutable identity.
DROP TRIGGER analytics_partition_work_immutable;
CREATE TRIGGER analytics_partition_work_immutable BEFORE UPDATE OF work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,day,stream,selection_method,state,resident_bytes,admission_queries,revision,claim_token,claim_expires_ms,attempts,last_claimed,ready_ms,created_ms,updated_ms ON analytics_partition_work
WHEN NEW.work_key!=OLD.work_key OR NEW.head_key!=OLD.head_key OR NEW.source_id!=OLD.source_id
 OR NEW.owner_digest IS NOT OLD.owner_digest OR NEW.partition_key!=OLD.partition_key
 OR NEW.input_revision!=OLD.input_revision OR NEW.policy_revision!=OLD.policy_revision OR NEW.stage!=OLD.stage
 OR NEW.day IS NOT OLD.day OR NEW.stream IS NOT OLD.stream OR NEW.selection_method IS NOT OLD.selection_method
 OR NEW.resident_bytes!=OLD.resident_bytes OR NEW.admission_queries!=OLD.admission_queries
 OR NEW.revision!=OLD.revision+1 OR NEW.created_ms!=OLD.created_ms OR NEW.updated_ms<OLD.updated_ms
BEGIN SELECT RAISE(ABORT,'analytics_partition_work_conflict'); END;
CREATE TRIGGER analytics_partition_capacity_insert BEFORE INSERT ON analytics_partition_work
 WHEN NOT EXISTS(SELECT 1 FROM analytics_partition_work WHERE work_key=NEW.work_key)
 AND NEW.state IN('ready','leased') AND COALESCE((SELECT sum(jobs) FROM analytics_partition_work_counts
 WHERE source_id=NEW.source_id AND state IN('ready','leased')),0)>=
 CASE NEW.lane WHEN 'withdrawal' THEN 65536 WHEN 'new' THEN 65472 ELSE 65280 END
 BEGIN SELECT RAISE(ABORT,'analytics_work_capacity'); END;
CREATE TRIGGER analytics_partition_capacity_reopen BEFORE UPDATE OF state ON analytics_partition_work
 WHEN OLD.state NOT IN('ready','leased') AND NEW.state IN('ready','leased')
 AND COALESCE((SELECT sum(jobs) FROM analytics_partition_work_counts
 WHERE source_id=NEW.source_id AND state IN('ready','leased')),0)>=
 CASE NEW.lane WHEN 'withdrawal' THEN 65536 WHEN 'new' THEN 65472 ELSE 65280 END
 BEGIN SELECT RAISE(ABORT,'analytics_work_capacity'); END;
CREATE TRIGGER analytics_partition_counts_insert AFTER INSERT ON analytics_partition_work
 BEGIN INSERT INTO analytics_partition_work_counts(source_id,stage,state,jobs) VALUES(NEW.source_id,NEW.stage,NEW.state,1)
 ON CONFLICT(source_id,stage,state) DO UPDATE SET jobs=jobs+1; END;
CREATE TRIGGER analytics_partition_counts_state AFTER UPDATE OF state ON analytics_partition_work
 WHEN OLD.state!=NEW.state BEGIN
 UPDATE analytics_partition_work_counts SET jobs=jobs-1 WHERE source_id=OLD.source_id AND stage=OLD.stage AND state=OLD.state;
 INSERT INTO analytics_partition_work_counts(source_id,stage,state,jobs) VALUES(NEW.source_id,NEW.stage,NEW.state,1)
 ON CONFLICT(source_id,stage,state) DO UPDATE SET jobs=jobs+1;
 END;
CREATE TRIGGER analytics_partition_counts_delete AFTER DELETE ON analytics_partition_work
 BEGIN UPDATE analytics_partition_work_counts SET jobs=jobs-1 WHERE source_id=OLD.source_id AND stage=OLD.stage AND state=OLD.state; END;
-- A changed successful lease token records exactly one stage opportunity in
-- the same native transaction, including expired reclaim or lost responses.
-- UPSERT jobs0 makes this independent of the population-trigger firing order.
CREATE TRIGGER analytics_partition_counts_claim AFTER UPDATE OF state,claim_token ON analytics_partition_work
 WHEN NEW.state='leased' AND NEW.claim_token IS NOT NULL AND NEW.claim_token IS NOT OLD.claim_token
 BEGIN INSERT INTO analytics_partition_work_counts(source_id,stage,state,jobs,last_claimed,claim_count)
 VALUES(NEW.source_id,NEW.stage,'leased',0,NEW.last_claimed,1)
 ON CONFLICT(source_id,stage,state) DO UPDATE SET last_claimed=MAX(last_claimed,excluded.last_claimed),claim_count=claim_count+1;
 END;
CREATE TABLE analytics_pipeline_runtime (
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN('analytics','publication','cache')),
 method TEXT NOT NULL CHECK(method='maintained-analytics-v1'),
 canonical_enabled INTEGER NOT NULL CHECK(canonical_enabled IN(0,1)),
 shared_features_enabled INTEGER NOT NULL CHECK(shared_features_enabled IN(0,1)),
 model_blocks_enabled INTEGER NOT NULL CHECK(model_blocks_enabled IN(0,1)),
 degree INTEGER NOT NULL CHECK(degree IN(1,2,4,8)),
 max_queries INTEGER NOT NULL CHECK(max_queries BETWEEN 1 AND 950),
 updated_ms INTEGER NOT NULL CHECK(updated_ms>=0),PRIMARY KEY(source_id,role)
);
