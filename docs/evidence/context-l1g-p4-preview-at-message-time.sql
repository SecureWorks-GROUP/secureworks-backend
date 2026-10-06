-- p4-preview.sql: what switching context_unlinked_rules_v1 (P4) on would do, measured before the flip.
-- Revised for ladder L1g (20261006035000), 6 Oct 2026: not_live_job judges the job as it stood at the
-- message time (the ladder's own rule since P1a), not by its status today. A history-loaded message
-- placed on a job that was live when it was sent and was archived later is right, not a bad move
-- (6 Oct: the text naming invoice INV-0482 of SWP-26040, sent 2 Jun, job completed 3 Jun, archived
-- 10 Sep). The old test is still counted, as live_then_closed_since, so nothing is hidden. Terminal
-- time is the timeline's: the last move into a terminal status (job.status_changed), else
-- completed_at, else updated_at. Everything else is unchanged.
-- Written by cio-ctx-finish-plan, 5 Oct 2026. ONE statement, SELECT only, writes nothing.
-- Revised by cio-ctx-p4-fix, 5 Oct 2026, for ladder L1f (20261006003000):
--   * run it only after L1f is live: 'rules_ladder' must read L1f (the verdict refuses otherwise);
--   * not_live_job no longer counts a draft job (why: below);
--   * rule_counts_rules_on shows how often L1f's two rules fired (confirmed_custody, held_placement).
--
-- public.context_attribution_preview(id, rules_on) (20261002110000_context_unlinked_rules.sql:930-951) is STABLE and runs
-- the live ladder (now L1e, 20261005170000) in preview mode over a stored row; it returns
--   stored  {attribution_status, job_id, job_number, placement_rule, ...}  the row as it is now
--   decided {attribution_status, job_id, job_number, placement_rule, match_method, ...}  what the ladder would decide
-- It is called twice per row: rules on (P4) and rules off (today's live path), so "p4_changes_vs_today" is the flip's
-- own effect and "bad_moves" judges P4's decision against where the row sits now. The live ladder must be L1f
-- (20261006003000) or later: the rules-on body's comment starts 'L1f:'.
--
-- Rows judged (last 30 days, by recorded_at), sample sizes in the params row (halve them if it passes 60 s):
--   bucket   job_id null, status admin_bucket / unplaced / pending_luna / review   (what P4's bucket re-run re-decides)
--   placed   newest placed rows, plus each risky class topped up: no-words or automated rows with a job (F6), crew/staff
--            internal rows (metadata.audience internal, L1d), SMS-backfill rows (F5), contact-rule placements
--            (single_open / single_line / luna), rows whose writer named a job (source_job_binding or payload.job_id)
-- A bad move (any one makes the row bad):
--   leaves_job          the row is on a job now and P4 decides no job or a different job
--   not_writer_job      P4 places it on a job other than the one its writer named (source_job_binding.job_id, or
--                       payload.job_id when the writer did not call it a guess)
--   f6_custody_unlinked a no-words (empty) or automated row with a job ends with no job
--   f5_sms_guess        P4 places a row on the SMS-cache backfill's guessed payload job
--   internal_moved      a crew/staff internal row (metadata.audience internal) changes job
--   not_live_job        P4 places a row on a job it is not on now, and that job is not live
--                       (status cancelled, archived, complete, completed or lost)
--                       A draft is NOT counted (changed 5 Oct by cio-ctx-p4-fix): a draft is the job card a lead gets
--                       (ghl-webhook and ghl-proxy create_job insert jobs as draft; ensure_booking_draft_job,
--                       20260921140000), and both ladder paths admit a draft only when the customer has no other open
--                       job (context_contact_job_timeline: draft counts only with no non-draft candidate). A lead's
--                       text on its draft is on the right job; the bucket is where it is lost.
-- The desk flips the flag only if bad_moves = 0.

WITH params AS (SELECT 600 AS bucket_n, 300 AS placed_newest_n, 100 AS per_class_n),
base AS MATERIALIZED (
  SELECT e.id, e.source, e.event_type, e.job_id, e.attribution_status, e.recorded_at, e.metadata, e.payload,
         coalesce(e.event_at, e.occurred_at) AS msg_at
  FROM public.business_events e
  WHERE e.recorded_at > now() - interval '30 days'
),
pick AS MATERIALIZED (
  (SELECT id, 'bucket' AS grp FROM base
    WHERE job_id IS NULL AND attribution_status IN ('admin_bucket','unplaced','pending_luna','review')
    ORDER BY recorded_at DESC LIMIT (SELECT bucket_n FROM params))
  UNION
  (SELECT id, 'placed_newest' FROM base WHERE job_id IS NOT NULL ORDER BY recorded_at DESC LIMIT (SELECT placed_newest_n FROM params))
  UNION
  (SELECT id, 'placed_no_words_or_automated' FROM base WHERE job_id IS NOT NULL AND attribution_status IN ('empty','automated')
    ORDER BY recorded_at DESC LIMIT (SELECT per_class_n FROM params))
  UNION
  (SELECT id, 'placed_internal' FROM base WHERE job_id IS NOT NULL AND metadata->>'audience' = 'internal'
    ORDER BY recorded_at DESC LIMIT (SELECT per_class_n FROM params))
  UNION
  (SELECT id, 'sms_backfill' FROM base WHERE source = 'ghl_sms_cache_backfill' OR payload->>'source' = 'ghl_sms_cache_backfill'
    ORDER BY recorded_at DESC LIMIT (SELECT per_class_n FROM params))
  UNION
  (SELECT id, 'placed_contact_rule' FROM base WHERE job_id IS NOT NULL AND attribution_status IN ('single_open','single_line','luna')
    ORDER BY recorded_at DESC LIMIT (SELECT per_class_n FROM params))
  UNION
  (SELECT id, 'writer_named_job' FROM base WHERE metadata->'source_job_binding'->>'job_id' IS NOT NULL OR payload->>'job_id' IS NOT NULL
    ORDER BY recorded_at DESC LIMIT (SELECT per_class_n FROM params))
),
rows_ AS MATERIALIZED (   -- one row per event (a row can sit in several groups)
  SELECT p.id, array_agg(DISTINCT p.grp) AS groups FROM pick p GROUP BY p.id
),
pv AS MATERIALIZED (
  SELECT r.id, r.groups, b.source, b.event_type, b.metadata, b.payload, b.msg_at,
         public.context_attribution_preview(r.id, true)  AS p_on,
         public.context_attribution_preview(r.id, false) AS p_off
  FROM rows_ r JOIN base b ON b.id = r.id
),
judged AS (
  SELECT pv.id, pv.groups, pv.source, pv.event_type, pv.msg_at,
         pv.p_on->'stored'->>'attribution_status'  AS stored_status,
         (pv.p_on->'stored'->>'job_id')::uuid      AS stored_job,
         pv.p_on->'stored'->>'job_number'          AS stored_job_number,
         pv.p_on->'decided'->>'attribution_status' AS on_status,
         (pv.p_on->'decided'->>'job_id')::uuid     AS on_job,
         pv.p_on->'decided'->>'job_number'         AS on_job_number,
         pv.p_on->'decided'->>'placement_rule'     AS on_rule,
         pv.p_off->'decided'->>'attribution_status' AS off_status,
         (pv.p_off->'decided'->>'job_id')::uuid    AS off_job,
         pv.p_on->>'outcome' AS on_outcome,
         nullif(pv.p_on->'decided'->>'attribution_error','') AS on_error,
         coalesce((pv.metadata->'source_job_binding'->>'job_id'),
                  CASE WHEN pv.payload->>'job_id' IS NOT NULL
                        AND NOT (pv.source = 'ghl_sms_cache_backfill' OR pv.payload->>'source' = 'ghl_sms_cache_backfill'
                             OR (pv.payload#>>'{attribution_hint,job_id}' = pv.payload->>'job_id'
                                 AND coalesce(nullif(pv.payload#>>'{attribution_hint,match_method}',''),'none') NOT IN ('direct_job_id','direct_reference','manual')))
                       THEN pv.payload->>'job_id' END) AS writer_job_text,
         (pv.source = 'ghl_sms_cache_backfill' OR pv.payload->>'source' = 'ghl_sms_cache_backfill') AS sms_backfill,
         pv.metadata->>'audience' = 'internal' AS internal_row
  FROM pv
),
flagged AS (
  SELECT j.*,
    array_remove(ARRAY[
      CASE WHEN j.stored_job IS NOT NULL AND j.on_job IS DISTINCT FROM j.stored_job THEN 'leaves_job' END,
      CASE WHEN j.on_job IS NOT NULL AND j.writer_job_text IS NOT NULL AND j.on_job::text <> j.writer_job_text THEN 'not_writer_job' END,
      CASE WHEN j.stored_status IN ('empty','automated') AND j.stored_job IS NOT NULL AND j.on_job IS NULL THEN 'f6_custody_unlinked' END,
      CASE WHEN j.sms_backfill AND j.on_job IS NOT NULL AND j.on_job::text = j.payload_job_text AND j.on_job IS DISTINCT FROM j.stored_job THEN 'f5_sms_guess' END,
      CASE WHEN j.internal_row AND j.on_job IS DISTINCT FROM j.stored_job THEN 'internal_moved' END,
      CASE WHEN j.on_job IS NOT NULL AND j.on_job IS DISTINCT FROM j.stored_job AND jj.status::text IN ('cancelled','archived','complete','completed','lost')
            AND jt.finished_at <= j.msg_at THEN 'not_live_job' END
    ], NULL) AS reasons,
    (j.on_job IS NOT NULL AND j.on_job IS DISTINCT FROM j.stored_job AND jj.status::text IN ('cancelled','archived','complete','completed','lost')
     AND NOT (jt.finished_at <= j.msg_at)) AS live_then_closed_since
  FROM (SELECT judged.*, (SELECT b.payload->>'job_id' FROM base b WHERE b.id = judged.id) AS payload_job_text FROM judged) j
  LEFT JOIN public.jobs jj ON jj.id = j.on_job
  LEFT JOIN LATERAL (
    SELECT coalesce((SELECT min(coalesce(be.event_at, be.occurred_at)) FROM public.business_events be
                     WHERE be.entity_type = 'job' AND be.entity_id = jj.id::text AND be.event_type = 'job.status_changed'
                       AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
                       AND coalesce(be.event_at, be.occurred_at) > coalesce((
                         SELECT max(coalesce(nt.event_at, nt.occurred_at)) FROM public.business_events nt
                         WHERE nt.entity_type = 'job' AND nt.entity_id = jj.id::text AND nt.event_type = 'job.status_changed'
                           AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')),
                         '-infinity'::timestamptz)),
                    jj.completed_at, jj.updated_at, '-infinity'::timestamptz) AS finished_at
  ) jt ON jj.id IS NOT NULL
)
SELECT jsonb_build_object(
  'as_of', now(),
  'rules_ladder', left(coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),''),4),
  'flag_now', (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_unlinked_rules_v1'),
  'rows_judged', (SELECT count(*) FROM flagged),
  'rows_by_group', (SELECT jsonb_object_agg(g, n) FROM (SELECT unnest(groups) g, count(*) n FROM flagged GROUP BY 1) x),
  'preview_errors', (SELECT count(*) FROM flagged WHERE on_outcome IS DISTINCT FROM 'decided' OR on_error IS NOT NULL),
  'outcome_rules_on', (SELECT jsonb_agg(jsonb_build_object('stored',stored_status,'decided',on_status,'rule',on_rule,'job',job_change,'n',n) ORDER BY n DESC)
                       FROM (SELECT stored_status, on_status, on_rule,
                                    CASE WHEN on_job IS NULL THEN 'none' WHEN on_job = stored_job THEN 'same' WHEN stored_job IS NULL THEN 'new' ELSE 'other' END AS job_change,
                                    count(*) n
                             FROM flagged GROUP BY 1,2,3,4) z0),
  'p4_changes_vs_today', (SELECT jsonb_build_object(
        'job_differs', count(*) FILTER (WHERE on_job IS DISTINCT FROM off_job),
        'status_differs', count(*) FILTER (WHERE on_status IS DISTINCT FROM off_status),
        'newly_placed_from_bucket', count(*) FILTER (WHERE stored_job IS NULL AND on_job IS NOT NULL),
        'bucket_still_unplaced', count(*) FILTER (WHERE stored_job IS NULL AND on_job IS NULL))
      FROM flagged),
  'rule_counts_rules_on', (SELECT jsonb_build_object(
        'confirmed_custody', count(*) FILTER (WHERE on_rule = 'confirmed_custody'),
        'held_placement', count(*) FILTER (WHERE on_rule = 'held_placement'),
        'placed_on_draft', count(*) FILTER (WHERE on_job IS NOT NULL AND on_job IS DISTINCT FROM stored_job
                                             AND (SELECT j2.status::text FROM public.jobs j2 WHERE j2.id = on_job) = 'draft'))
      FROM flagged),
  'bad_moves', (SELECT count(*) FROM flagged WHERE cardinality(reasons) > 0),
  'live_then_closed_since', (SELECT count(*) FROM flagged WHERE live_then_closed_since),
  'bad_moves_by_reason', (SELECT jsonb_object_agg(r, n) FROM (SELECT unnest(reasons) r, count(*) n FROM flagged GROUP BY 1) y),
  'bad_sample', (SELECT jsonb_agg(s) FROM (
      SELECT jsonb_build_object('id', id, 'source', source, 'event_type', event_type, 'groups', groups,
             'stored', stored_status || ' ' || coalesce(stored_job_number, '-'),
             'rules_on', on_status || ' ' || coalesce(on_job_number, '-') || ' (' || coalesce(on_rule, '-') || ')',
             'rules_off_job_same_as_now', off_job IS NOT DISTINCT FROM stored_job,
             'reasons', reasons) s
      FROM flagged WHERE cardinality(reasons) > 0 ORDER BY id LIMIT 30) w),
  'verdict', CASE WHEN coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') !~ '^L1[f-z]:'
                  THEN 'do NOT flip: ladder L1f or later is not live yet; re-run after it deploys'
                  WHEN (SELECT count(*) FROM flagged WHERE cardinality(reasons) > 0) = 0
                   AND (SELECT count(*) FROM flagged WHERE on_outcome IS DISTINCT FROM 'decided' OR on_error IS NOT NULL) = 0
                  THEN 'flip allowed: 0 bad moves, 0 preview errors in the sample'
                  ELSE 'do NOT flip: see bad_moves_by_reason and bad_sample' END
) AS p4_preview;
