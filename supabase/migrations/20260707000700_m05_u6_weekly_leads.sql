-- M0.5 · U6 — Lead definition + weekly lead report (weekly_leads view)
--   (DRAFT — do not apply without Marnin's go; ships at CP3)
--
-- Mission: sales-m05-intake-repair-2026-07-07 (U6). Contract §3.
-- Plain-English counting rule this encodes 1:1:
--   coding/work/missions/sales-m05-intake-repair-2026-07-07/U6-lead-definition-addendum.md
--   (folds into docs/sales-scoreboard/D10-definitions.md at M0 CP4).
--
-- Ordering: MUST run AFTER 20260705000600_m0_u4_sales_scoreboard.sql — that migration
--   OWNS creation of jobs.is_test, which this view reads for job-level test exclusion.
--   Timestamp 20260707000700 keeps it after (and after 20260707000001 on main). If M0 U4
--   has not landed, this apply fails loudly on jobs.is_test — that is the intended
--   fail-safe (do not create the column here; M0 U4 owns it).
--
-- Everything here is additive and read-only: one VIEW, security_invoker so it never
-- escalates past the caller's RLS. It writes nothing and changes no data.
--
-- ── THE LEAD DEFINITION (contract §3 U6; GATE 1 Q4 answer = LAW) ──────────────────
-- A LEAD = the first-EVER qualifying inbound touch per contact, on the sales line-set
-- only, attributed to the week / channel / line of that first touch. One lead per
-- contact, for its whole life.
--
-- Qualifying inbound event types (business_events.event_type):
--   client.sms_in         channel sms   — dead since 2026-05-04; resumes after M0.5 U1b
--   client.call_complete  channel call, direction = 'inbound'
--   client.email_in       channel email
--   client.form_in        channel form  — DOES NOT EXIST YET (0 rows all-time);
--                                         pending M2 U5; carried as a structural 0 row.
--
-- Sales line-set (GATE 1 Q4: admin line 0489267776 EXCLUDED — ops only):
--   calls: payload->>'line_label' IN ('fencing' → +61489267772,
--                                     'patios'  → +61489267774).
--          EXCLUDES shaun-ops-mgr(+..771), admin(+..776), fencing-mgmt(+..778), null line.
--   sms  : inbound client SMS pipelines are fencing/patios by construction (both sales);
--          line derived from line_label (post-U1b envelope) else legacy 'pipeline'.
--   email: the SALES-INBOX allow-list below — SEEDED EMPTY / PARKED pending Marnin's
--          open Q4b ruling: which mirrored mailbox(es) count as "sales inboxes". The real
--          group inboxes fencing@ / patios@ do NOT mirror into business_events (M365
--          Groups, no delta feed); the only mirrored inboxes are personal (admin@ /
--          marnin@ / nithin@ / jan@ / shaun@) and inbound email is ~87% unmatched to a
--          contact. Until Q4b is answered the email channel counts 0 by construction
--          (no silent guess) and shows a "pending" marker row — same discipline as form.
--
-- Supplier senders EXCLUDED via the suppliers records (the named mechanism, not ad-hoc):
--   phone: last-9-digit match of the caller/sender number vs suppliers.phone.
--   email: FULL-address match vs suppliers.email, PLUS business-domain match — with
--          free-mail + our own domain BLOCKLISTED, because suppliers.email legitimately
--          holds 18 gmail.com / outlook.com / hotmail.com / bigpond.com / icloud.com /
--          example.com / secureworkswa.com.au addresses; a bare domain match on those
--          would delete real client leads.
--
-- Dedup key (one lead per contact): business_events.contact_id when matched, else a
--   channel-scoped sender identity (phone tail for call/sms, from-address for email).
--   Calls/SMS are ~100% contact-matched on live; email is not, so the sender-identity
--   fallback carries the email dedup once that channel is un-parked.
--
-- Test exclusion (M0 convention): event-level payload is_test = 'true', AND job-level
--   jobs.is_test (via job_id) — both, mirroring the M0 U4 scoreboard.
--
-- Weeks: ISO weeks (Monday-start), bucketed in Australia/Perth wall time so a Sunday-
--   evening Perth touch lands in the right local week. (Note: M0 U4's scoreboard buckets
--   in UTC; aligning both to Perth is proposed at the M0 CP4 fold — see addendum.)
--
-- NOTE ON GRAIN vs the M0 U4 scoreboard: this view counts FIRST INBOUND TOUCHES PER
--   CONTACT from business_events (the true top of funnel). sales_scoreboard_weekly.leads_in
--   counts JOBS (episodes) and by design cannot see the ~59% of enquiries that never
--   become a job. The two "leads" numbers measure different things on purpose.
--
-- Grounding (live read-only introspection 2026-07-07): event-type / channel / direction
--   domain, line_label → to-number map, mailbox set, suppliers identity coverage
--   (250 rows: 37 with email, 16 with phone) and the free-mail domains above.

BEGIN;

CREATE OR REPLACE VIEW public.weekly_leads
WITH (security_invoker = true) AS
WITH
-- Supplier identity sets (the named exclusion mechanism) ------------------------
sup_phone AS (
  SELECT DISTINCT right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) AS ptail
    FROM public.suppliers
   WHERE phone IS NOT NULL
     AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 8
),
sup_email_full AS (
  SELECT DISTINCT lower(email) AS e
    FROM public.suppliers
   WHERE email LIKE '%@%'
),
sup_email_domain AS (
  -- Domain match only for genuine business domains; free-mail + own domain excluded
  -- so a supplier who used gmail cannot wipe every gmail-using client lead.
  SELECT DISTINCT lower(split_part(email, '@', 2)) AS d
    FROM public.suppliers
   WHERE email LIKE '%@%'
     AND lower(split_part(email, '@', 2)) NOT IN (
       'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au',
       'bigpond.com', 'live.com', 'icloud.com', 'me.com', 'optusnet.com.au',
       'iinet.net.au', 'example.com', 'secureworkswa.com.au'
     )
),
-- SALES-INBOX allow-list — PARKED (empty) pending Marnin's open Q4b ruling. ------
-- To enable the email channel once ruled, add mailbox rows here, e.g.:
--   SELECT unnest(ARRAY['nithin@secureworkswa.com.au'])  -- patios estimator (recommended seed)
-- The map at line_label derivation below turns each mailbox into a line label.
sales_inbox(mailbox) AS (
  SELECT unnest(ARRAY[]::text[])
),
-- Unified qualifying inbound stream --------------------------------------------
qualifying AS (
  -- CALLS: sales lines only, inbound
  SELECT be.id,
         'call'::text                         AS channel,
         be.payload ->> 'line_label'          AS line_label,
         be.occurred_at,
         coalesce(be.contact_id::text,
                  'phone:' || right(regexp_replace(coalesce(be.payload ->> 'from', ''), '[^0-9]', '', 'g'), 9)) AS contact_key,
         right(regexp_replace(coalesce(be.payload ->> 'from', ''), '[^0-9]', '', 'g'), 9) AS phone_tail,
         NULL::text                           AS from_email,
         be.payload,
         be.job_id
    FROM public.business_events be
   WHERE be.event_type = 'client.call_complete'
     AND be.direction  = 'inbound'
     AND be.payload ->> 'line_label' IN ('fencing', 'patios')

  UNION ALL
  -- SMS: inbound client SMS (sales pipelines by construction). 0 rows until U1b.
  SELECT be.id,
         'sms'::text,
         coalesce(nullif(be.payload ->> 'line_label', ''),
                  CASE be.payload ->> 'pipeline' WHEN 'patio' THEN 'patios' ELSE be.payload ->> 'pipeline' END,
                  'unattributed'),
         be.occurred_at,
         coalesce(be.contact_id::text,
                  'phone:' || right(regexp_replace(coalesce(be.payload ->> 'phone', ''), '[^0-9]', '', 'g'), 9)),
         right(regexp_replace(coalesce(be.payload ->> 'phone', ''), '[^0-9]', '', 'g'), 9),
         NULL::text,
         be.payload,
         be.job_id
    FROM public.business_events be
   WHERE be.event_type = 'client.sms_in'

  UNION ALL
  -- EMAIL: only mailboxes on the (currently empty) sales-inbox allow-list.
  SELECT be.id,
         'email'::text,
         be.payload ->> 'mailbox',
         be.occurred_at,
         coalesce(be.contact_id::text, 'email:' || lower(be.payload ->> 'from')),
         NULL::text,
         lower(be.payload ->> 'from'),
         be.payload,
         be.job_id
    FROM public.business_events be
   WHERE be.event_type = 'client.email_in'
     AND be.payload ->> 'mailbox' IN (SELECT mailbox FROM sales_inbox)
),
-- Exclusions: test rows + supplier senders -------------------------------------
filtered AS (
  SELECT q.*
    FROM qualifying q
    LEFT JOIN public.jobs j ON j.id = q.job_id
   WHERE coalesce(q.payload ->> 'is_test', 'false') <> 'true'
     AND (q.job_id IS NULL OR NOT coalesce(j.is_test, false))
     AND NOT (q.phone_tail IS NOT NULL
              AND length(q.phone_tail) >= 8
              AND q.phone_tail IN (SELECT ptail FROM sup_phone))
     AND NOT (q.from_email IS NOT NULL
              AND (q.from_email IN (SELECT e FROM sup_email_full)
                   OR lower(split_part(q.from_email, '@', 2)) IN (SELECT d FROM sup_email_domain)))
),
-- First-EVER qualifying touch per contact (the dedup) --------------------------
first_touch AS (
  SELECT DISTINCT ON (contact_key)
         contact_key, channel, line_label, occurred_at
    FROM filtered
   ORDER BY contact_key, occurred_at ASC
),
lead_counts AS (
  SELECT date_trunc('week', occurred_at AT TIME ZONE 'Australia/Perth')::date AS week_start,
         channel, line_label, count(*) AS lead_count
    FROM first_touch
   GROUP BY 1, 2, 3
),
active_weeks AS (SELECT DISTINCT week_start FROM lead_counts),
-- Structural marker rows: keep the report shape stable across missions ---------
--   form: always a 0 row ("pending M2 U5") so the channel is never silently absent.
--   email: a 0 "pending" row only while the sales-inbox allow-list is empty; the
--          moment Q4b is ruled (allow-list non-empty), real email rows replace it.
markers AS (
  SELECT week_start, 'form'::text AS channel, 'pending M2 U5'::text AS line_label, 0 AS lead_count
    FROM active_weeks
  UNION ALL
  SELECT week_start, 'email'::text, 'pending sales-inbox ruling (Q4b)'::text, 0
    FROM active_weeks
   WHERE NOT EXISTS (SELECT 1 FROM sales_inbox)
)
SELECT u.week_start,
       extract(isoyear FROM u.week_start)::int AS iso_year,
       extract(week    FROM u.week_start)::int AS iso_week,
       u.channel,
       u.line_label,
       u.lead_count
  FROM (SELECT * FROM lead_counts UNION ALL SELECT * FROM markers) u
 ORDER BY u.week_start DESC, u.channel, u.line_label;

COMMENT ON VIEW public.weekly_leads IS
  'M0.5/U6: honest weekly lead count — first-ever qualifying inbound touch per contact '
  '(client.sms_in / inbound client.call_complete / client.email_in / client.form_in), on '
  'the sales line-set only (fencing + patios lines; admin line EXCLUDED per GATE 1 Q4), '
  'supplier senders excluded via suppliers records, test rows excluded, ISO week (Perth). '
  'channel x line_label x ISO week. sms currently 0 (dead until M0.5 U1b); email PARKED '
  'pending Marnin Q4b (sales-inbox allow-list empty; group inboxes do not mirror); form '
  'pending M2 U5. Different grain from sales_scoreboard_weekly.leads_in (which counts jobs). '
  'Rules 1:1 in U6-lead-definition-addendum.md (folds into D10 at M0 CP4).';

COMMIT;
