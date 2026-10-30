-- A Zoo-shaped crew: rates 50/55/43, hours 18/18/18.5, an approved $2,720
-- all-in pool and an attributed office sign-off. Two shares are submitted on
-- the 12/6 basis, the owner moves the group to full employer super, the crew
-- resubmit, and the whole crew is released together. Synthetic records only;
-- every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  -- The seeded work-order approver, as in the 20261028070000 contract.
  office uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  henry uuid := 'f0310000-0000-4000-8000-00000000000a';
  isaac uuid := 'f0310000-0000-4000-8000-00000000000b';
  ryan uuid := 'f0310000-0000-4000-8000-00000000000c';
  job uuid := 'f0310000-0000-4000-8000-000000000101';
  wo uuid := 'f0310000-0000-4000-8000-000000000301';
  grp uuid := 'f0310000-0000-4000-8000-000000000201';
  r jsonb; v_state jsonb; v_claim jsonb; v_amend jsonb;
  inv_h uuid; inv_i uuid; inv_h2 uuid; inv_i2 uuid; inv_r2 uuid;
  refused boolean;
  shares numeric[];

  -- Inserts an invoice and its single group-share line for one crew member.
  -- basis null = 12/6 split; employer_12_v2 = full employer super.
BEGIN
  -- 1. The pure split, for Zoo's three shares.
  r := public.group_work_order_pay_for_basis('all_in_12_v2', 911.56);
  IF (r->>'invoice_ex')::numeric <> 813.89 OR (r->>'cash_pay')::numeric <> 813.89 OR (r->>'super_amount')::numeric <> 97.67
     OR (r->>'budget_remainder')::numeric <> 0 THEN RAISE EXCEPTION 'v2 split for 911.56 wrong: %', r; END IF;
  r := public.group_work_order_pay_for_basis('all_in_12_v2', 1002.72);
  IF (r->>'invoice_ex')::numeric <> 895.29 OR (r->>'super_amount')::numeric <> 107.43 THEN RAISE EXCEPTION 'v2 split for 1002.72 wrong: %', r; END IF;
  r := public.group_work_order_pay_for_basis('all_in_12_v2', 805.72);
  IF (r->>'invoice_ex')::numeric <> 719.39 OR (r->>'super_amount')::numeric <> 86.33 THEN RAISE EXCEPTION 'v2 split for 805.72 wrong: %', r; END IF;

  -- 2. Fixture: a 12/6 group, frozen, office signed off.
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (office,org,'Synthetic Office','ops_manager'),(henry,org,'Henry Synthetic','crew'),
    (isaac,org,'Isaac Synthetic','crew'),(ryan,org,'Ryan Synthetic','crew') ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','quoted','SYN-ZOO-RELEASE');
  INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
    VALUES(wo,org,job,'SYN-ZOO-WO','job','draft',2160,'[]','Synthetic release proof');
  UPDATE public.work_orders SET status='approved',approved_by=office WHERE id=wo;
  INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token,pay_basis,approved_budget_ex,budget_approved_by,budget_approved_at,budget_approval_reason)
    VALUES(grp,org,job,wo,'synthetic-zoo-release-token','all_in_12_6_v1',2720,office,now(),'Synthetic owner budget');
  INSERT INTO public.group_work_order_participants(group_id,user_id) VALUES(grp,henry),(grp,isaac),(grp,ryan);
  INSERT INTO public.trade_rates(id,org_id,user_id,hourly_rate,effective_from) VALUES
    (gen_random_uuid(),org,henry,50,'2026-01-01'),(gen_random_uuid(),org,isaac,55,'2026-01-01'),(gen_random_uuid(),org,ryan,43,'2026-01-01');
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status) VALUES
    (gen_random_uuid(),job,henry,'2026-10-19','scheduled'),(gen_random_uuid(),job,isaac,'2026-10-19','scheduled'),(gen_random_uuid(),job,ryan,'2026-10-19','scheduled');
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours) VALUES
    (grp,henry,'2026-10-19','07:00','16:30',30,18),(grp,isaac,'2026-10-19','07:00','16:30',30,18),(grp,ryan,'2026-10-19','07:00','16:45',30,18.5);
  INSERT INTO public.job_client_signoffs(job_id,method,waiver_reason,captured_by_actor,created_at)
    VALUES(job,'office_waiver','Synthetic owner-authorised office sign-off','user:'||office,clock_timestamp() + interval '1 second');
  PERFORM public.freeze_group_work_order_split(grp);
  SELECT array_agg(share_ex ORDER BY user_id) INTO shares FROM public.group_work_order_shares WHERE group_id=grp;
  IF shares <> ARRAY[911.56,1002.72,805.72]::numeric[] THEN RAISE EXCEPTION 'Zoo-shaped shares wrong: %', shares; END IF;

  -- 3. A frozen group's basis cannot be changed by a plain update.
  refused := false;
  BEGIN UPDATE public.group_work_orders SET pay_basis='all_in_12_v2' WHERE id=grp;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_split_frozen'; END;
  IF NOT refused THEN RAISE EXCEPTION 'frozen basis changed without an amendment'; END IF;

  -- 4. Henry and Isaac submit on 12/6; Isaac is approved.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',859.96,859.96,0,859.96,false,0.12,103.20,808.36,'SYN-H-1') RETURNING id INTO inv_h;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_h,job,'group share',859.96);
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,isaac,'pending_acknowledgment',945.96,945.96,0,945.96,false,0.12,113.52,889.20,'SYN-I-1') RETURNING id INTO inv_i;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_i,job,'group share',945.96);
  UPDATE public.trade_invoice_lines SET office_review_status='approved' WHERE trade_invoice_id=inv_i;
  UPDATE public.trade_invoices SET status='approved' WHERE id=inv_i;

  -- 5. Not ready: Ryan has not invoiced, Henry is not approved.
  v_state := public.group_work_order_release_state(grp);
  IF (v_state->>'ready')::boolean OR NOT (v_state->'reasons' ? 'share_not_invoiced') OR NOT (v_state->'reasons' ? 'share_not_approved')
     OR (v_state->>'invoiced')::int <> 2 OR (v_state->>'approved')::int <> 1 OR v_state->>'signoff' <> 'office' THEN
    RAISE EXCEPTION 'release state before resubmission wrong: %', v_state;
  END IF;
  v_claim := public.claim_group_work_order_release(grp, 'user:'||office, office);
  IF (v_claim->>'claimed')::boolean OR EXISTS (SELECT 1 FROM public.group_work_order_releases WHERE group_id=grp) THEN
    RAISE EXCEPTION 'an unready group was released: %', v_claim;
  END IF;

  -- 6. Owner amendment: both open invoices go back with the reason; basis moves.
  refused := false;
  BEGIN PERFORM public.amend_group_work_order_pay_basis(grp,'all_in_12_v2',office,'short');
  EXCEPTION WHEN invalid_parameter_value THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'amendment accepted without a reason'; END IF;
  v_amend := public.amend_group_work_order_pay_basis(grp,'all_in_12_v2',office,'Super corrected to full 12%. Please resubmit.');
  IF jsonb_array_length(v_amend->'returned_invoices') <> 2
     OR (SELECT pay_basis FROM public.group_work_orders WHERE id=grp) <> 'all_in_12_v2'
     OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id IN (inv_h,inv_i) AND status <> 'ops-reject')
     OR EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id IN (inv_h,inv_i) AND office_review_status <> 'rejected')
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_events WHERE group_id=grp AND action='amend_pay_basis'
       AND actor_user_id=office AND detail->>'from'='all_in_12_6_v1' AND detail->>'to'='all_in_12_v2') THEN
    RAISE EXCEPTION 'amendment did not return invoices, move basis and log: %', v_amend;
  END IF;
  IF (SELECT count(*) FROM public.trade_invoices WHERE id IN (inv_h,inv_i)) <> 2 THEN
    RAISE EXCEPTION 'amendment deleted an original invoice';
  END IF;

  -- 7. A share on the new basis needs an employer-super invoice.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay)
      VALUES(org,henry,'pending_acknowledgment',813.89,813.89,0,813.89,false,0.12,97.67,765.06) RETURNING id INTO inv_h2;
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_h2,job,'group share',813.89);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_super_basis_mismatch';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'v2 share accepted on a 12/6 invoice'; END IF;
  -- And the stored split must say net equals gross.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis)
      VALUES(org,henry,'pending_acknowledgment',813.89,813.89,0,813.89,false,0.12,97.67,765.06,'employer_12_v2');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'employer-super invoice accepted with super withheld'; END IF;

  -- 8. Henry and Isaac resubmit on full employer super; Ryan has not yet.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,henry,'pending_acknowledgment',813.89,813.89,0,813.89,false,0.12,97.67,813.89,'employer_12_v2','SYN-H-2') RETURNING id INTO inv_h2;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_h2,job,'group share',813.89);
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,isaac,'pending_acknowledgment',895.29,895.29,0,895.29,false,0.12,107.43,895.29,'employer_12_v2','SYN-I-2') RETURNING id INTO inv_i2;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_i2,job,'group share',895.29);
  v_claim := public.claim_group_work_order_release(grp, 'user:'||henry, henry);
  IF (v_claim->>'claimed')::boolean OR NOT (v_claim->'state'->'reasons' ? 'share_not_invoiced')
     OR (v_claim->'state'->'reasons' ? 'share_not_approved') THEN
    RAISE EXCEPTION 'released before Ryan invoiced, or asked for office approval: %', v_claim;
  END IF;

  -- 9. Ryan submits. An office query still holds the whole crew; once it is
  -- cleared, the last submission releases everyone together, with no office
  -- approval of each share (owner, 30 Oct 2026).
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,ryan,'pending_acknowledgment',719.39,719.39,0,719.39,false,0.12,86.33,719.39,'employer_12_v2','SYN-R-2') RETURNING id INTO inv_r2;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_r2,job,'group share',719.39);
  refused := false;
  BEGIN INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex) VALUES(inv_r2,job,'travel',10);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_super_basis_mismatch'; END;
  IF NOT refused THEN RAISE EXCEPTION 'extra line accepted on an employer-super invoice'; END IF;
  UPDATE public.trade_invoice_lines SET office_review_status='queried' WHERE trade_invoice_id=inv_r2;
  v_claim := public.claim_group_work_order_release(grp, 'user:'||ryan, ryan);
  IF (v_claim->>'claimed')::boolean OR NOT (v_claim->'state'->'reasons' ? 'share_queried') THEN
    RAISE EXCEPTION 'released while the office had a share queried: %', v_claim;
  END IF;
  UPDATE public.trade_invoice_lines SET office_review_status='awaiting' WHERE trade_invoice_id=inv_r2;
  v_claim := public.claim_group_work_order_release(grp, 'user:'||ryan, ryan);
  IF NOT (v_claim->>'claimed')::boolean OR (v_claim->>'existing')::boolean
     OR (v_claim->'state'->>'allocated_ex')::numeric <> 2720 OR (v_claim->'state'->>'approved')::int <> 3
     OR EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id IN (inv_h2,inv_i2,inv_r2) AND office_review_status <> 'approved')
     OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id IN (inv_h2,inv_i2,inv_r2) AND status <> 'approved')
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_events WHERE group_id=grp AND action='release') THEN
    RAISE EXCEPTION 'complete crew was not released together: %', v_claim;
  END IF;
  v_claim := public.claim_group_work_order_release(grp, 'user:'||office, office);
  IF NOT (v_claim->>'existing')::boolean OR (SELECT count(*) FROM public.group_work_order_releases WHERE group_id=grp) <> 1 THEN
    RAISE EXCEPTION 'a second claim did not return the same release';
  END IF;

  -- 10. After release nothing may undo it.
  refused := false;
  BEGIN UPDATE public.trade_invoice_lines SET office_review_status='rejected' WHERE trade_invoice_id=inv_h2;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'a released share was rejected'; END IF;
  refused := false;
  BEGIN UPDATE public.trade_invoices SET status='ops-reject' WHERE id=inv_i2;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'a released invoice was returned'; END IF;
  refused := false;
  BEGIN INSERT INTO public.job_client_signoffs(job_id,method,captured_by_actor,created_at) VALUES(job,'revoked','user:'||office,clock_timestamp());
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'sign-off revoked after release'; END IF;
  refused := false;
  BEGIN UPDATE public.group_work_orders SET split_frozen_at=NULL WHERE id=grp;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'released split reopened'; END IF;
  refused := false;
  BEGIN PERFORM public.amend_group_work_order_pay_basis(grp,'all_in_12_v2',office,'Second amendment after release');
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'amended after release'; END IF;
  -- A returned (ops-reject) invoice's lines stay editable after release, and
  -- a returned invoice can be deleted; a released one cannot.
  UPDATE public.trade_invoice_lines SET office_review_note='old 12/6 copy' WHERE trade_invoice_id=inv_h;
  UPDATE public.trade_invoice_lines SET office_review_status='queried' WHERE trade_invoice_id=inv_h;
  DELETE FROM public.trade_invoices WHERE id=inv_i;
  refused := false;
  BEGIN DELETE FROM public.trade_invoices WHERE id=inv_r2;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_released'; END;
  IF NOT refused THEN RAISE EXCEPTION 'a released invoice was deleted'; END IF;
  -- Moving a released bill on to Xero is still allowed.
  UPDATE public.trade_invoices SET status='pushed_to_xero', xero_bill_id='synthetic-bill' WHERE id=inv_h2;
END $$;
SELECT 'PASS: Zoo-shaped 12/6 to full employer super, owner amendment, whole-crew release and post-release guards' AS result;
ROLLBACK;
