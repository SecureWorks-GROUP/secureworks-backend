-- M0 · U4 — Sales scoreboard views (D10 as code) + U4b flag
--   (DRAFT — do not apply without Marnin's go)
--
-- Mission: sales-m0-data-truth-2026-07-05 (Lane B / U4 + U4b). Contract §3.
-- Plain-English counting rules this encodes 1:1: docs/sales-scoreboard/D10-definitions.md
--
-- Ordering: MUST run after 20260705000100 (U2) — the episode view reads
-- jobs.first_contacted_at / first_contact_channel / first_contact_direction /
-- lead_source added there. Timestamp 000600 keeps it after U2 (and after any
-- U3/U9 migrations in 000200–000500).
--
-- Everything here is additive and read-only at the data level: one nullable-safe
-- boolean column (default false), one OFF feature flag, and three VIEWS. No data
-- is written or changed. Views use security_invoker so they never escalate past
-- the caller's RLS (the manager cockpit reads them via the service role).
--
-- Grounding (live prod introspection 2026-07-05):
--   sales verticals = jobs.type in ('fencing','patio','decking'); makesafe excluded.
--   business_events.direction domain: inbound / outbound / internal / NULL.
--   quote sends are business_events event_type='quote.sent' (no quotes table).
--   'sales_scope' is disjoint from ops' 'scope' (reporting-api:3187/3195/3394).
--   won = jobs.accepted_at; lost = lost_reasons.created_at (+ reason_code enum).
--   smart_nudges: acted nudges carry acted_at but often NO sent_at, so compliance
--     is anchored on created_at (the raised date), not sent_at.

BEGIN;

-- ── Test-row exclusion column (U4 owns creation; U7 populates, never deletes) ──
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.jobs.is_test IS
  'M0/U4: flags a test/synthetic job so the sales scoreboard views exclude it. U7 populates known test rows (UPDATE only, never DELETE). Default false.';

-- ── U4b kill-switch (default OFF) ─────────────────────────────────────────────
-- Gate for stamping smart_nudges.acted_at from the proposed-action send surface.
-- sw_act_nudge already stamps acted_at directly (ops-api actNudge) and is not gated.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES (
  'nudge_acted_from_proposed_v1',
  false,
  'M0/U4b: when a proposed action is sent for a job, also mark that job''s pending smart_nudges acted (acted_at). OFF until Marnin approves. sw_act_nudge stamps acted_at independently of this flag.'
)
ON CONFLICT (flag_name) DO NOTHING;

-- ── View 1 · Episode grain ────────────────────────────────────────────────────
-- One row per sales-vertical lead episode (== job), test rows excluded, carrying
-- every funnel fact.
CREATE OR REPLACE VIEW public.sales_scoreboard_episode
WITH (security_invoker = true) AS
SELECT
  j.id                              AS job_id,
  j.org_id,
  j.type                            AS job_type,
  j.created_at                      AS lead_in_at,
  -- Per-episode first touch (U2)
  j.first_contacted_at,
  j.first_contact_channel,
  j.first_contact_direction,
  j.lead_source,
  -- Speed-to-lead: minutes from the episode's inbound first touch (U2's
  -- first_contacted_at, which is episode-scoped) to our first outbound reply
  -- at or after it. Only for inbound-first episodes (where a response time is
  -- meaningful); NULL when we reached out first or have not replied yet.
  CASE
    WHEN j.first_contact_direction = 'inbound' AND j.first_contacted_at IS NOT NULL THEN
      EXTRACT(EPOCH FROM (
        (SELECT min(be.occurred_at)
           FROM public.business_events be
          WHERE be.job_id = j.id
            AND be.direction = 'outbound'
            AND be.occurred_at >= j.first_contacted_at)
        - j.first_contacted_at)) / 60.0
  END                               AS speed_to_lead_minutes,
  -- Scoped: first sales_scope visit date (U3 writes these rows going forward)
  sc.scoped_at,
  (sc.scoped_at IS NOT NULL)        AS is_scoped,
  -- Quoted-from-site: explicit proof flag only (U3 writes payload.from_site)
  fs.quoted_from_site_at,
  (fs.quoted_from_site_at IS NOT NULL) AS is_quoted_from_site,
  fs.from_site_evidence,
  -- Won / Lost
  j.accepted_at                     AS won_at,
  (j.accepted_at IS NOT NULL)       AS is_won,
  lr.lost_at,
  lr.lost_reason_code,
  (lr.lost_at IS NOT NULL)          AS is_lost,
  -- Follow-up nudges for this episode (compliance rolls up in the weekly view).
  -- Raised = every nudge for the job; acted = acted_at set (sent_at is unreliable).
  nu.nudges_raised,
  nu.nudges_acted
