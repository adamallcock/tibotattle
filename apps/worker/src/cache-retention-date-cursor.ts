import {dailyOwnerCursorMode} from './storage-community-daily-cursor';
/** Scheduling only: this metadata proves neither native source completeness nor publication. */
export const CACHE_DATE_CURSOR_TABLE='analytics_cache_retention_date_cursor';
export const CACHE_DATE_CURSOR_SCHEMA=[
  {
    "type": "table",
    "name": "analytics_cache_retention_date_cursor",
    "tbl_name": "analytics_cache_retention_date_cursor",
    "sql": "CREATE TABLE analytics_cache_retention_date_cursor (\n cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,\n source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),\n owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),\n cycle_upper_day INTEGER NOT NULL CHECK(cycle_upper_day BETWEEN -719528 AND 2932896),\n next_day INTEGER NOT NULL CHECK(next_day BETWEEN -719528 AND 2932897),\n next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 0 AND 9007199254740991),\n day_slot_limit INTEGER NOT NULL CHECK(day_slot_limit BETWEEN 0 AND 9007199254740991),\n revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n UNIQUE(source_id,owner_digest),\n FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),\n CHECK(cursor_id BETWEEN 1 AND 9007199254740991),\n CHECK(next_day<=cycle_upper_day+1),\n CHECK(next_ordinal<=day_slot_limit),\n CHECK(day_slot_limit>0 OR next_ordinal=0),\n CHECK(next_day<=cycle_upper_day OR (next_ordinal=0 AND day_slot_limit=0))\n) STRICT"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_insert",
    "tbl_name": "analytics_cache_retention_date_cursor",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_insert\nBEFORE INSERT ON analytics_cache_retention_date_cursor\nWHEN NEW.revision!=1 OR NEW.next_ordinal!=0 OR NEW.day_slot_limit!=0\n OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id\n  WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active' AND r.contract_version=1\n  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))\nBEGIN SELECT RAISE(ABORT,'analytics_cache_date_cursor_conflict'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_update",
    "tbl_name": "analytics_cache_retention_date_cursor",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_update\nBEFORE UPDATE ON analytics_cache_retention_date_cursor\nWHEN NEW.cursor_id!=OLD.cursor_id OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest\n OR NEW.revision!=OLD.revision+1\n OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state='active'\n  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))\n OR NOT (\n  (OLD.next_day=OLD.cycle_upper_day+1 AND NEW.next_day<=NEW.cycle_upper_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)\n  OR (NEW.cycle_upper_day=OLD.cycle_upper_day AND OLD.next_day<=OLD.cycle_upper_day AND (\n   (NEW.next_day>OLD.next_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)\n   OR (NEW.next_day=OLD.next_day AND OLD.day_slot_limit>0 AND NEW.day_slot_limit=OLD.day_slot_limit AND NEW.next_ordinal>OLD.next_ordinal)\n   OR (NEW.next_day>=OLD.next_day AND OLD.day_slot_limit=0 AND NEW.day_slot_limit>0 AND NEW.next_ordinal>0)\n  ))\n )\nBEGIN SELECT RAISE(ABORT,'analytics_cache_date_cursor_conflict'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_owner_terminal",
    "tbl_name": "analytics_owner_state",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_owner_terminal\nAFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!='active'\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_erasure",
    "tbl_name": "analytics_storage_erasure_fences",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_erasure\nAFTER INSERT ON analytics_storage_erasure_fences\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_erasure_replay",
    "tbl_name": "analytics_storage_erasure_fences",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_erasure_replay\nAFTER UPDATE ON analytics_storage_erasure_fences\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_date_cursor_owner_delete",
    "tbl_name": "analytics_owner_state",
    "sql": "CREATE TRIGGER analytics_cache_retention_date_cursor_owner_delete\nBEFORE DELETE ON analytics_owner_state\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END"
  }
] as const;
export const CACHE_DATE_CURSOR_CAPABILITY_SQL="(SELECT count(*) FROM sqlite_schema WHERE (type='table' AND name='analytics_cache_retention_date_cursor' AND tbl_name='analytics_cache_retention_date_cursor' AND sql='CREATE TABLE analytics_cache_retention_date_cursor (\n cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,\n source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),\n owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB ''*[^0-9a-f]*''),\n cycle_upper_day INTEGER NOT NULL CHECK(cycle_upper_day BETWEEN -719528 AND 2932896),\n next_day INTEGER NOT NULL CHECK(next_day BETWEEN -719528 AND 2932897),\n next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 0 AND 9007199254740991),\n day_slot_limit INTEGER NOT NULL CHECK(day_slot_limit BETWEEN 0 AND 9007199254740991),\n revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n UNIQUE(source_id,owner_digest),\n FOREIGN KEY(source_id,owner_digest) REFERENCES analytics_owner_state(source_id,owner_digest),\n CHECK(cursor_id BETWEEN 1 AND 9007199254740991),\n CHECK(next_day<=cycle_upper_day+1),\n CHECK(next_ordinal<=day_slot_limit),\n CHECK(day_slot_limit>0 OR next_ordinal=0),\n CHECK(next_day<=cycle_upper_day OR (next_ordinal=0 AND day_slot_limit=0))\n) STRICT') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_insert' AND tbl_name='analytics_cache_retention_date_cursor' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_insert\nBEFORE INSERT ON analytics_cache_retention_date_cursor\nWHEN NEW.revision!=1 OR NEW.next_ordinal!=0 OR NEW.day_slot_limit!=0\n OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id\n  WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state=''active'' AND r.contract_version=1\n  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))\nBEGIN SELECT RAISE(ABORT,''analytics_cache_date_cursor_conflict''); END') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_update' AND tbl_name='analytics_cache_retention_date_cursor' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_update\nBEFORE UPDATE ON analytics_cache_retention_date_cursor\nWHEN NEW.cursor_id!=OLD.cursor_id OR NEW.source_id!=OLD.source_id OR NEW.owner_digest!=OLD.owner_digest\n OR NEW.revision!=OLD.revision+1\n OR NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=NEW.source_id AND o.owner_digest=NEW.owner_digest AND o.state=''active''\n  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))\n OR NOT (\n  (OLD.next_day=OLD.cycle_upper_day+1 AND NEW.next_day<=NEW.cycle_upper_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)\n  OR (NEW.cycle_upper_day=OLD.cycle_upper_day AND OLD.next_day<=OLD.cycle_upper_day AND (\n   (NEW.next_day>OLD.next_day AND NEW.next_ordinal=0 AND NEW.day_slot_limit=0)\n   OR (NEW.next_day=OLD.next_day AND OLD.day_slot_limit>0 AND NEW.day_slot_limit=OLD.day_slot_limit AND NEW.next_ordinal>OLD.next_ordinal)\n   OR (NEW.next_day>=OLD.next_day AND OLD.day_slot_limit=0 AND NEW.day_slot_limit>0 AND NEW.next_ordinal>0)\n  ))\n )\nBEGIN SELECT RAISE(ABORT,''analytics_cache_date_cursor_conflict''); END') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_owner_terminal' AND tbl_name='analytics_owner_state' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_owner_terminal\nAFTER UPDATE OF state ON analytics_owner_state WHEN NEW.state!=''active''\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_erasure' AND tbl_name='analytics_storage_erasure_fences' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_erasure\nAFTER INSERT ON analytics_storage_erasure_fences\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_erasure_replay' AND tbl_name='analytics_storage_erasure_fences' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_erasure_replay\nAFTER UPDATE ON analytics_storage_erasure_fences\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=NEW.source_id AND owner_digest=NEW.owner_digest; END') OR\n (type='trigger' AND name='analytics_cache_retention_date_cursor_owner_delete' AND tbl_name='analytics_owner_state' AND sql='CREATE TRIGGER analytics_cache_retention_date_cursor_owner_delete\nBEFORE DELETE ON analytics_owner_state\nBEGIN DELETE FROM analytics_cache_retention_date_cursor WHERE source_id=OLD.source_id AND owner_digest=OLD.owner_digest; END'))=7\n AND NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE tbl_name='analytics_cache_retention_date_cursor' AND sql IS NOT NULL\n  AND name NOT IN('analytics_cache_retention_date_cursor','analytics_cache_retention_date_cursor_insert','analytics_cache_retention_date_cursor_update'))\n AND EXISTS(SELECT 1 FROM pragma_index_list('analytics_cache_retention_date_cursor') i WHERE i.\"unique\"=1 AND i.origin='u' AND i.partial=0\n  AND (SELECT group_concat(name,',') FROM(SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))='source_id,owner_digest')";
const PREDECESSOR_SCHEMA=[
  {
    "type": "table",
    "name": "analytics_v11_reusable_values",
    "sql": "CREATE TABLE analytics_v11_reusable_values (\n  value_key TEXT PRIMARY KEY CHECK(length(value_key)=64),\n  source_id TEXT NOT NULL,\n  source_layout TEXT NOT NULL CHECK(source_layout IN ('json-v11','typed-v11')),\n  source_namespace TEXT NOT NULL,\n  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),\n  device_id TEXT NOT NULL,\n  manifest_id TEXT NOT NULL,\n  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),\n  day TEXT NOT NULL,\n  schema_version TEXT NOT NULL,\n  pricing_method TEXT NOT NULL,\n  registry_sha256 TEXT NOT NULL CHECK(length(registry_sha256)=64),\n  record_count INTEGER NOT NULL CHECK(record_count>=0),\n  values_digest TEXT NOT NULL CHECK(length(values_digest)=64),\n  values_json TEXT NOT NULL CHECK(json_valid(values_json)),\n  CHECK((source_layout='json-v11' AND source_namespace='') OR (source_layout='typed-v11' AND length(source_namespace)>0)),\n  CHECK(json_extract(values_json,'$.day')=day AND json_extract(values_json,'$.schemaVersion')=schema_version\n    AND json_extract(values_json,'$.pricingMethodVersion')=pricing_method AND json_extract(values_json,'$.registrySha256')=registry_sha256\n    AND json_extract(values_json,'$.counts.usage')+json_extract(values_json,'$.counts.quota')+json_extract(values_json,'$.counts.session')=record_count),\n  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,schema_version,pricing_method,registry_sha256)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "analytics_v11_reusable_immutable",
    "sql": "CREATE TRIGGER analytics_v11_reusable_immutable BEFORE UPDATE ON analytics_v11_reusable_values\nWHEN OLD.value_key IS NOT NEW.value_key OR OLD.source_id IS NOT NEW.source_id OR OLD.source_layout IS NOT NEW.source_layout\n  OR OLD.source_namespace IS NOT NEW.source_namespace OR OLD.owner_digest IS NOT NEW.owner_digest OR OLD.device_id IS NOT NEW.device_id\n  OR OLD.manifest_id IS NOT NEW.manifest_id OR OLD.manifest_digest IS NOT NEW.manifest_digest OR OLD.day IS NOT NEW.day\n  OR OLD.schema_version IS NOT NEW.schema_version OR OLD.pricing_method IS NOT NEW.pricing_method OR OLD.registry_sha256 IS NOT NEW.registry_sha256\n  OR OLD.record_count IS NOT NEW.record_count OR OLD.values_digest IS NOT NEW.values_digest OR OLD.values_json IS NOT NEW.values_json\nBEGIN SELECT RAISE(ABORT,'analytics_v11_reusable_value_conflict'); END"
  },
  {
    "type": "table",
    "name": "analytics_v1_chunk_values",
    "sql": "CREATE TABLE analytics_v1_chunk_values (\n source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,slot_digest TEXT NOT NULL,\n namespace_digest TEXT NOT NULL,device_digest TEXT NOT NULL,chunk_digest TEXT NOT NULL,\n event_digest TEXT NOT NULL,content_digest TEXT NOT NULL,observed_day TEXT NOT NULL,\n chunk_revision INTEGER NOT NULL CHECK(chunk_revision>0),owner_revision INTEGER NOT NULL CHECK(owner_revision>0),\n values_json TEXT NOT NULL CHECK(json_valid(values_json)),\n PRIMARY KEY(source_id,owner_digest,slot_digest)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "analytics_v1_chunk_forward",
    "sql": "CREATE TRIGGER analytics_v1_chunk_forward BEFORE UPDATE ON analytics_v1_chunk_values\nWHEN NEW.source_id IS NOT OLD.source_id OR NEW.owner_digest IS NOT OLD.owner_digest\n OR NEW.slot_digest IS NOT OLD.slot_digest OR NEW.namespace_digest IS NOT OLD.namespace_digest\n OR NEW.device_digest IS NOT OLD.device_digest OR NEW.observed_day IS NOT OLD.observed_day\n OR NEW.chunk_revision<=OLD.chunk_revision OR NEW.owner_revision<=OLD.owner_revision\nBEGIN SELECT RAISE(ABORT,'analytics_v1_chunk_revision_conflict'); END"
  },
  {
    "type": "table",
    "name": "analytics_storage_erasure_fences",
    "sql": "CREATE TABLE analytics_storage_erasure_fences (\n source_id TEXT NOT NULL,owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64),\n terminal_event_digest TEXT NOT NULL CHECK(length(terminal_event_digest)=64),\n terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence>0),terminal_revision INTEGER NOT NULL CHECK(terminal_revision>0),\n authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch>0),\n PRIMARY KEY(source_id,owner_digest)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "analytics_storage_erasure_fence_immutable",
    "sql": "CREATE TRIGGER analytics_storage_erasure_fence_immutable BEFORE UPDATE ON analytics_storage_erasure_fences\nWHEN OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest\n OR OLD.terminal_event_digest IS NOT NEW.terminal_event_digest OR OLD.terminal_sequence IS NOT NEW.terminal_sequence\n OR OLD.terminal_revision IS NOT NEW.terminal_revision OR OLD.authority_epoch IS NOT NEW.authority_epoch\n OR OLD.public_authority_epoch IS NOT NEW.public_authority_epoch\nBEGIN SELECT RAISE(ABORT,'storage_erasure_fence_conflict'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_storage_erasure_fence_retained",
    "sql": "CREATE TRIGGER analytics_storage_erasure_fence_retained BEFORE DELETE ON analytics_storage_erasure_fences\nBEGIN SELECT RAISE(ABORT,'storage_erasure_fence_retained'); END"
  },
  {
    "type": "table",
    "name": "analytics_cache_retention_day_marks",
    "sql": "CREATE TABLE analytics_cache_retention_day_marks (\n  mark_key TEXT PRIMARY KEY CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),\n  source_id TEXT NOT NULL,\n  source_layout TEXT NOT NULL CHECK(source_layout IN ('typed-v11','typed-v1','effective')),\n  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),\n  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),\n  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),\n  manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),\n  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),\n  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),\n  method_version TEXT NOT NULL CHECK(method_version IN ('cache-retention-v2','cache-retention-v3')),\n  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),\n  carry_days INTEGER NOT NULL CHECK(carry_days>=0 AND carry_days<=31),\n  value_count INTEGER NOT NULL CHECK(value_count>=0 AND value_count<=4096),\n  events_read INTEGER NOT NULL CHECK(events_read>=0),\n  unreadable_events INTEGER NOT NULL CHECK(unreadable_events>=0 AND unreadable_events<=events_read),\n  values_digest TEXT NOT NULL CHECK(length(values_digest)=64 AND values_digest NOT GLOB '*[^0-9a-f]*'),\n  refusal TEXT CHECK(refusal IS NULL OR refusal IN ('group_limit_exceeded',\n    'session_limit_exceeded','usage_row_refused','day_page_limit_exceeded',\n    'checkpoint_size_exceeded')),\n  CHECK(refusal IS NULL OR (value_count=0 AND events_read=0 AND unreadable_events=0)),\n  CHECK(source_layout!='typed-v1' OR (device_id='v1-elected-at-read' AND manifest_id='v1-chunk-vector')),\n  CHECK(source_layout!='effective' OR (device_id='effective-owner' AND manifest_id='effective-owner-day')),\n  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,\n    manifest_digest,day,method_version,carry_digest),\n  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "index",
    "name": "analytics_cache_retention_day_owner",
    "sql": "CREATE INDEX analytics_cache_retention_day_owner\n  ON analytics_cache_retention_day_marks(source_id,owner_digest,day,method_version)"
  },
  {
    "type": "table",
    "name": "analytics_cache_retention_day_carry",
    "sql": "CREATE TABLE analytics_cache_retention_day_carry (\n  mark_key TEXT NOT NULL CHECK(length(mark_key)=64 AND mark_key NOT GLOB '*[^0-9a-f]*'),\n  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),\n  source_id TEXT NOT NULL,\n  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),\n  device_id TEXT NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),\n  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=0\n    OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),\n  PRIMARY KEY(mark_key,day)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "index",
    "name": "analytics_cache_retention_day_carry_owner",
    "sql": "CREATE INDEX analytics_cache_retention_day_carry_owner\n  ON analytics_cache_retention_day_carry(source_id,owner_digest,day,mark_key)"
  },
  {
    "type": "index",
    "name": "analytics_v11_reusable_owner_day",
    "sql": "CREATE INDEX analytics_v11_reusable_owner_day\n  ON analytics_v11_reusable_values(source_id,owner_digest,device_id,day,manifest_digest)"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_day_marks_immutable",
    "sql": "CREATE TRIGGER analytics_cache_retention_day_marks_immutable\nBEFORE UPDATE ON analytics_cache_retention_day_marks\nBEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_mark_conflict'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_day_carry_immutable",
    "sql": "CREATE TRIGGER analytics_cache_retention_day_carry_immutable\nBEFORE UPDATE ON analytics_cache_retention_day_carry\nWHEN EXISTS(SELECT 1 FROM analytics_cache_retention_day_marks m WHERE m.mark_key=OLD.mark_key)\n OR OLD.mark_key IS NOT NEW.mark_key OR OLD.day IS NOT NEW.day\n OR OLD.source_id IS NOT NEW.source_id OR OLD.owner_digest IS NOT NEW.owner_digest\n OR OLD.device_id IS NOT NEW.device_id\nBEGIN SELECT RAISE(ABORT,'analytics_cache_retention_day_carry_retained'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_day_marks_terminal_insert",
    "sql": "CREATE TRIGGER analytics_cache_retention_day_marks_terminal_insert\nBEFORE INSERT ON analytics_cache_retention_day_marks\nWHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f\n WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)\nBEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END"
  },
  {
    "type": "index",
    "name": "analytics_v1_chunk_day_revision",
    "sql": "CREATE INDEX analytics_v1_chunk_day_revision\n  ON analytics_v1_chunk_values(source_id,owner_digest,observed_day,owner_revision)"
  },
  {
    "type": "table",
    "name": "analytics_cache_retention_day_progress",
    "sql": "CREATE TABLE analytics_cache_retention_day_progress (\n  progress_key TEXT PRIMARY KEY CHECK(length(progress_key)=64 AND progress_key NOT GLOB '*[^0-9a-f]*'),\n  source_id TEXT NOT NULL,\n  source_layout TEXT NOT NULL CHECK(source_layout='effective'),\n  source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),\n  owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64 AND owner_digest NOT GLOB '*[^0-9a-f]*'),\n  device_id TEXT NOT NULL CHECK(device_id='effective-owner'),\n  manifest_id TEXT NOT NULL CHECK(manifest_id='effective-owner-day'),\n  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),\n  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),\n  method_version TEXT NOT NULL CHECK(method_version='cache-retention-v2'),\n  carry_digest TEXT NOT NULL CHECK(length(carry_digest)=64 AND carry_digest NOT GLOB '*[^0-9a-f]*'),\n  progress_revision INTEGER NOT NULL CHECK(progress_revision>=1),\n  state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=1900000),\n  state_digest TEXT NOT NULL CHECK(length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),\n  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id),\n  UNIQUE(source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,\n    manifest_digest,day,method_version,carry_digest)\n) STRICT, WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_day_progress_terminal_insert",
    "sql": "CREATE TRIGGER analytics_cache_retention_day_progress_terminal_insert\nBEFORE INSERT ON analytics_cache_retention_day_progress\nWHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f\n WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)\nBEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END"
  },
  {
    "type": "trigger",
    "name": "analytics_cache_retention_day_progress_terminal_update",
    "sql": "CREATE TRIGGER analytics_cache_retention_day_progress_terminal_update\nBEFORE UPDATE ON analytics_cache_retention_day_progress\nWHEN EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f\n WHERE f.source_id=NEW.source_id AND f.owner_digest=NEW.owner_digest)\n OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f\n WHERE f.source_id=OLD.source_id AND f.owner_digest=OLD.owner_digest)\nBEGIN SELECT RAISE(ABORT,'storage_owner_erased'); END"
  }
] as const;
const fail=()=>new Error('CACHE_RETENTION_DATE_CURSOR_UNAVAILABLE');
export const CACHE_DATE_MIN_DAY=-719528,CACHE_DATE_MAX_DAY=2932896;
export interface CacheDateCursor {cursor_id:number;cycle_upper_day:number;next_day:number;next_ordinal:number;day_slot_limit:number;revision:number}
export type CacheDateCoordinates=Pick<CacheDateCursor,'cycle_upper_day'|'next_day'|'next_ordinal'|'day_slot_limit'>;
const integer=(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function validCacheDateCursor(value:CacheDateCursor|null):value is CacheDateCursor {
 return value!==null&&integer(value.cursor_id,1)&&integer(value.revision,1)
  &&integer(value.cycle_upper_day,CACHE_DATE_MIN_DAY,CACHE_DATE_MAX_DAY)
  &&integer(value.next_day,CACHE_DATE_MIN_DAY,value.cycle_upper_day+1)
  &&integer(value.next_ordinal,0)&&integer(value.day_slot_limit,0)&&value.next_ordinal<=value.day_slot_limit
  &&(value.day_slot_limit>0||value.next_ordinal===0)
  &&(value.next_day<=value.cycle_upper_day||(value.next_ordinal===0&&value.day_slot_limit===0));
}
export function cacheDateKey(day:string):number {
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(day))throw fail();
 const time=Date.parse(day+'T00:00:00.000Z'),key=time/86400000;
 if(!integer(key,CACHE_DATE_MIN_DAY,CACHE_DATE_MAX_DAY)||new Date(time).toISOString().slice(0,10)!==day)throw fail();
 return key;
}
export function cacheDateLabel(key:number):string {
 if(!integer(key,CACHE_DATE_MIN_DAY,CACHE_DATE_MAX_DAY))throw fail();
 return new Date(key*86400000).toISOString().slice(0,10);
}
/** Accounting callback is private conservative dispatch accounting, not a meter
 * attestation. Every operation still invokes the exact passed, already wrapped
 * target statement. This facade is never captured by a source/build factory. */
