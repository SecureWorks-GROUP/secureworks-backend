-- TP-13 owner census, FINISHED jobs: how many finished jobs would carry each
-- partial-cost reason today, and how much margin each would hide, before
-- 20261029160000 is applied. A margin hidden on a finished job stays hidden: nothing
-- new arrives to clear it. Its twin for live jobs is
-- job-profit-tp13-partial-cost-census-live.sql (same columns).
-- Read only: SELECTs on views and tables. Writes nothing. Totals only: no job ids,
-- numbers, names or per-job amounts.
-- Sent as one request (supabase db query --linked -f <this file>), the statements
-- share one implicit transaction: it is made read only and capped at 30 seconds, and
-- the SELECT is the last statement, so its rows are what returns.
--
-- It reads the views as they stand before TP-13 (JP-12's v_job_profit,
-- v_job_cost_events, v_job_revenue_events). It works each rule out the way the
-- migration's view does, with the migration's numbers and switches copied into
-- params (job_profit_partial_cost_policy() does not exist until the migration
-- runs), so change them together, and change both census files together. A 42703
-- naming job_variations.cost_estimate or jobs.completed_at means the column is
-- absent, and the migration's own guard would refuse to run as well.
--
-- Scope finished: not legacy, not a holding job (v_job_profit.holding_job), status
-- complete, completed or archived, AND COMPLETED SINCE 1 JULY 2026: jobs.completed_at
-- on or after 2026-07-01 00:00 Perth (timestamptz '2026-07-01 00:00:00+08'). The
-- floor is a fixed literal so a second run reads the same jobs, and it keeps the read
-- inside the 30 seconds. One row, left_out_before_floor, counts the finished jobs it
-- leaves out (completed before the floor, or with no completed_at), in jobs and
-- fencing_jobs (by jobs.type), so none is dropped without a count; it reads jobs
-- only, so it includes holding jobs.
-- Columns, per reason:
--   scope: the scope this file reads (one value per file, kept so the two files'
--     rows line up).
--   jobs / fencing_jobs: the jobs (fencing ones) the reason names.
--   margin_shown_today: of those, how many show a margin today (margin_ok).
--   margin_hidden_as_shipped: of those, how many TP-13 as shipped would turn to no
--     margin because this reason holds (materials_below_quote and
--     variation_not_invoiced hold; the order checks and variation_not_costed warn).
--     A job counts under every reason that holds on it.
--   margin_hidden_if_held: the same if the policy made this reason hold (null for
--     the reasons that never hold).
--   profit_hidden_as_shipped_ex / profit_hidden_if_held_ex: the sum of today's
--     profit_ex over those jobs, i.e. the margin that would no longer be shown.
-- any_reason counts each job once; jobs_read is every job in the scope.
-- Two extra rows split the variation_not_invoiced holds the reviewer proved can be
-- wrong:
--   variation_not_invoiced_quote_already_revised: the invoices cover the sent quote
--     and the newest sent quote was sent after the newest agreed variation, so the
--     quote probably already includes it.
--   variation_not_invoiced_within_discount: the invoices fall short of quote plus
--     variations by no more than params.discount_within_ex (a discount, not an
--     unbilled variation). The limit is a proposal for the reading, not a policy.
-- Timing: not measured on production; a 57014 means the 30 seconds were not enough.
set transaction read only;
set local statement_timeout = '30s';
with params as (
  select 30 as po_no_bill_days,
         14 as work_done_no_labour_days,
         0.6::numeric as materials_below_quote_share,
         1.00::numeric as variation_cover_tolerance_ex,
         -- holds_margin as shipped
         true as materials_below_quote_holds,
         false as ordered_not_billed_over_30_days_holds,
         false as po_no_bill_overdue_holds,
         false as variation_not_costed_holds,
         true as variation_not_invoiced_holds,
         200.00::numeric as discount_within_ex,
         (now() at time zone 'Australia/Perth')::date as today
),
scoped as (
  select j.id,
         case when coalesce(j.status, '') in ('complete', 'completed', 'archived')
                   and j.completed_at >= timestamptz '2026-07-01 00:00:00+08'
              then 'finished' end as scope
  from public.jobs j
  where j.legacy is not true
),
p as (
  select v.job_id, s.scope, v.work_type, v.margin_ok, v.profit_ex, v.quoted_ex, v.invoiced_ex,
         v.variations_listed_ex, v.expected_source, v.expected_labour_ex,
         v.expected_materials_ex, v.expected_commission_ex, v.actual_labour_ex,
         v.actual_materials_ex
  from public.v_job_profit v
  join scoped s on s.id = v.job_id
  where v.job_id = any (array(select id from scoped where scope is not null))
    and s.scope is not null
    and not v.holding_job
),
orders as (
  select e.job_id,
         count(*) filter (where e.source = 'po_ordered'
                          and e.event_date <= pa.today - pa.po_no_bill_days) as ordered_over_limit,
         count(*) filter (where e.source in ('po_committed', 'po_invoice_emailed')
                          and case when e.source = 'po_committed'
                                   then (select coalesce(po.delivery_date, (po.created_at at time zone 'Australia/Perth')::date)
                                         from public.purchase_orders po where po.id = e.source_id::uuid)
                                   else e.event_date
                              end <= pa.today - pa.po_no_bill_days) as po_overdue
  from public.v_job_cost_events e
  cross join params pa
  where e.job_id = any (array(select id from scoped where scope is not null))
  group by e.job_id
),
var as (
  select e.job_id,
         count(*) as agreed,
         count(*) filter (where v.cost_estimate is null) as not_costed,
         max(coalesce(v.accepted_at, v.approved_at, v.sent_at, v.created_at)) as last_agreed_at
  from public.v_job_revenue_events e
  join public.job_variations v on v.id::text = e.source_id
  where e.kind = 'variation' and e.agreed and e.amount_ex > 0
    and e.job_id = any (array(select id from scoped where scope is not null))
  group by e.job_id
),
last_quote as (
  select d.job_id, max(d.sent_at) as last_sent_at
  from public.job_documents d
  where d.type = 'quote' and d.sent_at is not null
    and d.superseded_at is null and d.declined_at is null
    and d.job_id = any (array(select id from scoped where scope is not null))
  group by d.job_id
),
done as (
  select j.id as job_id,
         least((j.completed_at at time zone 'Australia/Perth')::date,
               (select (min(s.created_at) at time zone 'Australia/Perth')::date
                from public.job_client_signoffs s where s.job_id = j.id)) as work_done_on
  from public.jobs j
  where j.id = any (array(select id from scoped where scope is not null))
),
flags as (
  select p.job_id, p.scope, p.work_type, coalesce(p.margin_ok, false) as margin_ok, p.profit_ex,
    (p.actual_materials_ex > 0 and coalesce(p.expected_materials_ex, 0) > 0
      and p.actual_materials_ex < p.expected_materials_ex * pa.materials_below_quote_share) as materials_below_quote,
    (coalesce(o.ordered_over_limit, 0) > 0) as ordered_not_billed_over_30_days,
    (coalesce(o.po_overdue, 0) > 0) as po_no_bill_overdue,
    (p.actual_labour_ex = 0 and d.work_done_on is not null
      and d.work_done_on <= pa.today - pa.work_done_no_labour_days) as work_done_no_labour_overdue,
    (coalesce(va.not_costed, 0) > 0) as variation_not_costed,
    (coalesce(va.agreed, 0) > 0 and p.quoted_ex is not null
      and p.invoiced_ex < p.quoted_ex + p.variations_listed_ex - pa.variation_cover_tolerance_ex) as variation_not_invoiced,
    (coalesce(va.agreed, 0) > 0 and p.quoted_ex is null) as variation_invoice_unchecked,
    (p.expected_source is not null
      and (p.expected_labour_ex is null or p.expected_materials_ex is null or p.expected_commission_ex is null)) as expected_cost_lane_missing,
    (p.quoted_ex is not null and p.invoiced_ex >= p.quoted_ex
      and lq.last_sent_at is not null and va.last_agreed_at is not null
      and lq.last_sent_at > va.last_agreed_at) as quote_already_revised,
    (p.quoted_ex is not null
      and p.quoted_ex + p.variations_listed_ex - p.invoiced_ex <= pa.discount_within_ex) as within_discount
  from p
  cross join params pa
  left join orders o on o.job_id = p.job_id
  left join var va on va.job_id = p.job_id
  left join last_quote lq on lq.job_id = p.job_id
  left join done d on d.job_id = p.job_id
),
rows as (
  select f.job_id, f.scope, f.work_type, f.margin_ok, f.profit_ex, r.ord, r.code, r.named, r.holds_as_shipped, r.can_hold
  from flags f
  cross join params pa
  cross join lateral (values
    (1, 'materials_below_quote', f.materials_below_quote, pa.materials_below_quote_holds, true),
    (2, 'ordered_not_billed_over_30_days', f.ordered_not_billed_over_30_days, pa.ordered_not_billed_over_30_days_holds, true),
    (3, 'po_no_bill_overdue', f.po_no_bill_overdue, pa.po_no_bill_overdue_holds, true),
    (4, 'work_done_no_labour_overdue', f.work_done_no_labour_overdue, false, false),
    (5, 'variation_not_costed', f.variation_not_costed, pa.variation_not_costed_holds, true),
    (6, 'variation_not_invoiced', f.variation_not_invoiced, pa.variation_not_invoiced_holds, true),
    (7, 'variation_invoice_unchecked', f.variation_invoice_unchecked, false, false),
    (8, 'expected_cost_lane_missing', f.expected_cost_lane_missing, false, false),
    (11, 'variation_not_invoiced_quote_already_revised',
         f.variation_not_invoiced and f.quote_already_revised, pa.variation_not_invoiced_holds, true),
    (12, 'variation_not_invoiced_within_discount',
         f.variation_not_invoiced and f.within_discount, pa.variation_not_invoiced_holds, true)
  ) as r(ord, code, named, holds_as_shipped, can_hold)
)
select scope, ord, code,
       count(*) filter (where named) as jobs,
       count(*) filter (where named and work_type = 'fencing') as fencing_jobs,
       count(*) filter (where named and margin_ok) as margin_shown_today,
       count(*) filter (where named and margin_ok and holds_as_shipped) as margin_hidden_as_shipped,
       case when bool_or(can_hold) then count(*) filter (where named and margin_ok and can_hold) end as margin_hidden_if_held,
       coalesce(sum(profit_ex) filter (where named and margin_ok and holds_as_shipped), 0) as profit_hidden_as_shipped_ex,
       case when bool_or(can_hold) then coalesce(sum(profit_ex) filter (where named and margin_ok and can_hold), 0) end as profit_hidden_if_held_ex
