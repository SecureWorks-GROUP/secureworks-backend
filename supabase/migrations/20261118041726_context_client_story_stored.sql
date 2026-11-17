-- P0-01.3: stored phase/open-item summaries, preserving P0-01 saved text.
-- Inert on merge. The director installs only after job pages are filled and copy proof passes.
-- Main and live TSV agree on the saved-text pre-image ccce1009b2487423ce2a3425a190204f.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$
DECLARE h text;
/* guard block */ BEGIN
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure('public.context_client_story(uuid,timestamptz)');
 IF h IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' AND h IS DISTINCT FROM '976400ef0e8107bb1c558041bed16392' THEN
  RAISE EXCEPTION 'client_story_stored_preimage_changed';
 END IF;
END $guard$;
-- Save main word for word. Never replace it with an installed or hand-edited body.
DO $copy$
DECLARE d text;
/* copy block */ BEGIN
 IF to_regprocedure('public.context_client_story_saved_main(uuid,timestamptz)') IS NULL THEN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_client_story(uuid,timestamptz)'::regprocedure)
    IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' THEN RAISE EXCEPTION 'client_story_stored_backup_missing'; END IF;
  d:=pg_get_functiondef('public.context_client_story(uuid,timestamptz)'::regprocedure);
  EXECUTE replace(d,'public.context_client_story(', 'public.context_client_story_saved_main(');
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_client_story_saved_main(uuid,timestamptz)'::regprocedure)
   IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' THEN RAISE EXCEPTION 'client_story_stored_backup_changed'; END IF;
