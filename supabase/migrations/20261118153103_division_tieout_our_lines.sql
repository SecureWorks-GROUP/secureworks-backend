-- P3-04.5: list every line of our Xero bills, customer invoices and supplier
-- credit notes for one organisation and month with Xero's division tag, our
-- division, the account code and the ex-GST amount.
-- Creates public.division_tieout_our_lines(uuid, date) only: no table, index,
-- trigger, schedule or switch change runs on merge.
-- Indexes serving reads: idx_xero_invoices_date, xero_supplier_credit_notes_pkey,
-- job_cost_lines_org_id_document_kind_document_id_line_key_key,
-- job_cost_line_parts_line_id_part_no_key, jobs_pkey.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$ /* preimage and prerequisite guard */ BEGIN
  IF to_regprocedure('public.job_division_option(text,text)') IS NULL
     OR to_regprocedure('public.stock_division_option(text)') IS NULL
     OR to_regclass('public.xero_invoices') IS NULL
     OR to_regclass('public.xero_supplier_credit_notes') IS NULL
     OR to_regclass('public.job_cost_lines') IS NULL
     OR to_regclass('public.job_cost_line_parts') IS NULL
     OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'division_tieout_our_lines_prerequisite_missing';
  END IF;

  IF to_regprocedure('public.division_tieout_our_lines(uuid,date)') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       WHERE p.oid = to_regprocedure('public.division_tieout_our_lines(uuid,date)')
         AND md5(p.prosrc) <> '8aff0b5bb7d30f80cfe3a3a4410fe02b'
     ) THEN
    RAISE EXCEPTION 'division_tieout_our_lines_body_changed';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.division_tieout_our_lines(
  p_org_id uuid,
  p_month date
)
RETURNS TABLE (
  document_type text,
  document_id text,
  document_number text,
  line_id text,
  account_code text,
  xero_option text,
  our_option text,
  amount_ex numeric,
  on_job boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_month_start date;
  v_month_end date;
  v_bad_code text;
  v_bad_detail text;
/* function body */ BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'division_tieout_org_required' USING ERRCODE = '22023';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'division_tieout_month_required' USING ERRCODE = '22023';
  END IF;

  v_month_start := date_trunc('month', p_month)::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  -- Refuse malformed line JSON or a coded line with a missing/invalid amount;
  -- detail carries document type, document id and line id only.
  SELECT bad.code, bad.detail
  INTO v_bad_code, v_bad_detail
  FROM (
    SELECT
      'division_tieout_lines_malformed'::text AS code,
      x.invoice_type || ':' || x.xero_invoice_id AS detail
    FROM public.xero_invoices AS x
    WHERE x.org_id = p_org_id
      AND x.invoice_type IN ('ACCPAY', 'ACCREC')
      AND x.status IN ('AUTHORISED', 'PAID')
      AND x.invoice_date >= v_month_start
      AND x.invoice_date < v_month_end
      AND x.line_items IS NOT NULL
      AND jsonb_typeof(x.line_items) <> 'array'

    UNION ALL

    SELECT
      CASE
        WHEN jsonb_typeof(li.val) <> 'object' THEN 'division_tieout_lines_malformed'
        WHEN COALESCE(li.val ->> 'LineAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN 'division_tieout_line_amount_missing'
        ELSE 'division_tieout_tax_amount_invalid'
      END AS code,
      x.invoice_type || ':' || x.xero_invoice_id || ':'
        || COALESCE(
             CASE WHEN jsonb_typeof(li.val) = 'object' THEN NULLIF(li.val ->> 'LineItemID', '') END,
             'n:' || li.pos::text
           ) AS detail
    FROM public.xero_invoices AS x
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS li(val, pos)
    WHERE x.org_id = p_org_id
      AND x.invoice_type IN ('ACCPAY', 'ACCREC')
      AND x.status IN ('AUTHORISED', 'PAID')
      AND x.invoice_date >= v_month_start
      AND x.invoice_date < v_month_end
      AND NOT (
        jsonb_typeof(li.val) = 'object'
        AND NULLIF(li.val ->> 'AccountCode', '') IS NULL
        AND (NOT (li.val ? 'LineAmount') OR jsonb_typeof(li.val -> 'LineAmount') = 'null')
      )
      AND (
        jsonb_typeof(li.val) <> 'object'
        OR COALESCE(li.val ->> 'LineAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
        OR (
          (x.raw_json ->> 'LineAmountTypes') = 'Inclusive'
          AND (li.val ? 'TaxAmount')
          AND jsonb_typeof(li.val -> 'TaxAmount') <> 'null'
          AND COALESCE(li.val ->> 'TaxAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
        )
      )

    UNION ALL

    SELECT
      'division_tieout_lines_malformed'::text AS code,
      'ACCPAYCREDIT:' || n.xero_credit_note_id AS detail
    FROM public.xero_supplier_credit_notes AS n
    WHERE n.org_id = p_org_id
      AND n.credit_note_type = 'ACCPAYCREDIT'
      AND n.status IN ('AUTHORISED', 'PAID')
      AND n.credit_note_date >= v_month_start
      AND n.credit_note_date < v_month_end
      AND (
        n.raw_json IS NULL
        OR jsonb_typeof(n.raw_json) <> 'object'
        OR (n.raw_json ? 'LineItems' AND jsonb_typeof(n.raw_json -> 'LineItems') NOT IN ('array', 'null'))
      )

    UNION ALL

    SELECT
      CASE
        WHEN jsonb_typeof(li.val) <> 'object' THEN 'division_tieout_lines_malformed'
        WHEN COALESCE(li.val ->> 'LineAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN 'division_tieout_line_amount_missing'
        ELSE 'division_tieout_tax_amount_invalid'
      END AS code,
      'ACCPAYCREDIT:' || n.xero_credit_note_id || ':'
        || COALESCE(
             CASE WHEN jsonb_typeof(li.val) = 'object' THEN NULLIF(li.val ->> 'LineItemID', '') END,
             'n:' || li.pos::text
           ) AS detail
    FROM public.xero_supplier_credit_notes AS n
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(n.raw_json) = 'object' AND jsonb_typeof(n.raw_json -> 'LineItems') = 'array'
        THEN n.raw_json -> 'LineItems'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS li(val, pos)
    WHERE n.org_id = p_org_id
      AND n.credit_note_type = 'ACCPAYCREDIT'
      AND n.status IN ('AUTHORISED', 'PAID')
      AND n.credit_note_date >= v_month_start
      AND n.credit_note_date < v_month_end
      AND NOT (
        jsonb_typeof(li.val) = 'object'
        AND NULLIF(li.val ->> 'AccountCode', '') IS NULL
        AND (NOT (li.val ? 'LineAmount') OR jsonb_typeof(li.val -> 'LineAmount') = 'null')
      )
      AND (
        jsonb_typeof(li.val) <> 'object'
        OR COALESCE(li.val ->> 'LineAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
        OR (
          COALESCE(n.raw_json ->> 'LineAmountTypes', n.line_amount_types) = 'Inclusive'
          AND (li.val ? 'TaxAmount')
          AND jsonb_typeof(li.val -> 'TaxAmount') <> 'null'
          AND COALESCE(li.val ->> 'TaxAmount', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
        )
      )
    LIMIT 1
  ) AS bad;

  IF v_bad_code IS NOT NULL THEN
    RAISE EXCEPTION '%', v_bad_code
      USING ERRCODE = '22023', DETAIL = v_bad_detail;
  END IF;

  RETURN QUERY
  WITH month_invoices AS MATERIALIZED (
    SELECT
      x.org_id,
      x.invoice_type,
      x.xero_invoice_id,
      x.invoice_number,
      x.job_id,
      (x.raw_json ->> 'LineAmountTypes') = 'Inclusive' AS is_inclusive,
      CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END AS lines_json
    FROM public.xero_invoices AS x
    WHERE x.org_id = p_org_id
      AND x.invoice_type IN ('ACCPAY', 'ACCREC')
      AND x.status IN ('AUTHORISED', 'PAID')
      AND x.invoice_date >= v_month_start
      AND x.invoice_date < v_month_end
  ),
  invoice_lines AS (
    SELECT
      mi.org_id,
      mi.invoice_type,
      mi.xero_invoice_id,
      mi.invoice_number,
      mi.job_id,
      li.pos,
      COALESCE(NULLIF(li.val ->> 'LineItemID', ''), 'n:' || li.pos::text) AS line_key,
      COALESCE(li.val ->> 'AccountCode', '') AS acct_code,
      COALESCE(
        (
          SELECT t.val ->> 'Option'
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(li.val -> 'Tracking') = 'array' THEN li.val -> 'Tracking' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS t(val, tpos)
          WHERE t.val ->> 'Name' = 'Business Unit'
          ORDER BY t.tpos
          LIMIT 1
        ),
        ''
      ) AS xero_opt,
      round(
        (li.val ->> 'LineAmount')::numeric
        - CASE
            WHEN mi.is_inclusive
                 AND (li.val ? 'TaxAmount')
                 AND jsonb_typeof(li.val -> 'TaxAmount') <> 'null'
            THEN (li.val ->> 'TaxAmount')::numeric
            ELSE 0::numeric
          END,
        2
      ) AS line_amt_ex
    FROM month_invoices AS mi
    CROSS JOIN LATERAL jsonb_array_elements(mi.lines_json) WITH ORDINALITY AS li(val, pos)
    WHERE NOT (
      NULLIF(li.val ->> 'AccountCode', '') IS NULL
      AND (NOT (li.val ? 'LineAmount') OR jsonb_typeof(li.val -> 'LineAmount') = 'null')
    )
  ),
  month_credits AS MATERIALIZED (
    SELECT
      n.org_id,
      n.xero_credit_note_id,
      n.credit_note_number,
      COALESCE(n.raw_json ->> 'LineAmountTypes', n.line_amount_types) = 'Inclusive' AS is_inclusive,
      CASE
        WHEN jsonb_typeof(n.raw_json -> 'LineItems') = 'array' THEN n.raw_json -> 'LineItems'
        ELSE '[]'::jsonb
      END AS lines_json
    FROM public.xero_supplier_credit_notes AS n
    WHERE n.org_id = p_org_id
      AND n.credit_note_type = 'ACCPAYCREDIT'
      AND n.status IN ('AUTHORISED', 'PAID')
      AND n.credit_note_date >= v_month_start
      AND n.credit_note_date < v_month_end
  ),
  credit_lines AS (
    SELECT
      mc.org_id,
      mc.xero_credit_note_id,
      mc.credit_note_number,
      li.pos,
      COALESCE(NULLIF(li.val ->> 'LineItemID', ''), 'n:' || li.pos::text) AS line_key,
      COALESCE(li.val ->> 'AccountCode', '') AS acct_code,
      COALESCE(
        (
          SELECT t.val ->> 'Option'
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(li.val -> 'Tracking') = 'array' THEN li.val -> 'Tracking' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS t(val, tpos)
          WHERE t.val ->> 'Name' = 'Business Unit'
          ORDER BY t.tpos
          LIMIT 1
        ),
        ''
      ) AS xero_opt,
      - round(
        (li.val ->> 'LineAmount')::numeric
        - CASE
            WHEN mc.is_inclusive
                 AND (li.val ? 'TaxAmount')
                 AND jsonb_typeof(li.val -> 'TaxAmount') <> 'null'
            THEN (li.val ->> 'TaxAmount')::numeric
            ELSE 0::numeric
          END,
        2
      ) AS credit_amt_ex
    FROM month_credits AS mc
    CROSS JOIN LATERAL jsonb_array_elements(mc.lines_json) WITH ORDINALITY AS li(val, pos)
    WHERE NOT (
      NULLIF(li.val ->> 'AccountCode', '') IS NULL
      AND (NOT (li.val ? 'LineAmount') OR jsonb_typeof(li.val -> 'LineAmount') = 'null')
    )
  ),
  combined AS (
    -- Source A: supplier bills (ACCPAY)
    SELECT
      1 AS src_ord,
      'ACCPAY'::text AS document_type,
      bl.xero_invoice_id AS document_id,
      bl.invoice_number AS document_number,
      bl.pos AS line_ord,
      resolved.ord AS part_ord,
      bl.line_key AS line_id,
      bl.acct_code AS account_code,
      bl.xero_opt AS xero_option,
      resolved.our_opt AS our_option,
      resolved.amt_ex AS amount_ex,
      resolved.is_on_job AS on_job
    FROM invoice_lines AS bl
    LEFT JOIN LATERAL (
      SELECT jcl.id
      FROM public.job_cost_lines AS jcl
      WHERE jcl.org_id = bl.org_id
        AND jcl.document_kind = 'xero_bill'
        AND jcl.document_id = bl.xero_invoice_id
        AND jcl.line_key = bl.line_key
        AND jcl.state IS NOT NULL
        AND jcl.state <> 'needs_person'
      LIMIT 1
    ) AS cl ON true
    CROSS JOIN LATERAL (
      SELECT
        CASE p.target
          WHEN 'job' THEN
            COALESCE(NULLIF(public.job_division_option(pj.job_number, pj.type), ''), NULLIF(bl.xero_opt, ''), 'Unassigned')
          WHEN 'division_stock' THEN
            COALESCE(NULLIF(public.stock_division_option(p.division), ''), NULLIF(bl.xero_opt, ''), 'Unassigned')
          ELSE
            COALESCE(NULLIF(bl.xero_opt, ''), 'Unassigned')
        END AS our_opt,
        round(p.amount_ex, 2) AS amt_ex,
        CASE p.target
          WHEN 'job' THEN NULLIF(public.job_division_option(pj.job_number, pj.type), '') IS NOT NULL
          WHEN 'division_stock' THEN NULLIF(public.stock_division_option(p.division), '') IS NOT NULL
          ELSE false
        END AS is_on_job,
        p.part_no AS ord
      FROM public.job_cost_line_parts AS p
      LEFT JOIN LATERAL (
        SELECT j.job_number, j.type
        FROM public.jobs AS j
        WHERE p.job_id IS NOT NULL
          AND j.id = p.job_id
        LIMIT 1
      ) AS pj ON true
      WHERE cl.id IS NOT NULL
        AND p.line_id = cl.id

      UNION ALL

      SELECT
        COALESCE(NULLIF(bl.xero_opt, ''), 'Unassigned') AS our_opt,
        bl.line_amt_ex AS amt_ex,
        false AS is_on_job,
        0 AS ord
      WHERE cl.id IS NULL
         OR NOT EXISTS (
           SELECT 1
           FROM public.job_cost_line_parts AS p0
           WHERE p0.line_id = cl.id
         )
    ) AS resolved
    WHERE bl.invoice_type = 'ACCPAY'

    UNION ALL

    -- Source B: customer invoices (ACCREC)
    SELECT
      2 AS src_ord,
      'ACCREC'::text AS document_type,
      il.xero_invoice_id AS document_id,
      il.invoice_number AS document_number,
      il.pos AS line_ord,
      0 AS part_ord,
      il.line_key AS line_id,
      il.acct_code AS account_code,
      il.xero_opt AS xero_option,
      COALESCE(ij.job_opt, NULLIF(il.xero_opt, ''), 'Unassigned') AS our_option,
      il.line_amt_ex AS amount_ex,
      (ij.job_opt IS NOT NULL) AS on_job
    FROM invoice_lines AS il
    LEFT JOIN LATERAL (
      SELECT NULLIF(public.job_division_option(j.job_number, j.type), '') AS job_opt
      FROM public.jobs AS j
      WHERE il.job_id IS NOT NULL
        AND j.id = il.job_id
      LIMIT 1
    ) AS ij ON true
    WHERE il.invoice_type = 'ACCREC'

    UNION ALL

    -- Source C: supplier credit notes (ACCPAYCREDIT)
    SELECT
      3 AS src_ord,
      'ACCPAYCREDIT'::text AS document_type,
      cln.xero_credit_note_id AS document_id,
      cln.credit_note_number AS document_number,
      cln.pos AS line_ord,
      resolved.ord AS part_ord,
      cln.line_key AS line_id,
      cln.acct_code AS account_code,
      cln.xero_opt AS xero_option,
      resolved.our_opt AS our_option,
      resolved.amt_ex AS amount_ex,
      resolved.is_on_job AS on_job
    FROM credit_lines AS cln
    CROSS JOIN LATERAL (
      WITH raw_parts AS (
        SELECT
          CASE p.target
            WHEN 'job' THEN
              COALESCE(NULLIF(public.job_division_option(pj.job_number, pj.type), ''), NULLIF(cln.xero_opt, ''), 'Unassigned')
            WHEN 'division_stock' THEN
              COALESCE(NULLIF(public.stock_division_option(p.division), ''), NULLIF(cln.xero_opt, ''), 'Unassigned')
            ELSE
              COALESCE(NULLIF(cln.xero_opt, ''), 'Unassigned')
          END AS opt,
          p.amount_ex AS part_amt,
          CASE p.target
            WHEN 'job' THEN NULLIF(public.job_division_option(pj.job_number, pj.type), '') IS NOT NULL
            WHEN 'division_stock' THEN NULLIF(public.stock_division_option(p.division), '') IS NOT NULL
            ELSE false
          END AS is_on_job
        FROM public.job_cost_lines AS jcl
        JOIN public.job_cost_line_parts AS p
          ON p.line_id = jcl.id
        LEFT JOIN LATERAL (
          SELECT j.job_number, j.type
          FROM public.jobs AS j
          WHERE p.job_id IS NOT NULL
            AND j.id = p.job_id
          LIMIT 1
        ) AS pj ON true
        WHERE jcl.org_id = cln.org_id
          AND jcl.document_kind = 'xero_credit_note'
          AND jcl.document_id = cln.xero_credit_note_id
          AND jcl.state IS NOT NULL
          AND jcl.state <> 'needs_person'
      ),
      opt_totals AS (
        SELECT
          rp.opt,
          sum(rp.part_amt) AS opt_amt,
          bool_or(rp.is_on_job) AS opt_on_job
        FROM raw_parts AS rp
        GROUP BY rp.opt
        HAVING sum(rp.part_amt) <> 0
      ),
      ranked AS (
        SELECT
          o.opt,
          o.opt_on_job,
          round(cln.credit_amt_ex * o.opt_amt / tot.total_amt, 2) AS rounded_amt,
          row_number() OVER (
            ORDER BY (o.opt_amt / tot.total_amt) DESC, o.opt COLLATE "C" ASC
          ) AS rn
        FROM opt_totals AS o
        CROSS JOIN (SELECT sum(opt_amt) AS total_amt FROM opt_totals) AS tot
        WHERE tot.total_amt <> 0
      ),
      apportioned AS (
        SELECT
          r.opt AS our_opt,
          CASE
            WHEN r.rn = 1 THEN
              cln.credit_amt_ex - COALESCE(sum(r.rounded_amt) FILTER (WHERE r.rn > 1) OVER (), 0::numeric)
            ELSE r.rounded_amt
          END AS amt_ex,
          r.opt_on_job AS is_on_job,
          r.rn::int AS ord
        FROM ranked AS r
      )
      SELECT a.our_opt, a.amt_ex, a.is_on_job, a.ord
      FROM apportioned AS a
      UNION ALL
      SELECT
        COALESCE(NULLIF(cln.xero_opt, ''), 'Unassigned') AS our_opt,
        cln.credit_amt_ex AS amt_ex,
        false AS is_on_job,
        0 AS ord
      WHERE NOT EXISTS (SELECT 1 FROM apportioned)
    ) AS resolved
  )
  SELECT
    c.document_type,
    c.document_id,
    c.document_number,
    c.line_id,
    c.account_code,
    c.xero_option,
    c.our_option,
    c.amount_ex,
    c.on_job
  FROM combined AS c
  ORDER BY c.src_ord, c.document_id COLLATE "C", c.line_ord, c.part_ord;
END $fn$;

REVOKE ALL ON FUNCTION public.division_tieout_our_lines(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.division_tieout_our_lines(uuid, date)
  TO service_role;