FROM public.jobs j
LEFT JOIN LATERAL (
  SELECT min(ja.scheduled_date) AS scoped_at
    FROM public.job_assignments ja
   WHERE ja.job_id = j.id AND ja.assignment_type = 'sales_scope'
) sc ON true
LEFT JOIN LATERAL (
  SELECT min(be.occurred_at) AS quoted_from_site_at,
         (array_agg(be.payload -> 'from_site_evidence' ORDER BY be.occurred_at DESC))[1] AS from_site_evidence
    FROM public.business_events be
   WHERE be.job_id = j.id
     AND be.event_type = 'quote.sent'
     AND be.payload ->> 'from_site' = 'true'
) fs ON true
LEFT JOIN LATERAL (
  SELECT min(l.created_at) AS lost_at,
         (array_agg(l.reason_code ORDER BY l.created_at DESC))[1] AS lost_reason_code
    FROM public.lost_reasons l
   WHERE l.job_id = j.id
) lr ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS nudges_raised,
         count(*) FILTER (WHERE n.acted_at IS NOT NULL) AS nudges_acted
    FROM public.smart_nudges n
   WHERE n.job_id = j.id
) nu ON true
WHERE j.type IN ('fencing', 'patio', 'decking')
  AND COALESCE(j.is_test, false) = false;

COMMENT ON VIEW public.sales_scoreboard_episode IS
  'M0/U4: one row per sales lead episode (job) with the full D10 funnel. Jobs-only — pre-job leads (~59%) are not represented until GHL opportunity ingestion (M2). See docs/sales-scoreboard/D10-definitions.md.';

