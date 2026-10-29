-- The job picture asked for one message (TP-04, slice 3), 29 Oct 2026.
-- Plan: 08-path-to-trusted-profit §4A-1. Follows 20261029200000 (slice 1).
--
-- The message placer (jarvis luna-attribution-candidates.ts, slice 2) reads the
-- shared job picture with no contact keys, because it has no TypeScript twin of
-- the sender rule and a second rule there would drift from it. So it never
-- learns whether the customer's phone or email is on a candidate job.
--
-- 1. context_job_picture_for_event(event_id, job_ids): read only, SECURITY
--    DEFINER, service role only. Reads that one business_events row, takes its
--    sender's keys from the one sender rule, context_event_identity(e) (B0,
--    widened by unplaced stage 1; never a second rule), and returns
--    context_job_picture(job_ids, [phone_key], [email_key]) unchanged.
--      A key the rule gives no value for is not asked, so the picture claims no
--      match for it (contacts.phone_match / email_match absent, not false). The
--      rule gives none for our own rows, supplier, council and platform rows,
--      and (B0) outbound rows; since stage 1 an outbound row reads its one
--      customer recipient, never our own addresses or numbers.
--      An unknown event id, or a null one, is treated as a row with no keys:
--      the picture comes back with no match claimed, never an error, so a
--      missing row can never turn into a yes.
--    The answer is the picture itself: no phone, no email and no figure leaves
--    this function (INT-01). The sender's keys are used inside it only.
--
-- Not here: any change to context_job_picture (its body stays 20261029200000's,
-- pinned by that migration's own guards), to context_event_identity, or any
-- write. The ladder and the Luna guard are untouched.
--
-- Columns were checked against the migrations in this repository, not the live
-- schema. The version was checked against supabase/migrations only, not the
-- live ledger.
--
-- Rollback: supabase/rollbacks/20261029220000_context_job_picture_for_event_down.sql

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read the live definitions before creating anything. Reports every
--    problem at once.
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE problems text[] := '{}'; live text; f text;
BEGIN
 -- Read, never replaced. Only their presence is checked: their bodies belong
 -- to other slices and may move on.
 FOREACH f IN ARRAY ARRAY['public.context_job_picture(uuid[],text[],text[])',
   'public.context_event_identity(public.business_events)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.business_events')
   AND a.attname = 'id' AND NOT a.attisdropped) THEN
  problems := problems || 'public.business_events.id missing'::text;
 END IF;
 -- The new function: absent (first apply), or this migration's exact body (a
 -- re-apply). Its comment is no proof: a later body may keep it.
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_picture_for_event(uuid,uuid[])');
 IF live IS NOT NULL AND live <> '449f66a1cf7885f3cc5aea94beac36cb' THEN
  problems := problems || format('%s md5 %s', 'public.context_job_picture_for_event(uuid,uuid[])', live);
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_picture_for_event_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The picture for one message
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.context_job_picture_for_event(p_event_id uuid, p_job_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- The sender's keys come from the one sender rule. No row, or no key, asks
  -- nothing: the picture then claims no match.
  SELECT public.context_job_picture(p_job_ids,
           CASE WHEN k.phone_key IS NOT NULL THEN ARRAY[k.phone_key] END,
           CASE WHEN k.email_key IS NOT NULL THEN ARRAY[k.email_key] END)
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT i.phone_key, i.email_key
                         FROM public.business_events e
                        CROSS JOIN LATERAL public.context_event_identity(e) i
                        WHERE e.id = p_event_id) k ON true
$$;
COMMENT ON FUNCTION public.context_job_picture_for_event(uuid, uuid[]) IS
  'Job picture for an event (20261029220000): TP-04 slice 3. context_job_picture(job_ids) asked with the one business_events row''s sender keys as context_event_identity(e) reads them (never a second sender rule), so contacts.phone_match / email_match answer only for a key that rule gives; our own, supplier, council and platform rows give none and claim no match. An unknown or null event claims no match. Returns the picture only: no phone, email or figure. Read only, service role only.';
REVOKE ALL ON FUNCTION public.context_job_picture_for_event(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_picture_for_event(uuid, uuid[]) TO service_role;