END $copy$;
CREATE OR REPLACE FUNCTION public.context_client_story_stored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH me AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS email
  FROM public.jobs jb WHERE jb.id = p_job_id
 ),
 ident AS (
  SELECT me.*, CASE WHEN me.contact IS NOT NULL THEN 'ghl_contact_id' WHEN me.email IS NOT NULL THEN 'client_email' END AS basis FROM me
 ),
 cj AS (  -- the client's jobs
  SELECT jb.id, jb.job_number, jb.type, jb.status::text AS status, jb.created_at,
         jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost') AS live,
         row_number() OVER (ORDER BY jb.created_at DESC, jb.id) AS n
  FROM ident i JOIN public.jobs jb
    ON (i.basis = 'ghl_contact_id' AND nullif(btrim(jb.ghl_contact_id), '') = i.contact)
    OR (i.basis = 'client_email' AND lower(nullif(btrim(jb.client_email), '')) = i.email)
  WHERE jb.created_at <= p_as_of
 ),
 -- (client story saved, 20261117090000) each job's saved story as it stood at p_as_of: the
 -- written story saved by then and not yet superseded then. No job story is built here (this
 -- read used to build a full story for each of the client's newest 20 jobs in one statement)
 sv AS (
  SELECT DISTINCT ON (t.job_id) t.job_id, t.sections ->> 'headline' AS headline, t.written_at, t.checked_at
  FROM public.context_job_story_texts t
  WHERE t.job_id IN (SELECT cj.id FROM cj) AND t.written_at <= p_as_of
    AND (t.superseded_at IS NULL OR t.superseded_at > p_as_of)
  ORDER BY t.job_id, t.written_at DESC, t.id
 ),
 -- P0-01.3: saved-text sv and its provenance remain unchanged. The newest 20
 -- additionally get phase/open items from a ready page, or a live historical story.
 st AS MATERIALIZED (
  SELECT cj.id,
   CASE WHEN p_as_of < now() - interval '10 minutes' THEN public.context_job_story(cj.id, p_as_of)
    ELSE (SELECT jsonb_build_object('loops',jp.page #> '{summary,loops}',
                 'now',jsonb_build_object('phase',jp.page #>> '{summary,phase}',
                                         'line',jp.page #>> '{summary,now_line}'))
          FROM public.job_pages jp WHERE jp.job_id=cj.id AND jp.status='ready') END AS s
  FROM cj WHERE cj.n<=20
 ),
 lp AS (
  SELECT cj.job_number,l AS loop FROM st JOIN cj ON cj.id=st.id,
   jsonb_array_elements(st.s->'loops') l
 ),
 mon AS (SELECT m.* FROM public.context_job_record_money((SELECT array_agg(cj.id) FROM cj), p_as_of) m),
 -- story safety (20261006040000), fourth review: each invoice owing on the client's jobs, and
 -- whether the client owes it: only an invoice addressed to them (payer role customer),
 -- never the builder's on builder work, a neighbour's or another payer's, which others owe
 mi AS (
  SELECT m.job_id, coalesce(i ->> 'payer_role' = 'customer', false) AS own, (i ->> 'owing')::numeric AS owing,
         CASE WHEN coalesce((i ->> 'overdue')::boolean, false) THEN (i ->> 'owing')::numeric ELSE 0 END AS overdue
  FROM mon m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND jsonb_typeof(i -> 'owing') = 'number'
 ),
 -- story safety (20261006040000): the client's own Xero contacts (on their private jobs:
 -- the job's own contact, the primary party's, or a job's only paying contact when it has
 -- neither; never a neighbour's, never on builder work, where the contact is the builder).
 -- A job's only paying contact is the client's own only when every invoice to it on that job
 -- names it as the client (name compared case and spacing aside) and it is billed on no
 -- builder work (make-safe, repair or insurance): a builder or insurer billed for a
 -- homeowner's private job is never the homeowner, so the builder's other jobs never become
 -- the homeowner's debt
 cxc AS (
  SELECT DISTINCT z.x FROM (
   SELECT nullif(btrim(jb.xero_contact_id), '') AS x FROM cj JOIN public.jobs jb ON jb.id = cj.id
   WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance')
   UNION ALL
   SELECT nullif(btrim(c.xero_contact_id), '') FROM cj JOIN public.jobs jb ON jb.id = cj.id JOIN public.job_contacts c ON c.job_id = cj.id
   WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance') AND c.removed_at IS NULL
     AND (coalesce(c.is_primary, false) OR coalesce(c.contact_type, '') = 'primary')
   UNION ALL
   SELECT o.x FROM (
    SELECT min(nullif(btrim(i.xero_contact_id), '')) AS x, count(DISTINCT nullif(btrim(i.xero_contact_id), '')) AS n,
           bool_and(nullif(btrim(jb.client_name), '') IS NOT NULL
                    AND lower(btrim(regexp_replace(coalesce(i.contact_name, ''), '\s+', ' ', 'g')))
                        = lower(btrim(regexp_replace(jb.client_name, '\s+', ' ', 'g')))) AS named_client
    FROM cj JOIN public.jobs jb ON jb.id = cj.id
    JOIN public.xero_invoices i ON i.job_id = cj.id AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC'
     AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
    WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance') AND nullif(btrim(jb.xero_contact_id), '') IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id = cj.id AND c.removed_at IS NULL)
    GROUP BY cj.id) o
   WHERE o.n = 1 AND coalesce(o.named_client, false)
     AND NOT EXISTS (SELECT 1 FROM public.xero_invoices b JOIN public.jobs bj ON bj.id = b.job_id
                     WHERE btrim(b.xero_contact_id) = o.x AND bj.type::text IN ('makesafe', 'repair', 'insurance'))
  ) z WHERE z.x IS NOT NULL
 ),
 -- what that Xero contact still owes on other clients' jobs (a payer on someone else's job,
 -- as a neighbour): the client's money includes it, each job named. Only invoices still
 -- owing (a paid one is no debt, so it names no job), and never on builder work, where every
 -- invoice is the builder's
 xo AS (
  SELECT i.job_id, jb.job_number, nullif(btrim(i.xero_contact_id), '') AS xero_contact_id, i.contact_name AS party,
         sum(coalesce(i.amount_due, 0)) AS owing,
         sum(CASE WHEN i.due_date < (p_as_of AT TIME ZONE 'Australia/Perth')::date THEN coalesce(i.amount_due, 0) ELSE 0 END) AS overdue,
         jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i.id) ORDER BY i.invoice_date NULLS LAST, i.id) AS cites
  FROM public.xero_invoices i JOIN public.jobs jb ON jb.id = i.job_id
  WHERE nullif(btrim(i.xero_contact_id), '') IN (SELECT cxc.x FROM cxc) AND NOT (i.job_id IN (SELECT cj.id FROM cj))
    AND jb.type::text NOT IN ('makesafe', 'repair', 'insurance')
    AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(i.amount_due, 0) > 0
    AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
  GROUP BY i.job_id, jb.job_number, nullif(btrim(i.xero_contact_id), ''), i.contact_name
 ),
 -- (story safety, sixth review) and what that Xero contact still owes on invoices placed on no
 -- job (bda6e1de's INV-0290: the rest of its quote, billed to the client's own contact and never
 -- placed on the job): the client's debt all the same, in owing and overdue, listed in
 -- money.placed_on_no_job and named in not_known; never a contact billed on builder work
 xn AS (
  SELECT nullif(btrim(i.xero_contact_id), '') AS xero_contact_id, i.contact_name AS party,
         sum(coalesce(i.amount_due, 0)) AS owing,
         sum(CASE WHEN i.due_date < (p_as_of AT TIME ZONE 'Australia/Perth')::date THEN coalesce(i.amount_due, 0) ELSE 0 END) AS overdue,
         string_agg(coalesce(i.invoice_number, 'an invoice without a number'), ', ' ORDER BY i.invoice_number COLLATE "C", i.id) AS numbers,
         jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i.id) ORDER BY i.invoice_date NULLS LAST, i.id) AS cites
  FROM public.xero_invoices i
  WHERE i.job_id IS NULL AND i.xero_contact_id IN (SELECT cxc.x FROM cxc)
    AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(i.amount_due, 0) > 0 AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM public.xero_invoices b JOIN public.jobs bj ON bj.id = b.job_id
                    WHERE b.xero_contact_id = i.xero_contact_id AND bj.type::text IN ('makesafe', 'repair', 'insurance'))
  GROUP BY nullif(btrim(i.xero_contact_id), ''), i.contact_name
 ),
 li AS (  -- visible ledger items across the shown stories' live generations
  SELECT cj.job_number, i.*
  FROM cj JOIN public.context_ledger_generations g ON g.job_id = cj.id AND g.status = 'live'
  JOIN public.context_ledger_items i ON i.generation_id = g.id
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.opened_by) c
                    LEFT JOIN public.business_events e
                      ON e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
                    WHERE c->>'table' = 'business_events'
                      AND (e.id IS NULL OR e.job_id IS DISTINCT FROM cj.id OR NOT public.context_linked_status(e.attribution_status)
                           OR e.metadata->>'retracted_at' IS NOT NULL))
 )
 SELECT jsonb_build_object(
  'version', 'client-story-v1',
  'as_of', p_as_of,
  'job_id', p_job_id,
  'identity', (SELECT jsonb_build_object('basis', i.basis, 'contact_ref', i.contact, 'email_known', i.email IS NOT NULL) FROM ident i),
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', cj.id, 'job_number', cj.job_number, 'type', cj.type, 'status', cj.status,
             -- The saved headline, source and age fields from P0-01 are retained.
             -- Phase/open items come from the newest 20 summaries, separately.
             'live', cj.live, 'created_at', cj.created_at, 'phase', st.s #> '{now,phase}',
             'now', left(sv.headline, 200),
             'now_source', CASE WHEN sv.job_id IS NOT NULL THEN 'saved_story' END,
             'story_written_at', sv.written_at, 'story_checked_at', sv.checked_at,
             -- (fourth review) what the client owes on the job, as money.owing counts it; what
             -- others owe on it (the builder on builder work, a neighbour, another payer) apart
             'owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.job_id = cj.id AND x.own),
             'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE x.job_id = cj.id AND x.own),
             'owed_by_others', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.job_id = cj.id AND NOT x.own),
             'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', cj.id))) ORDER BY cj.created_at DESC, cj.id)
           FROM cj LEFT JOIN sv ON sv.job_id = cj.id LEFT JOIN st ON st.id=cj.id), '[]'::jsonb),
  -- (fourth review) owing and overdue are what the client owes: the invoices addressed to them
  -- on their jobs, and what their own Xero contact owes as a payer on another client's job
  -- (sixth review: or on an invoice placed on no job); what others owe on their jobs is
  -- owed_by_others, never in the client's total
  'money', jsonb_build_object('owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.own) + (SELECT coalesce(sum(x.owing), 0) FROM xo x)
                                       + (SELECT coalesce(sum(x.owing), 0) FROM xn x),
             'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE x.own) + (SELECT coalesce(sum(x.overdue), 0) FROM xo x)
                        + (SELECT coalesce(sum(x.overdue), 0) FROM xn x),
             'placed_on_no_job', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                                   'owing', x.owing, 'overdue', x.overdue, 'invoices', x.numbers, 'cites', x.cites)
                                   ORDER BY x.owing DESC, x.party COLLATE "C", x.xero_contact_id COLLATE "C") FROM xn x), '[]'::jsonb),
             'owed_by_others', jsonb_build_object('owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own),
                                                  'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE NOT x.own)),
             'not_yet_invoiced', (SELECT coalesce(sum(x.nyi), 0) FROM (SELECT max(m.not_yet_invoiced) AS nyi FROM mon m GROUP BY m.job_id) x),
             'parties', coalesce((SELECT jsonb_agg(DISTINCT p.party COLLATE "C" ORDER BY p.party COLLATE "C")
                                  FROM (SELECT m.party FROM mon m WHERE m.party IS NOT NULL UNION ALL SELECT x.party FROM xo x WHERE x.party IS NOT NULL
                                        UNION ALL SELECT x.party FROM xn x WHERE x.party IS NOT NULL) p),
                                 '[]'::jsonb),
             -- each paying party on its own: a neighbour's debt is never the client's; the client's
             -- own Xero contact owing on someone else's job counts here, that job named
             'by_party', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                            'owing', x.owing, 'overdue', x.overdue, 'job_numbers', x.jobs)
                            ORDER BY x.owing DESC, x.party COLLATE "C", x.xero_contact_id COLLATE "C")
                          FROM (SELECT y.party, y.xero_contact_id, sum(y.owing) AS owing, sum(y.overdue) AS overdue,
                                       jsonb_agg(DISTINCT y.job_number COLLATE "C" ORDER BY y.job_number COLLATE "C") AS jobs
                                FROM (SELECT m.party, m.xero_contact_id, m.owing, m.overdue, cj.job_number FROM mon m JOIN cj ON cj.id = m.job_id
                                      WHERE m.party IS NOT NULL
                                      UNION ALL
                                      SELECT x.party, x.xero_contact_id, x.owing, x.overdue, x.job_number FROM xo x) y
                                GROUP BY y.party, y.xero_contact_id) x), '[]'::jsonb),
             'other_jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', x.job_id, 'job_number', x.job_number, 'party', x.party,
                            'xero_contact_id', x.xero_contact_id, 'owing', x.owing, 'overdue', x.overdue, 'cites', x.cites)
                            ORDER BY x.job_number COLLATE "C", x.job_id) FROM xo x), '[]'::jsonb)),
  -- story safety (20261006040000): a loop not due yet (status not_due: a final invoice
  -- before the work is done; fourth review: or unconfirmed, a final invoice whose amount
  -- the job value cannot confirm) comes after every loop due now, whatever its rank on its job
  'open_loops', coalesce((SELECT jsonb_agg(x.o ORDER BY x.nd, x.r, x.s NULLS LAST, x.jn COLLATE "C", x.k COLLATE "C") FROM (
                   SELECT lp.loop || jsonb_build_object('job_number', lp.job_number) AS o,
                          coalesce(lp.loop->>'status' IN ('not_due', 'unconfirmed'), false) AS nd,
                          (lp.loop->>'rank')::int AS r, (lp.loop->>'since')::timestamptz AS s, lp.job_number AS jn, lp.loop->>'key' AS k FROM lp
                   ORDER BY coalesce(lp.loop->>'status' IN ('not_due', 'unconfirmed'), false), (lp.loop->>'rank')::int,
                            (lp.loop->>'since')::timestamptz NULLS LAST, lp.job_number COLLATE "C", (lp.loop->>'key') COLLATE "C" LIMIT 10) x), '[]'::jsonb),
  'past_issues', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'what', li.what, 'status', li.status,
                   'since', li.opened_at, 'closed_at', li.closed_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C") FROM li WHERE li.item_type = 'issue'), '[]'::jsonb),
  'preferences', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'type', li.item_type, 'what', li.what,
                   'about_key', li.about_key, 'status', li.status, 'since', li.opened_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C")
                 FROM li WHERE li.item_type IN ('agreement', 'constraint') AND (li.about_key LIKE 'preference:%' OR li.about_key LIKE 'access:%')
                   AND li.status IN ('open', 'info')), '[]'::jsonb),
  'other_parties', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', cj.job_number, 'name', c.client_name, 'role', c.contact_type,
                   'contact_ref', c.ghl_contact_id, 'cites', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', c.id)))
                   ORDER BY cj.created_at DESC, cj.id, c.created_at, c.id)
                 FROM cj JOIN public.job_contacts c ON c.job_id = cj.id
                 WHERE c.removed_at IS NULL AND NOT coalesce(c.is_primary, false) AND coalesce(c.contact_type, '') <> 'primary'), '[]'::jsonb),
  'not_known', coalesce((SELECT jsonb_agg(x.o ORDER BY x.ord) FROM (
                   SELECT 1 AS ord, jsonb_build_object('what', 'This job has no CRM contact and no client email, so the client''s other jobs cannot be found.',
                          'why', 'Clients are matched by CRM contact or exact email, never by name.') AS o
                   FROM ident i WHERE i.basis IS NULL
                   UNION ALL
                   -- (client story saved, 20261117090000) what this read leaves to the job story
                   SELECT 2, jsonb_build_object('what', 'Phase and open items cover at most the newest 20 jobs with a ready page; open a job for its current details.',
                          'why', 'Current asks read stored summaries; asks more than 10 minutes in the past build those summaries live.')
                   WHERE EXISTS (SELECT 1 FROM cj)
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', 'Jobs with no saved story: ' || (SELECT count(*) FROM cj WHERE NOT EXISTS (SELECT 1 FROM sv WHERE sv.job_id = cj.id))
                          || '; their now line is empty.',
                          'why', 'A job''s now line here is its saved story''s headline; the job story has the current line.')
                   WHERE EXISTS (SELECT 1 FROM cj WHERE NOT EXISTS (SELECT 1 FROM sv WHERE sv.job_id = cj.id))
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', 'A now line here is the job''s saved story headline as written at story_written_at; the job may have moved on since.',
                          'why', 'A saved story is written by the story writer, never on a read.')
                   WHERE EXISTS (SELECT 1 FROM sv)
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', (SELECT count(*) FROM st WHERE st.s IS NULL)
                          || ' of this client''s jobs have no stored page yet; open the job to build it.',
                          'why', 'Missing or failed pages supply no phase or open items.')
                   WHERE p_as_of >= now() - interval '10 minutes' AND EXISTS (SELECT 1 FROM st WHERE st.s IS NULL)
                   UNION ALL
                   SELECT 3, jsonb_build_object('what', 'Matched by client email only; jobs under a different email or contact are not included.',
                          'why', 'This job has no CRM contact.')
                   FROM ident i WHERE i.basis = 'client_email'
                   UNION ALL
                   -- (fourth review) owing is what the client owes: what others owe on their jobs
                   -- (the builder on builder work, a neighbour, another payer) is named apart
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue count only what this client owes; others owe '
                          || to_char((SELECT sum(x.owing) FROM mi x WHERE NOT x.own), 'FM$999,999,990.00')
                          || ' on these jobs (a builder on builder work, a neighbour or another payer), in money.owed_by_others; money.by_party has each paying party on its own.',
                          'why', 'An invoice is owed by whoever it is addressed to.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own) > 0
                   UNION ALL
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue add up every invoice addressed to this client on these jobs; money.by_party has each paying party on its own.',
                          'why', 'Shared work can have more than one payer.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own) = 0
                     AND (SELECT count(DISTINCT coalesce(m.xero_contact_id, m.party)) FROM mon m WHERE m.party IS NOT NULL) > 1
                   UNION ALL
                   SELECT 6, jsonb_build_object('what', 'Owing includes ' || to_char((SELECT sum(x.owing) FROM xo x), 'FM$999,999,990.00')
                          || ' this client owes as a payer on another client''s job ('
                          || (SELECT string_agg(DISTINCT x.job_number COLLATE "C", ', ' ORDER BY x.job_number COLLATE "C") FROM xo x) || ').',
                          'why', 'The same Xero contact pays on that job; money.other_jobs names it.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM xo x) > 0
                   UNION ALL
                   -- (sixth review) what their own Xero contact owes on invoices placed on no job
                   SELECT 6, jsonb_build_object('what', 'Owing includes ' || to_char((SELECT sum(x.owing) FROM xn x), 'FM$999,999,990.00')
                          || ' on invoices addressed to this client''s Xero contact that are placed on no job ('
                          || (SELECT string_agg(x.numbers, ', ' ORDER BY x.numbers COLLATE "C") FROM xn x) || ').',
                          'why', 'An invoice reaches a job only when it is placed on it; money.placed_on_no_job names it.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM xn x) > 0
                   UNION ALL
                   SELECT 4, jsonb_build_object('what', 'Past issues and preferences come only from jobs whose ledger is live.',
                          'why', 'The reader has not read every job yet.')
                   WHERE EXISTS (SELECT 1 FROM cj WHERE NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g WHERE g.job_id = cj.id AND g.status = 'live'))
                  ) x), '[]'::jsonb)
 )
 WHERE EXISTS (SELECT 1 FROM me)