-- ── View 2 · Weekly board (Monday-start weeks) ────────────────────────────────
-- Each metric counted by its own activity date within the week (this is a
-- "what happened this week" board, not a single-cohort conversion funnel).
CREATE OR REPLACE VIEW public.sales_scoreboard_weekly
WITH (security_invoker = true) AS
WITH e AS (SELECT * FROM public.sales_scoreboard_episode),
comp AS (
  SELECT date_trunc('week', n.created_at) AS week_start,
         count(*) AS followup_nudges_raised,
         count(*) FILTER (WHERE n.acted_at IS NOT NULL) AS followup_nudges_acted,
         count(*) FILTER (WHERE n.dismissed_at IS NOT NULL) AS followup_nudges_dismissed,
         round(100.0 * count(*) FILTER (WHERE n.acted_at IS NOT NULL)
               / nullif(count(*), 0), 1) AS followup_compliance_pct
    FROM public.smart_nudges n
    JOIN public.jobs j ON j.id = n.job_id
   WHERE j.type IN ('fencing', 'patio', 'decking')
     AND COALESCE(j.is_test, false) = false
   GROUP BY 1
),
weeks AS (
  SELECT date_trunc('week', lead_in_at)               AS week_start FROM e WHERE lead_in_at IS NOT NULL
  UNION SELECT date_trunc('week', first_contacted_at)             FROM e WHERE first_contacted_at IS NOT NULL
  UNION SELECT date_trunc('week', scoped_at::timestamptz)         FROM e WHERE scoped_at IS NOT NULL
  UNION SELECT date_trunc('week', quoted_from_site_at)            FROM e WHERE quoted_from_site_at IS NOT NULL
  UNION SELECT date_trunc('week', won_at)                         FROM e WHERE won_at IS NOT NULL
  UNION SELECT date_trunc('week', lost_at)                        FROM e WHERE lost_at IS NOT NULL
  UNION SELECT week_start FROM comp
),
leads AS (
  SELECT date_trunc('week', lead_in_at) AS week_start, count(*) AS leads_in
    FROM e WHERE lead_in_at IS NOT NULL GROUP BY 1
),
stl AS (
  SELECT date_trunc('week', first_contacted_at) AS week_start,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY speed_to_lead_minutes) AS median_speed_to_lead_minutes,
         count(*) FILTER (WHERE speed_to_lead_minutes IS NOT NULL) AS speed_to_lead_sample
    FROM e WHERE first_contacted_at IS NOT NULL GROUP BY 1
),
scoped AS (
  SELECT date_trunc('week', scoped_at::timestamptz) AS week_start, count(*) AS scoped
    FROM e WHERE scoped_at IS NOT NULL GROUP BY 1
),
qfs AS (
  SELECT date_trunc('week', quoted_from_site_at) AS week_start, count(*) AS quoted_from_site
    FROM e WHERE quoted_from_site_at IS NOT NULL GROUP BY 1
),
won AS (
  SELECT date_trunc('week', won_at) AS week_start, count(*) AS won
    FROM e WHERE won_at IS NOT NULL GROUP BY 1
),
lost AS (
  SELECT date_trunc('week', lost_at) AS week_start, count(*) AS lost
    FROM e WHERE lost_at IS NOT NULL GROUP BY 1
)
SELECT
  w.week_start,
  COALESCE(leads.leads_in, 0)                 AS leads_in,
  stl.median_speed_to_lead_minutes,
  COALESCE(stl.speed_to_lead_sample, 0)       AS speed_to_lead_sample,
  COALESCE(scoped.scoped, 0)                  AS scoped,
  COALESCE(qfs.quoted_from_site, 0)           AS quoted_from_site,
  COALESCE(won.won, 0)                        AS won,
  COALESCE(lost.lost, 0)                      AS lost,
  COALESCE(comp.followup_nudges_raised, 0)    AS followup_nudges_raised,
  COALESCE(comp.followup_nudges_acted, 0)     AS followup_nudges_acted,
  COALESCE(comp.followup_nudges_dismissed, 0) AS followup_nudges_dismissed,
  comp.followup_compliance_pct
FROM weeks w
LEFT JOIN leads  USING (week_start)
LEFT JOIN stl    USING (week_start)
LEFT JOIN scoped USING (week_start)
LEFT JOIN qfs    USING (week_start)
LEFT JOIN won    USING (week_start)
LEFT JOIN lost   USING (week_start)
LEFT JOIN comp   USING (week_start)
ORDER BY w.week_start DESC;

COMMENT ON VIEW public.sales_scoreboard_weekly IS
  'M0/U4: the weekly rep-meeting board. Each column counted by its own activity date within a Monday-start week. Compliance = acted / raised over job-linked sales-vertical nudges (M1 adds the one-tap loop that grows coverage).';

-- ── View 3 · Weekly lost-reason mix ───────────────────────────────────────────
CREATE OR REPLACE VIEW public.sales_scoreboard_lost_reasons_weekly
WITH (security_invoker = true) AS
SELECT date_trunc('week', l.created_at) AS week_start,
       l.reason_code,
       count(*) AS lost_count
  FROM public.lost_reasons l
  JOIN public.jobs j ON j.id = l.job_id
 WHERE j.type IN ('fencing', 'patio', 'decking')
   AND COALESCE(j.is_test, false) = false
 GROUP BY 1, 2
 ORDER BY 1 DESC, 3 DESC;

COMMENT ON VIEW public.sales_scoreboard_lost_reasons_weekly IS
  'M0/U4: lost-reason mix per Monday-start week over sales-vertical, non-test jobs.';

COMMIT;
