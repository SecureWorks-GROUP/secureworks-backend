# Context ladder L1f: production baseline before merge

Date: 2026-10-06 (Perth), read at 2026-10-05 22:42Z.
PR: #966, branch `fm/cio-ctx-p4-fix`, migration `20261006020000_context_ladder_held_placement` (ladder L1f).
Scope: one read-only query (`BEGIN READ ONLY; ...; ROLLBACK;`) against production. No writes, no flag change.

## Why this file exists

L1f's predictions for the sender rules preview (bad moves 20 to 0) rest on four facts in production.
This records them before L1f merges, so the post-merge run of the same check and the re-sent P4 preview
have a pre-L1f number to compare against. An independent reviewer ran the same query at 22:41Z and got
the same values.

## Results

| Check | What L1f assumes | Production at 22:42Z | Holds |
|---|---|---|---|
| a. patio-tool rows on a job, last 30 days | every row carries `source_job_binding.via`, so the rules-on path keeps it as `confirmed_custody` | 125 rows, 125 with `via`, all `via = writer_key_relink`; `written_as`: anon 40, none 85 | yes |
| b. SWP-261496, SWP-261511, SWP-261512 | all drafts (a lead's job card), so the preview must not count them as not live | all three `draft`, each with a GHL contact, `booking_intake_draft` null | yes |
| c. SWF-261098 | invoiced with `completed_at` before the call, and the customer's only own job, so the transcript gets a held placement | `invoiced`, `completed_at` 2026-09-23 01:01Z, not archived, the contact's only job (created 2026-07-28). Transcripts on it: `514f7935-0485-43f3-892c-0194492767f9` (`single_open`, `match_method contact_id`, 2026-10-01 04:56Z) and `942d2a40-5b45-44c7-aa4a-521be07029a8` (`direct`, `direct_job_id`, 2026-09-02 08:50Z) | yes |
| d. live rules-on ladder | must read `L1f:` before the preview means anything | `L1e:` (L1f not merged yet, as expected) | baseline |
| flag `context_unlinked_rules_v1` | stays off until the preview shows 0 bad moves | `false` | baseline |

## After merge: what to compare

1. Re-run the same query (`p4-fix-checks.sql` in the desk's `cio-ctx-p4-fix` folder; copy below, which only adds
   `COLLATE "C"` to the job-number sort so the order is the same on every machine).
2. Expect `d_rules_ladder = L1f:` and `flag_now = false`.
3. Check a is a rolling 30-day window, so the total will move. What must hold is `with_via = total`.
   Any row without `via` would still go to the bucket (`unverified_writer`) with the rules on.
4. Checks b and c must show the same statuses. A non-draft status in b, or a second live job for the
   SWF-261098 customer, breaks that class's prediction; the preview names the rows.
5. Then re-send the revised `p4-preview.sql`. Predicted: `bad_moves 0`, `preview_errors 0`, `rules_ladder L1f:`.

## The query

```sql
BEGIN READ ONLY;
SELECT jsonb_build_object(
 'as_of', now(),
 'a_patio_rows_on_a_job', (SELECT jsonb_build_object(
    'total', count(*),
    'with_via', count(*) FILTER (WHERE e.metadata->'source_job_binding' ? 'via'),
    'via_values', (SELECT jsonb_object_agg(v, n) FROM (SELECT e2.metadata->'source_job_binding'->>'via' AS v, count(*) n
                    FROM public.business_events e2 WHERE e2.source = 'patio-tool' AND e2.job_id IS NOT NULL
                     AND e2.recorded_at > now() - interval '30 days' GROUP BY 1) x),
    'written_as', (SELECT jsonb_object_agg(coalesce(w, '<none>'), n) FROM (SELECT e3.metadata->>'written_as' AS w, count(*) n
                    FROM public.business_events e3 WHERE e3.source = 'patio-tool' AND e3.job_id IS NOT NULL
                     AND e3.recorded_at > now() - interval '30 days' GROUP BY 1) y))
   FROM public.business_events e WHERE e.source = 'patio-tool' AND e.job_id IS NOT NULL AND e.recorded_at > now() - interval '30 days'),
 'b_draft_targets', (SELECT jsonb_agg(jsonb_build_object('job', j.job_number, 'status', j.status::text, 'ghl_contact', j.ghl_contact_id IS NOT NULL,
     'booking_intake_draft', j.metadata->>'booking_intake_draft') ORDER BY j.job_number COLLATE "C")
   FROM public.jobs j WHERE j.job_number IN ('SWP-261511', 'SWP-261512', 'SWP-261496')),
 'c_swf_261098', (SELECT jsonb_build_object('status', j.status::text, 'completed_at', j.completed_at, 'archived', j.archived,
     'contact_jobs', (SELECT jsonb_agg(jsonb_build_object('job', o.job_number, 'status', o.status::text, 'created_at', o.created_at) ORDER BY o.created_at)
                      FROM public.jobs o WHERE o.ghl_contact_id = j.ghl_contact_id AND o.ghl_contact_id IS NOT NULL),
     'transcripts_on_it', (SELECT jsonb_agg(jsonb_build_object('id', t.id, 'status', t.attribution_status, 'at', coalesce(t.event_at, t.occurred_at),
                             'match_method', t.match_method, 'contact_set', t.contact_id IS NOT NULL))
                           FROM public.business_events t WHERE t.job_id = j.id AND t.event_type LIKE 'call.transcript%'))
   FROM public.jobs j WHERE j.job_number = 'SWF-261098'),
 'd_rules_ladder', left(coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), ''), 4),
 'flag_now', (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_unlinked_rules_v1')
) AS p4_fix_checks;
ROLLBACK;
```
