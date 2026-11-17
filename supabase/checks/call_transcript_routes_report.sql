-- Switch the pay per use route off (flag `evidence_transcript_capture` off; recordings keep being stored under `evidence_audio_capture`) only when, over the 7 days: `route2_only` is 0; `neither_but_recorded` is 0 or every one is named with its reason; and of the 20 pairs a person read, none is `route2_better_changes_meaning`. Otherwise it stays on and goes to the owner as a named exception to subscriptions only. After a switch off, run this report again 7 days later: `neither_but_recorded` must still be 0, and if it is not, the flag goes back on the same day.
-- P4-08.8. Director-run read only, no transcript words or contact details.
-- Seven full Perth days, excluding today. Arrival is observed up to this read.
-- Existing index paths: idx_events_occurred for the bounded call window,
-- idx_events_type for paid transcript rows, call_transcript_fetches_pkey for
-- call ids, business_events_pkey for fetch event ids. No new index is installed.
-- The director checks EXPLAIN on the copy before the live read; index use and
-- production wall time have not been observed by the builder.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH RECURSIVE
bounds AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Australia/Perth')
            AT TIME ZONE 'Australia/Perth') AS until_at
),
call_rows AS MATERIALIZED (
  SELECT e.id, e.contact_id, e.occurred_at,
    array_remove(ARRAY[
      nullif(regexp_replace(e.provider_message_id, '^ghl:', ''), ''),
      nullif(e.payload->>'ghl_call_id', ''), nullif(e.source_id, '')
    ], NULL) AS keys,
    nullif(e.payload->>'recording_url', '') IS NOT NULL AS recorded,
    CASE WHEN e.payload->>'duration_seconds' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (e.payload->>'duration_seconds')::numeric
      WHEN e.payload->>'duration' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (e.payload->>'duration')::numeric END AS seconds
  FROM public.business_events e CROSS JOIN bounds b
  WHERE e.event_type IN ('client.call_logged', 'client.call_initiated', 'client.call_complete')
    AND e.occurred_at >= b.until_at - interval '7 days'
    AND e.occurred_at < b.until_at
),
id_edges AS MATERIALIZED (
  SELECT a.id AS a, b.id AS b
  FROM call_rows a JOIN call_rows b ON a.id <> b.id AND a.keys && b.keys
),
-- Prefer call ids. Contact/time is the specified fallback only for a row
-- without an id join, never a replacement for an established id match.
edges AS MATERIALIZED (
  SELECT a, b FROM id_edges
  UNION
  SELECT a.id, b.id
  FROM call_rows a JOIN call_rows b ON a.id <> b.id
    AND a.contact_id = b.contact_id
    AND b.occurred_at BETWEEN a.occurred_at - interval '15 minutes'
                          AND a.occurred_at + interval '15 minutes'
  WHERE NOT EXISTS (SELECT 1 FROM id_edges x WHERE x.a = a.id)
     OR NOT EXISTS (SELECT 1 FROM id_edges x WHERE x.a = b.id)
),
reach (start_id, member_id) AS (
  SELECT id, id FROM call_rows
  UNION
  SELECT r.start_id, e.b FROM reach r JOIN edges e ON e.a = r.member_id
),
membership AS MATERIALIZED (
  SELECT member_id, min(start_id::text) AS group_id FROM reach GROUP BY member_id
),
calls AS MATERIALIZED (
  SELECT m.group_id, min(c.occurred_at) AS call_at,
    bool_or(c.recorded) AS recorded, max(c.seconds) AS seconds,
    coalesce(min(c.keys[1] COLLATE "C"), m.group_id) AS call_id
  FROM membership m JOIN call_rows c ON c.id = m.member_id
  GROUP BY m.group_id
),
call_keys AS MATERIALIZED (
  SELECT DISTINCT m.group_id, k.key
  FROM membership m JOIN call_rows c ON c.id = m.member_id
  CROSS JOIN LATERAL unnest(c.keys) k(key)
),
route1 AS MATERIALIZED (
  SELECT DISTINCT m.group_id, f.call_message_id, f.outcome,
    coalesce(f.finished_at, f.updated_at) AS arrived_at
  FROM membership m
  JOIN call_rows c ON c.id = m.member_id
  JOIN public.call_transcript_fetches f ON f.call_message_id = ANY(c.keys)
  UNION
  SELECT DISTINCT m.group_id, f.call_message_id, f.outcome,
    coalesce(f.finished_at, f.updated_at)
  FROM public.call_transcript_fetches f
  JOIN membership m ON m.member_id = f.call_event_id
),
paid_rows AS MATERIALIZED (
  SELECT e.id, e.contact_id, e.occurred_at,
    array_remove(ARRAY[nullif(e.source_id, ''), nullif(e.payload->>'ghl_call_id', ''),
      nullif(regexp_replace(e.provider_message_id, '^ghl:', ''), '')], NULL) AS keys
  FROM public.business_events e CROSS JOIN bounds b
  WHERE e.event_type IN ('call.transcribed', 'call.transcript_completed')
    AND e.occurred_at >= b.until_at - interval '7 days' - interval '15 minutes'
    AND e.occurred_at <= now()
),
paid_id_matches AS MATERIALIZED (
  SELECT DISTINCT k.group_id, p.id
  FROM paid_rows p JOIN call_keys k ON k.key = ANY(p.keys)
),
route2 AS MATERIALIZED (
  SELECT group_id, id FROM paid_id_matches
  UNION
  SELECT DISTINCT m.group_id, p.id
  FROM paid_rows p JOIN call_rows c ON p.contact_id = c.contact_id
    AND p.occurred_at BETWEEN c.occurred_at - interval '15 minutes'
                          AND c.occurred_at + interval '15 minutes'
  JOIN membership m ON m.member_id = c.id
  WHERE NOT EXISTS (SELECT 1 FROM paid_id_matches x WHERE x.id = p.id)
),
measured AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM route1 r WHERE r.group_id=c.group_id AND r.outcome='saved') AS r1,
    EXISTS (SELECT 1 FROM route1 r WHERE r.group_id=c.group_id AND r.outcome='not_returned') AS r1_not_returned,
    EXISTS (SELECT 1 FROM route1 r WHERE r.group_id=c.group_id AND r.outcome='failed') AS r1_failed,
    EXISTS (SELECT 1 FROM route1 r WHERE r.group_id=c.group_id AND r.outcome='pending') AS r1_pending,
    EXISTS (SELECT 1 FROM route1 r WHERE r.group_id=c.group_id AND r.outcome='not_expected') AS r1_not_expected,
    EXISTS (SELECT 1 FROM route2 r WHERE r.group_id=c.group_id) AS r2,
    (SELECT min(r.arrived_at) FROM route1 r
     WHERE r.group_id=c.group_id AND r.outcome='saved') > c.call_at + interval '2 hours' AS r1_late
  FROM calls c
)
SELECT
  (SELECT until_at - interval '7 days' FROM bounds) AS window_from,
  (SELECT until_at FROM bounds) AS window_until,
  count(*) AS calls,
  count(*) FILTER (WHERE recorded) AS with_recording,
  count(*) FILTER (WHERE r1) AS route1_saved,
  count(*) FILTER (WHERE r1_not_returned) AS route1_not_returned,
  count(*) FILTER (WHERE r1_failed) AS route1_failed,
  count(*) FILTER (WHERE r1_pending) AS route1_pending,
  count(*) FILTER (WHERE r1_not_expected) AS route1_not_expected,
  count(*) FILTER (WHERE r2) AS route2_saved,
  count(*) FILTER (WHERE r1 AND r2) AS both,
  count(*) FILTER (WHERE r1 AND NOT r2) AS route1_only,
  count(*) FILTER (WHERE r2 AND NOT r1) AS route2_only,
  count(*) FILTER (WHERE recorded AND NOT r1 AND NOT r2) AS neither_but_recorded,
  count(*) FILTER (WHERE r1 AND r2 AND r1_late) AS route1_late_over_2h,
  coalesce(jsonb_agg(jsonb_build_object(
    'call_id', call_id, 'day', (call_at AT TIME ZONE 'Australia/Perth')::date,
    'seconds', seconds
  ) ORDER BY call_at, call_id COLLATE "C") FILTER (WHERE r2 AND NOT r1), '[]'::jsonb) AS route2_only_calls
FROM measured;

ROLLBACK;