from rows
group by scope, ord, code
union all
select a.scope, 9, 'any_reason',
       count(*) filter (where a.named),
       count(*) filter (where a.named and a.work_type = 'fencing'),
       count(*) filter (where a.named and a.margin_ok),
       count(*) filter (where a.named and a.margin_ok and a.holds),
       count(*) filter (where a.named and a.margin_ok and a.can_hold),
       coalesce(sum(a.profit_ex) filter (where a.named and a.margin_ok and a.holds), 0),
       coalesce(sum(a.profit_ex) filter (where a.named and a.margin_ok and a.can_hold), 0)
from (
  select scope, job_id, work_type, margin_ok, profit_ex,
         bool_or(named) as named,
         bool_or(named and holds_as_shipped) as holds,
         bool_or(named and can_hold) as can_hold
  from rows where ord < 11
  group by scope, job_id, work_type, margin_ok, profit_ex
) a
group by a.scope
union all
select f.scope, 10, 'jobs_read',
       count(*),
       count(*) filter (where f.work_type = 'fencing'),
       count(*) filter (where f.margin_ok),
       null, null, null, null
from flags f
group by f.scope
union all
select 'finished', 13, 'left_out_before_floor',
       count(*),
       count(*) filter (where j.type = 'fencing'),
       null, null, null, null, null
from public.jobs j
where j.legacy is not true
  and coalesce(j.status, '') in ('complete', 'completed', 'archived')
  and (j.completed_at is null or j.completed_at < timestamptz '2026-07-01 00:00:00+08')
order by 2;