export function cacheDateDispatchDatabase(db:D1Database,beforeDispatch:()=>void):D1Database {
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(value,key){
  if(key==='bind')return(...args:unknown[])=>wrap(value.bind(...args));
  if(key==='first'||key==='all'||key==='run'||key==='raw')return(...args:unknown[])=>{
   beforeDispatch();return Reflect.apply(Reflect.get(value,key),value,args);
  };
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
 }});
 return new Proxy(db,{get(value,key){
  if(key==='prepare')return(sql:string)=>wrap(value.prepare(sql));
  // These private helpers issue only prepared methods, never batch/session/exec.
  if(key==='batch'||key==='withSession'||key==='exec'||key==='dump')return()=>{throw fail();};
  const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
 }});
}
export async function cacheDateCursorInstalled(db:D1Database):Promise<boolean> {
 return await db.prepare(`SELECT CASE WHEN ${CACHE_DATE_CURSOR_CAPABILITY_SQL} THEN 1 ELSE 0 END ready`).first<number>('ready')===1;
}
export async function cacheDateCursorMode(db:D1Database):Promise<'installed'|'predecessor'|'unavailable'> {
 const state=await db.prepare(`SELECT CASE WHEN ${CACHE_DATE_CURSOR_CAPABILITY_SQL} THEN 1 ELSE 0 END ready,
  (SELECT count(*) FROM sqlite_schema WHERE name GLOB 'analytics_cache_retention_date_cursor*') installed`).first<{ready:number;installed:number}>();
 if(state?.ready===1)return 'installed';
 if(!state||state.installed!==0)return 'unavailable';
 if(await dailyOwnerCursorMode(db)!=='predecessor')return 'unavailable';
 const rows=(await db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE name IN(SELECT value FROM json_each(?))')
  .bind(JSON.stringify(PREDECESSOR_SCHEMA.map(row=>row.name))).all<{type:string;name:string;sql:string}>()).results;
 return rows.length===PREDECESSOR_SCHEMA.length&&PREDECESSOR_SCHEMA.every(expected=>rows.some(row=>row.type===expected.type&&row.name===expected.name&&row.sql===expected.sql))
  ?'predecessor':'unavailable';
}
export async function readCacheDateCursor(db:D1Database,sourceId:string,ownerDigest:string):Promise<CacheDateCursor|null>{
 const row=await db.prepare(`SELECT cursor_id,cycle_upper_day,next_day,next_ordinal,day_slot_limit,revision
  FROM ${CACHE_DATE_CURSOR_TABLE} WHERE source_id=? AND owner_digest=?`).bind(sourceId,ownerDigest).first<CacheDateCursor>();
 if(row!==null&&!validCacheDateCursor(row))throw fail();return row;
}
export async function initializeCacheDateCursor(db:D1Database,sourceId:string,ownerDigest:string,
 lower:number,upper:number):Promise<CacheDateCursor|null>{
 if(!integer(lower,CACHE_DATE_MIN_DAY,CACHE_DATE_MAX_DAY)||!integer(upper,lower,CACHE_DATE_MAX_DAY))throw fail();
 await db.prepare(`INSERT INTO ${CACHE_DATE_CURSOR_TABLE}
  (source_id,owner_digest,cycle_upper_day,next_day,next_ordinal,day_slot_limit,revision)
  SELECT ?,?,?,?,0,0,1 WHERE ${CACHE_DATE_CURSOR_CAPABILITY_SQL}
  ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(sourceId,ownerDigest,upper,lower).run();
 return readCacheDateCursor(db,sourceId,ownerDigest);
}
export async function advanceCacheDateCursor(db:D1Database,sourceId:string,ownerDigest:string,
 before:CacheDateCursor,after:CacheDateCoordinates):Promise<CacheDateCursor|null>{
 if(!validCacheDateCursor(before)||before.revision>=Number.MAX_SAFE_INTEGER
  ||!validCacheDateCursor({...after,cursor_id:before.cursor_id,revision:before.revision+1}))throw fail();
 const rows=(await db.prepare(`UPDATE ${CACHE_DATE_CURSOR_TABLE} SET cycle_upper_day=?3,next_day=?4,
  next_ordinal=?5,day_slot_limit=?6,revision=revision+1
  WHERE source_id=?1 AND owner_digest=?2 AND cursor_id=?7 AND revision=?8
  AND cycle_upper_day=?9 AND next_day=?10 AND next_ordinal=?11 AND day_slot_limit=?12
  AND ${CACHE_DATE_CURSOR_CAPABILITY_SQL}
  RETURNING cursor_id,cycle_upper_day,next_day,next_ordinal,day_slot_limit,revision`)
  .bind(sourceId,ownerDigest,after.cycle_upper_day,after.next_day,after.next_ordinal,after.day_slot_limit,
   before.cursor_id,before.revision,before.cycle_upper_day,before.next_day,before.next_ordinal,before.day_slot_limit)
  .all<CacheDateCursor>()).results;
 if(rows.length===0)return null;
 const row=rows[0];if(rows.length!==1||!row||!validCacheDateCursor(row)||row.cursor_id!==before.cursor_id||row.revision!==before.revision+1
  ||row.cycle_upper_day!==after.cycle_upper_day||row.next_day!==after.next_day||row.next_ordinal!==after.next_ordinal||row.day_slot_limit!==after.day_slot_limit)throw fail();
 return row;
}
export function cacheDateAfterAttempt(before:CacheDateCursor,day:number,slot:number,slotCount:number):CacheDateCoordinates {
 if(!validCacheDateCursor(before)||!integer(day,before.next_day,before.cycle_upper_day)||!integer(slot,0)
  ||!integer(slotCount,1)||slot>=slotCount)throw fail();
 const held=before.day_slot_limit===0?slotCount:before.day_slot_limit;
 if((before.day_slot_limit>0&&(day!==before.next_day||slot<before.next_ordinal))||slot>=held)throw fail();
 return slot+1>=held?{cycle_upper_day:before.cycle_upper_day,next_day:day+1,next_ordinal:0,day_slot_limit:0}
  :{cycle_upper_day:before.cycle_upper_day,next_day:day,next_ordinal:slot+1,day_slot_limit:held};
}
export async function retireCacheDateCursorPage(db:D1Database,sourceId:string):Promise<number>{
 const mode=await cacheDateCursorMode(db);if(mode==='predecessor')return 0;if(mode!=='installed')throw fail();
 const rows=(await db.prepare(`DELETE FROM ${CACHE_DATE_CURSOR_TABLE} WHERE cursor_id IN(
  SELECT c.cursor_id FROM ${CACHE_DATE_CURSOR_TABLE} c WHERE c.source_id=?1
  AND (NOT EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=c.source_id AND o.owner_digest=c.owner_digest AND o.state='active')
   OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=c.source_id AND f.owner_digest=c.owner_digest)
   OR (NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values v WHERE v.source_id=c.source_id AND v.owner_digest=c.owner_digest)
    AND NOT EXISTS(SELECT 1 FROM analytics_v1_chunk_values v WHERE v.source_id=c.source_id AND v.owner_digest=c.owner_digest)
    AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners d WHERE d.source_id=c.source_id AND d.owner_digest=c.owner_digest)))
  ORDER BY c.cursor_id LIMIT 16) AND ${CACHE_DATE_CURSOR_CAPABILITY_SQL} RETURNING cursor_id`).bind(sourceId).all<{cursor_id:number}>()).results;
 if(rows.length>16||rows.some(row=>!integer(row.cursor_id,1)))throw fail();return rows.length;
}
