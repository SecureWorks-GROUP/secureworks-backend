SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5s';

CREATE INDEX IF NOT EXISTS trade_invoices_effort_week_idx
  ON public.trade_invoices (org_id, week_start) WHERE status <> 'draft';
CREATE INDEX IF NOT EXISTS trade_invoice_lines_effort_held_idx
  ON public.trade_invoice_lines (held_at) WHERE hold_reason IS NOT NULL;

CREATE FUNCTION public.pay_effort_stats(p_org_id uuid, p_weeks integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
WITH bounds AS (
  SELECT date_trunc('week', current_timestamp AT TIME ZONE 'Australia/Perth')::date AS monday
  WHERE p_org_id IS NOT NULL AND p_weeks BETWEEN 1 AND 26
), calendar AS (
  SELECT monday - 7 * n AS week_start, n FROM bounds, generate_series(0, p_weeks + 3) n
), invoices AS MATERIALIZED (
  SELECT i.id, i.user_id, i.week_start, i.submitted_at, i.invoice_kind,
    i.office_sent_back_at IS NOT NULL OR i.status IN ('queried','ops-reject')
      OR coalesce(i.xero_adjustments_ex, 0) <> 0 AS corrected,
    i.confirm_seconds, i.accepted_untouched, i.auto_sent
  FROM public.trade_invoices i, bounds b
  WHERE i.org_id = p_org_id AND i.status <> 'draft'
    AND i.week_start BETWEEN b.monday - 7 * (p_weeks - 1) AND b.monday
), lines AS (
  SELECT i.id, l.changed_from_suggestion, l.office_review_status, l.line_total_ex,
    i.invoice_kind IN ('standard','follow_on') AND EXISTS (
      SELECT 1 FROM public.job_assignments a
      WHERE a.job_id = l.job_id AND a.user_id = i.user_id AND a.added_by = 'self'
        AND a.scheduled_date BETWEEN i.week_start AND i.week_start + 6
        AND a.self_added_status = 'not_accepted' AND a.self_added_reviewed_at > i.submitted_at
    ) AS told_no
  FROM invoices i JOIN public.trade_invoice_lines l ON l.trade_invoice_id = i.id
), line_summary AS (
  SELECT id, count(*) FILTER (WHERE changed_from_suggestion) AS changed,
    bool_or(office_review_status IN ('queried','rejected')) AS reviewed,
    bool_or(told_no) AS told_no, sum(line_total_ex) FILTER (WHERE told_no) AS amount,
    bool_or(told_no AND line_total_ex IS NULL) AS amount_unknown
  FROM lines GROUP BY id
), invoice_summary AS (
  SELECT i.week_start, count(*) AS sent,
    count(*) FILTER (WHERE i.corrected OR l.reviewed) AS corrected,
    count(*) FILTER (WHERE i.accepted_untouched) AS untouched,
    count(*) FILTER (WHERE i.auto_sent) AS auto_sent,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY i.confirm_seconds) AS median_seconds,
    sum(l.changed) AS changed, count(*) FILTER (WHERE l.told_no) AS told_no,
    count(DISTINCT i.user_id) FILTER (WHERE l.told_no) AS trades,
    CASE WHEN bool_or(l.amount_unknown) THEN NULL ELSE coalesce(sum(l.amount),0) END AS amount
  FROM invoices i LEFT JOIN line_summary l USING (id) GROUP BY i.week_start
), holds AS (
  SELECT date_trunc('week', l.held_at AT TIME ZONE 'Australia/Perth')::date AS week_start,
    l.hold_reason AS reason, coalesce(l.sent_amount_ex, l.line_total_ex) AS held_amount, l.decided_at IS NULL AS waiting,
    extract(epoch FROM coalesce(l.decided_at,current_timestamp) - l.held_at) / 3600 AS hours
  FROM public.trade_invoice_lines l JOIN public.trade_invoices i ON i.id = l.trade_invoice_id, bounds b
  WHERE i.org_id = p_org_id AND l.hold_reason IS NOT NULL
    AND l.held_at >= ((b.monday - 7 * (p_weeks + 3))::timestamp AT TIME ZONE 'Australia/Perth')
    AND l.held_at <= current_timestamp
), by_reason AS (
  SELECT week_start, reason, count(*) AS lines,
    CASE WHEN count(held_amount) = count(*) THEN sum(held_amount) END AS amount_ex,
    count(*) FILTER (WHERE waiting) AS waiting_now,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS median_wait_hours,
    max(hours) AS oldest_wait_hours
  FROM holds GROUP BY week_start, reason
), hold_summary AS (
  SELECT week_start, jsonb_agg(to_jsonb(r) - 'week_start' ORDER BY reason COLLATE "C") AS held,
    sum(lines) FILTER (WHERE reason IN ('no_work_order','no_amount')) AS gaps
  FROM by_reason r GROUP BY week_start
), history AS (
  SELECT c.*, coalesce(h.held,'[]'::jsonb) AS held, coalesce(h.gaps,0) AS gaps,
    avg(coalesce(h.gaps,0)) OVER (ORDER BY c.week_start ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS prior
  FROM calendar c LEFT JOIN hold_summary h USING (week_start)
)
SELECT jsonb_agg(jsonb_build_object(
  'week_start', h.week_start, 'sent', coalesce(s.sent,0),
  'sent_back_or_corrected', coalesce(s.corrected,0), 'share', s.corrected::numeric / s.sent,
  'on_target', s.corrected::numeric / s.sent < 0.05,
  'accepted_untouched', coalesce(s.untouched,0), 'auto_sent', coalesce(s.auto_sent,0),
  'median_confirm_seconds', s.median_seconds, 'changed_lines', coalesce(s.changed,0),
  'held', h.held, 'no_work_order_trend', CASE WHEN h.gaps > h.prior THEN 'up'
    WHEN h.gaps < h.prior THEN 'down' ELSE 'flat' END,
  'told_no_after_sent', jsonb_build_object('invoices', coalesce(s.told_no,0),
    'trades', coalesce(s.trades,0), 'amount_ex', CASE WHEN s.sent IS NULL THEN 0 ELSE s.amount END)
) ORDER BY h.week_start DESC)
FROM history h LEFT JOIN invoice_summary s USING (week_start) WHERE h.n < p_weeks;
$$;

REVOKE ALL ON FUNCTION public.pay_effort_stats(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_effort_stats(uuid,integer) TO service_role;

-- Stamp the same guarded update as the receipt release.
DO $guard$ DECLARE fn regprocedure := 'public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure;
  body_hash text; definition text; BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO body_hash, definition FROM pg_proc WHERE oid = fn;
  IF body_hash = 'd689b65f2fa743a8af8e5e795f2cc39e' THEN RETURN; END IF;
  IF body_hash IS DISTINCT FROM '73c277c035c43cea9156f46bce919813' THEN
    RAISE EXCEPTION 'effort_reject_preimage_mismatch';
  END IF;
  EXECUTE replace(definition, $old$SET status = 'ops-reject', query_note = p_note$old$, $new$SET status = 'ops-reject', query_note = p_note, office_sent_back_at = clock_timestamp()$new$);
END $guard$;
