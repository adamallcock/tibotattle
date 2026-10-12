/** Queue entries and method-transition refreshes are one set of pending days.
 * The latter do not revoke the last-good public snapshot while it is rebuilt.
 * Keep this SQL independent of the daily publisher so status readers do not
 * initialize the publisher through a circular import. */
export const STORAGE_DAILY_PENDING_DAYS_SQL=`SELECT day FROM analytics_community_daily_queue WHERE source_id=?1
  UNION SELECT h.day FROM analytics_community_daily_heads h
  JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
  WHERE h.source_id=?1 AND COALESCE(json_extract(p.authority_json,'$.usageCorrectionState'),'staged') IS NOT ?2`;
