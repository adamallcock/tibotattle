-- Existing content-free quota pseudonyms preserve exact native prepared rows.
-- Arbitrary admitted source labels are never retained in this field.
ALTER TABLE analytics_canonical_facts ADD COLUMN native_quota_occurrence_id TEXT
 CHECK(native_quota_occurrence_id IS NULL OR (stream='quota' AND status='compatible'
 AND substr(native_quota_occurrence_id,1,20)='quota-occurrence:v1:'
 AND length(native_quota_occurrence_id)=84 AND substr(native_quota_occurrence_id,21) NOT GLOB '*[^a-f0-9]*'));
