-- TP-13 owner census: how many live jobs would carry each partial-cost reason
-- today, and how many margins each would hide, before 20261029160000 is applied.
-- Read only: SELECTs on views and tables. Writes nothing. Totals only, no job
-- ids, names or amounts.
-- Sent as one request, the statements share one implicit transaction: it is made
-- read only and capped at 30 seconds, and the SELECT is the last statement, so its
-- rows are what returns.
--
-- It reads the views as they stand before TP-13 (JP-12's v_job_profit,
-- v_job_cost_events, v_job_revenue_events) and works each rule out the way the
-- migration's view does, with the migration's numbers copied into params below
-- (job_profit_partial_cost_policy() does not exist until the migration runs).
-- Change them together. A 42703 naming job_variations.cost_estimate or
-- jobs.completed_at means the column is absent, and the migration's own guard
-- would refuse to run as well.
--
-- Live job: not legacy, not a holding job (metadata.do_not_schedule), and status
-- not archived, complete, completed, cancelled, lost or draft.
-- Columns:
--   live_jobs / live_fencing_jobs: live jobs (fencing ones) the reason names.
--   margin_shown_today: of those, how many show a margin today (margin_ok).
--   margin_hidden_as_shipped: of those, how many TP-13 as shipped would turn to
--     no margin because this reason holds (materials_below_quote and
--     variation_not_invoiced hold; the order checks and variation_not_costed
--     warn). A job counts under every reason that holds on it.
--   margin_hidden_if_held: the same if the policy made this reason hold
--     (null for the reasons that never hold).
-- The last row, any_reason, counts each job once.
set transaction read only;
set local statement_timeout = '30s';
with params as (
  select 30 as po_no_bill_days,
         14 as work_done_no_labour_days,
         0.6::numeric as materials_below_quote_share,
         1.00::numeric as variation_cover_tolerance_ex,
         (now() at time zone 'Australia/Perth')::date as today
),
live as (
  select j.id
  from public.jobs j
  where j.legacy is not true
    and lower(coalesce(j.metadata ->> 'do_not_schedule', '')) <> 'true'
    and coalesce(j.status, '') not in ('archived', 'complete', 'completed', 'cancelled', 'lost', 'draft')
),
p as (
  select v.job_id, v.work_type, v.margin_ok, v.quoted_ex, v.invoiced_ex,
         v.variations_listed_ex, v.expected_source, v.expected_labour_ex,
         v.expected_materials_ex, v.expected_commission_ex, v.actual_labour_ex,
         v.actual_materials_ex
  from public.v_job_profit v
  where v.job_id = any (array(select id from live))
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
  where e.job_id = any (array(select id from live))
  group by e.job_id
),
var as (
  select e.job_id,
         count(*) as agreed,
         count(*) filter (where v.cost_estimate is null) as not_costed
  from public.v_job_revenue_events e
  join public.job_variations v on v.id::text = e.source_id
  where e.kind = 'variation' and e.agreed and e.amount_ex > 0
    and e.job_id = any (array(select id from live))
  group by e.job_id
),
done as (
  select j.id as job_id,
         least((j.completed_at at time zone 'Australia/Perth')::date,
               (select (min(s.created_at) at time zone 'Australia/Perth')::date
                from public.job_client_signoffs s where s.job_id = j.id)) as work_done_on
  from public.jobs j
  where j.id = any (array(select id from live))
),
flags as (
  select p.job_id, p.work_type, coalesce(p.margin_ok, false) as margin_ok,
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
      and (p.expected_labour_ex is null or p.expected_materials_ex is null or p.expected_commission_ex is null)) as expected_cost_lane_missing
  from p
  cross join params pa
  left join orders o on o.job_id = p.job_id
  left join var va on va.job_id = p.job_id
  left join done d on d.job_id = p.job_id
),
rows as (
  select f.job_id, f.work_type, f.margin_ok, r.ord, r.code, r.named, r.holds_as_shipped, r.can_hold
  from flags f
  cross join lateral (values
    (1, 'materials_below_quote', f.materials_below_quote, true, true),
    (2, 'ordered_not_billed_over_30_days', f.ordered_not_billed_over_30_days, false, true),
    (3, 'po_no_bill_overdue', f.po_no_bill_overdue, false, true),
    (4, 'work_done_no_labour_overdue', f.work_done_no_labour_overdue, false, false),
    (5, 'variation_not_costed', f.variation_not_costed, false, true),
    (6, 'variation_not_invoiced', f.variation_not_invoiced, true, true),
    (7, 'variation_invoice_unchecked', f.variation_invoice_unchecked, false, false),
    (8, 'expected_cost_lane_missing', f.expected_cost_lane_missing, false, false)
  ) as r(ord, code, named, holds_as_shipped, can_hold)
)
select ord, code,
       count(*) filter (where named) as live_jobs,
       count(*) filter (where named and work_type = 'fencing') as live_fencing_jobs,
       count(*) filter (where named and margin_ok) as margin_shown_today,
       count(*) filter (where named and margin_ok and holds_as_shipped) as margin_hidden_as_shipped,
       case when bool_or(can_hold) then count(*) filter (where named and margin_ok and can_hold) end as margin_hidden_if_held
from rows
group by ord, code
union all
select 9, 'any_reason',
       count(distinct job_id) filter (where named),
       count(distinct job_id) filter (where named and work_type = 'fencing'),
       count(distinct job_id) filter (where named and margin_ok),
       count(distinct job_id) filter (where named and margin_ok and holds_as_shipped),
       count(distinct job_id) filter (where named and margin_ok and can_hold)
from rows
union all
select 10, 'live_jobs_read',
       count(distinct job_id),
       count(distinct job_id) filter (where work_type = 'fencing'),
       count(distinct job_id) filter (where margin_ok),
       null, null
from rows
order by 1;
