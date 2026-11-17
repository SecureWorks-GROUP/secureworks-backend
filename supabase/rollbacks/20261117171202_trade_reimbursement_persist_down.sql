-- P1-03.2: preserve receipt identity and office review in the atomic week save.
-- Receipt rows are outside priced work-order scope, but inside the invoice sum.
DO $patch$ DECLARE d text; before_text text; after_text text; expected integer; BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE expense_receipt_id IS NOT NULL) THEN RAISE EXCEPTION 'reimbursement persistence in use; rollback refused'; END IF;
  before_text := $before0$        'final_payout_deduction',
        'reimbursement'
      )
      GROUP BY$before0$;
  after_text := $after0$        'final_payout_deduction'
      )
      GROUP BY$after0$;
  expected := 1;
  IF (length(d) - length(replace(d, before_text, ''))) / length(before_text) <> expected THEN RAISE EXCEPTION 'reimbursement persist preimage 1 changed'; END IF;
  d := replace(d, before_text, after_text);
  before_text := $before1$WHERE COALESCE(input.line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$before1$;
  after_text := $after1$WHERE COALESCE(input.line->>'line_type', '') <> 'final_payout_deduction'$after1$;
  expected := 1;
  IF (length(d) - length(replace(d, before_text, ''))) / length(before_text) <> expected THEN RAISE EXCEPTION 'reimbursement persist preimage 2 changed'; END IF;
  d := replace(d, before_text, after_text);
  before_text := $before2$WHERE COALESCE(line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$before2$;
  after_text := $after2$WHERE COALESCE(line->>'line_type', '') <> 'final_payout_deduction'$after2$;
  expected := 3;
  IF (length(d) - length(replace(d, before_text, ''))) / length(before_text) <> expected THEN RAISE EXCEPTION 'reimbursement persist preimage 3 changed'; END IF;
  d := replace(d, before_text, after_text);
  before_text := $before3$    COALESCE(NULLIF(line->>'line_position', '')::integer, ordinality::integer - 1),
    NULLIF(line->>'expense_receipt_id', '')::uuid,
    NULLIF(line->>'office_review_status', ''),
    NULLIF(line->>'office_review_note', '')
  FROM jsonb_array_elements(p_lines)$before3$;
  after_text := $after3$    COALESCE(NULLIF(line->>'line_position', '')::integer, ordinality::integer - 1)
  FROM jsonb_array_elements(p_lines)$after3$;
  expected := 1;
  IF (length(d) - length(replace(d, before_text, ''))) / length(before_text) <> expected THEN RAISE EXCEPTION 'reimbursement persist preimage 4 changed'; END IF;
  d := replace(d, before_text, after_text);
  before_text := $before4$    line_position, expense_receipt_id, office_review_status, office_review_note
  )
  SELECT
    v_invoice_id,$before4$;
  after_text := $after4$    line_position
  )
  SELECT
    v_invoice_id,$after4$;
  expected := 1;
  IF (length(d) - length(replace(d, before_text, ''))) / length(before_text) <> expected THEN RAISE EXCEPTION 'reimbursement persist preimage 5 changed'; END IF;
  d := replace(d, before_text, after_text);
  EXECUTE d;
END $patch$;
