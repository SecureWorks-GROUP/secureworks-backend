-- Draft register, check 10, after the director's first ZZTEST draft with the
-- switch on. Needs psql variable xero_document_id (the ZZTEST draft's Xero id).
-- PASS: exactly one register row for the job's organisation and that id; it
-- names the ZZTEST job; its document type fits its register row; the
-- fingerprint is a SHA-256 hex; each has_* flag agrees with the problems
-- listed; approval columns are all empty until Xero shows it approved; and an
-- office draft (X3, X9) with problems has one open 'draft_incomplete' item
-- for this document, while a trade bill or receipt (X6, X7) has none.
-- Until the raise door (check 9) is fixed, an X3 or X9 draft with problems
-- FAILs here on its item, by design. Evidence carries no amount.
\set zz_check 'draft_register.first_draft_readback'
\ir ../session.sql
\if :{?xero_document_id}
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"psql variable xero_document_id not given"}' AS evidence
\quit
\endif
WITH r AS (
  SELECT * FROM public.xero_draft_register
  WHERE org_id = :'zz_org_id' AND xero_document_id = :'xero_document_id'
), codes AS (
  SELECT coalesce(array_agg(DISTINCT p ->> 'code'), '{}') AS c
  FROM r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.problems) = 'array' THEN r.problems ELSE '[]' END) p
), items AS (
  SELECT count(*) AS open_items FROM public.reconcile_items i
  WHERE i.kind = 'draft_incomplete' AND i.subject_table = 'xero_draft_register'
    AND i.subject_id = :'xero_document_id' AND i.status = 'open'
), v AS (
  SELECT (SELECT count(*) FROM r) AS rows_found, r.*, codes.c, items.open_items,
    r.job_ids @> ARRAY[:'zz_job_id'::uuid] AS names_job,
    CASE r.register_row WHEN 'X3' THEN r.document_type = 'ACCREC'
                        WHEN 'X6' THEN r.document_type = 'ACCPAY'
                        WHEN 'X7' THEN r.document_type = 'ACCPAY'
                        WHEN 'X9' THEN r.document_type IN ('ACCPAY', 'ACCPAYCREDIT') END AS type_fits_row,
    r.lines_fingerprint ~ '^[0-9a-f]{64}$' AS fingerprint_shape,
    r.has_account_codes = NOT ('account_code_missing' = ANY (codes.c))
      AND r.has_division_tags = NOT (codes.c && ARRAY['division_not_known','division_option_not_active','options_not_loaded'])
      AND r.has_job_reference = NOT ('job_reference_missing' = ANY (codes.c))
      AND r.has_source_document = NOT ('source_document_missing' = ANY (codes.c)) AS flags_match_problems,
    (r.approved_seen_at IS NULL AND r.approved_fingerprint IS NULL AND r.edited_before_approval IS NULL)
      OR (r.approved_seen_at IS NOT NULL AND r.approved_fingerprint IS NOT NULL) AS approval_consistent,
    CASE WHEN r.register_row IN ('X3', 'X9') AND cardinality(codes.c) > 0 THEN items.open_items = 1
         ELSE items.open_items = 0 END AS item_as_expected
  FROM codes, items LEFT JOIN r ON true
)
SELECT :'zz_check' AS "check",
       CASE WHEN v.rows_found = 1 AND v.names_job AND v.type_fits_row AND v.fingerprint_shape
             AND v.flags_match_problems AND v.approval_consistent AND v.item_as_expected THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('rows_found', v.rows_found, 'register_row', v.register_row, 'document_type', v.document_type,
                          'source_kind', v.source_kind, 'drafted_at', v.drafted_at, 'names_job', v.names_job,
                          'type_fits_row', v.type_fits_row, 'fingerprint_shape', v.fingerprint_shape,
                          'problem_codes', to_jsonb(v.c), 'flags_match_problems', v.flags_match_problems,
                          'approved_seen_at', v.approved_seen_at, 'approval_consistent', v.approval_consistent,
                          'open_draft_incomplete_items', v.open_items, 'item_as_expected', v.item_as_expected)::text AS evidence
FROM v;
