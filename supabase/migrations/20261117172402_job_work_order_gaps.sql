-- P1-05.1: office-only read. No job, work order or pay line is changed.
CREATE OR REPLACE FUNCTION public.job_work_order_gaps(p_org_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $function$
  WITH held AS (
    SELECT l.job_id, count(*) AS held_lines,
      coalesce(sum(l.line_total_ex), 0) AS held_amount_ex,
      count(DISTINCT i.user_id) AS held_trades,
      min(l.held_at) AS oldest_held_at
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    JOIN public.jobs j ON j.id = l.job_id AND j.org_id = p_org_id
    WHERE i.org_id = p_org_id
      AND l.office_review_status IN ('awaiting', 'queried')
      AND l.hold_reason IN ('no_work_order', 'no_amount', 'hourly_no_maximum')
    GROUP BY l.job_id
  ), gaps AS (
    SELECT j.id AS job_id, j.job_number, j.type, j.status,
      CASE WHEN w.id IS NULL THEN 'no_work_order' ELSE 'no_amount' END AS reason,
      w.id AS work_order_id,
      coalesce(h.held_lines, 0) AS held_lines,
      coalesce(h.held_amount_ex, 0) AS held_amount_ex,
      coalesce(h.held_trades, 0) AS held_trades,
      h.oldest_held_at, j.created_at
    FROM public.jobs j
    LEFT JOIN held h ON h.job_id = j.id
    LEFT JOIN LATERAL (
      SELECT wo.id, wo.status, wo.agreed_labour_ex
      FROM public.work_orders wo
      WHERE wo.job_id = j.id AND wo.org_id = p_org_id
        AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
      ORDER BY wo.created_at DESC NULLS LAST, wo.id
      LIMIT 1
    ) w ON true
    WHERE j.org_id = p_org_id
      AND (j.status = ANY(public.job_work_order_open_statuses()) OR h.held_lines > 0)
      AND (w.id IS NULL OR w.status <> 'approved' OR w.agreed_labour_ex IS NULL)
  ), page AS (
    SELECT * FROM gaps
    ORDER BY (held_lines > 0) DESC, oldest_held_at ASC NULLS LAST,
      created_at ASC NULLS LAST, job_id
    LIMIT 500
  )
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'no_work_order', (SELECT count(*) FROM gaps WHERE reason = 'no_work_order'),
      'no_amount', (SELECT count(*) FROM gaps WHERE reason = 'no_amount'),
      'jobs_with_held_lines', (SELECT count(*) FROM gaps WHERE held_lines > 0)
    ),
    'jobs', coalesce((SELECT jsonb_agg(to_jsonb(p) - 'created_at'
      ORDER BY (p.held_lines > 0) DESC, p.oldest_held_at ASC NULLS LAST,
        p.created_at ASC NULLS LAST, p.job_id) FROM page p), '[]'::jsonb)
  );
$function$;
REVOKE ALL ON FUNCTION public.job_work_order_gaps(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_work_order_gaps(uuid) TO service_role;