$fn$;
COMMENT ON FUNCTION public.context_client_story_stored(uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): Earlier (client story saved, 20261117090000) built no job story: each job''s now line is its saved story''s headline as current at p_as_of (context_job_story_texts), with now_source saved_story (null when it has none), story_written_at and story_checked_at; phase is null and open_loops is empty, since only a job story build works them out, and not_known says so and names the jobs with no saved story. Everything else as story safety left it: identity (CRM contact, else exact client email, never a name), every job of the client with owing, overdue and owed_by_others, money across jobs (owing and overdue are what the client owes, plus their own Xero contact as a payer on another client''s job or on an invoice placed on no job; by_party, other_jobs, placed_on_no_job, owed_by_others), past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known, sorted in C order. client-story-v1. Service role only. Reads job_pages summaries for an ask about now (P0-01). P0-01.3: phase and open loops now come from the newest twenty summaries, historical summaries build live; saved headline/source/age fields retain their existing meanings.';

-- A failed page/story read returns precisely the existing saved-text answer/error.
CREATE OR REPLACE FUNCTION public.context_client_story_stored_safe(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $safe$
/* read block */ BEGIN
 RETURN public.context_client_story_stored(p_job_id,p_as_of);
EXCEPTION WHEN OTHERS THEN
 RETURN public.context_client_story_saved_main(p_job_id,p_as_of);
END $safe$;
CREATE OR REPLACE FUNCTION public.install_context_client_story_stored() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $install$
DECLARE h text;
/* install block */ BEGIN
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_client_story(uuid,timestamptz)'::regprocedure;
 IF h='976400ef0e8107bb1c558041bed16392' THEN RETURN; END IF;
 IF h IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' THEN RAISE EXCEPTION 'client_story_stored_install_preimage_changed'; END IF;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid,p_as_of timestamptz DEFAULT now())
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $body$
 SELECT public.context_client_story_stored_safe(p_job_id,p_as_of)
$body$;$ddl$;
 EXECUTE format('COMMENT ON FUNCTION public.context_client_story(uuid,timestamptz) IS %L',
  obj_description('public.context_client_story_stored(uuid,timestamptz)'::regprocedure,'pg_proc'));
END $install$;
CREATE OR REPLACE FUNCTION public.remove_context_client_story_stored() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $remove$
DECLARE h text; d text;
/* remove block */ BEGIN
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_client_story(uuid,timestamptz)'::regprocedure;
 IF h='ccce1009b2487423ce2a3425a190204f' THEN RETURN; END IF;
 IF h IS DISTINCT FROM '976400ef0e8107bb1c558041bed16392' THEN RAISE EXCEPTION 'client_story_stored_remove_preimage_changed'; END IF;
 d:=pg_get_functiondef('public.context_client_story_saved_main(uuid,timestamptz)'::regprocedure);
 EXECUTE replace(d,'public.context_client_story_saved_main(', 'public.context_client_story(');
 EXECUTE format('COMMENT ON FUNCTION public.context_client_story(uuid,timestamptz) IS %L',
  'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (client story saved, 20261117090000) builds no job story: each job''s now line is its saved story''s headline as current at p_as_of (context_job_story_texts), with now_source saved_story (null when it has none), story_written_at and story_checked_at; phase is null and open_loops is empty, since only a job story build works them out, and not_known says so and names the jobs with no saved story. Everything else as story safety left it: identity (CRM contact, else exact client email, never a name), every job of the client with owing, overdue and owed_by_others, money across jobs (owing and overdue are what the client owes, plus their own Xero contact as a payer on another client''s job or on an invoice placed on no job; by_party, other_jobs, placed_on_no_job, owed_by_others), past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known, sorted in C order. client-story-v1. Service role only.');
END $remove$;
REVOKE ALL ON FUNCTION public.context_client_story_saved_main(uuid,timestamptz),
 public.context_client_story_stored(uuid,timestamptz),public.context_client_story_stored_safe(uuid,timestamptz),
 public.install_context_client_story_stored(),public.remove_context_client_story_stored() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_client_story_saved_main(uuid,timestamptz),
 public.context_client_story_stored(uuid,timestamptz),public.context_client_story_stored_safe(uuid,timestamptz),
 public.install_context_client_story_stored(),public.remove_context_client_story_stored() TO service_role;
