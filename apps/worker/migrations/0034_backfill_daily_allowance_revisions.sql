-- One-time backfill for the additive community allowance block on the daily
-- aggregate payload (community-daily-aggregate-v1.0, additive field only —
-- no schema-version change, no table change).
--
-- The daily rebuild queue is populated by accepted v1 chunks, so already
-- published days would otherwise keep their pre-allowance payloads until new
-- data for that day happened to arrive. Re-enqueue every currently published
-- day once: the hourly cron republishes each as revision N+1 carrying the
-- allowance block, under the same immutable-revision model as any late-data
-- recomputation. Days with no published aggregate stay absent — this seeds
-- recomputation, never invents days.
INSERT INTO community_daily_aggregate_rebuilds (
  day, requested_epoch, requested_at
)
SELECT DISTINCT day,
       (
         SELECT mutation_epoch FROM community_snapshot_mutation_control
          WHERE singleton_id = 1
       ),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM community_daily_aggregates
 WHERE release_state = 'published'
ON CONFLICT(day) DO UPDATE SET
  requested_epoch = excluded.requested_epoch,
  requested_at = excluded.requested_at;
