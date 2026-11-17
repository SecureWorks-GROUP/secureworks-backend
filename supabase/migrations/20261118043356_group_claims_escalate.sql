-- P1-13.9: dormant, bounded office escalation. No schedule is installed on merge.
CREATE OR REPLACE FUNCTION public.group_claims_escalate_due()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp SET statement_timeout = '120s' AS $function$
DECLARE g record; moved int := 0; pot numeric; job_number text; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'group_claim_flow_v1' AND enabled) THEN RETURN 0; END IF;
  -- P1-13.3's partial deadline index serves the bounded locking read.
  FOR g IN SELECT id, job_id, work_order_id, claim_state, claim_deadline_at
    FROM public.group_work_orders
    WHERE claim_state IN ('waiting_hours','waiting_approval','disputed')
      AND claim_deadline_at <= now()
    ORDER BY claim_deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.group_work_orders SET claim_state = 'with_office' WHERE id = g.id;
    INSERT INTO public.group_work_order_events(group_id,job_id,action,detail)
      VALUES(g.id,g.job_id,'escalate',jsonb_build_object(
        'previous_state',g.claim_state,'deadline_at',g.claim_deadline_at));
    moved := moved + 1;
    -- The optional office writer must never undo the state or event.
    <<office_item>> BEGIN
      IF to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NOT NULL THEN
        -- Primary-key lookups, not a projection that needs the missing hours.
        SELECT agreed_labour_ex INTO pot FROM public.work_orders WHERE id = g.work_order_id;
        SELECT j.job_number INTO job_number FROM public.jobs j WHERE j.id = g.job_id;
        PERFORM public.reconcile_item_raise('group_claim_no_agreement','group_work_orders',g.id::text,
          ARRAY[g.job_id],jsonb_build_object('action','settle_group_claim','words',
            'Check the hours with the crew, then issue the invoices on the split or fix the hours.'),
          jsonb_build_object('reason',CASE WHEN g.claim_state = 'disputed'
              THEN 'group_split_disputed' ELSE 'group_no_answer_48h' END,
            'amount_ex',pot,'summary',jsonb_build_object('words',
              'The crew did not agree the split in 48 hours.','job_number',job_number),
            'previous_state',g.claim_state,'deadline_at',g.claim_deadline_at),
          'phase1:group_claim');
      ELSE
        RAISE NOTICE 'group_claim_office_writer_missing: %',g.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'group_claim_office_item_failed: %, SQLSTATE %',g.id,SQLSTATE;
    END;
  END LOOP;
  RETURN moved;
END; $function$;

-- Director-only activation after ZZTEST proof; repeated installs replace one named job.
CREATE OR REPLACE FUNCTION public.install_group_claims_escalate()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$ BEGIN
  PERFORM cron.schedule('group-claims-escalate','*/15 * * * *',
    'SELECT public.group_claims_escalate_due();');
END; $function$;
CREATE OR REPLACE FUNCTION public.remove_group_claims_escalate()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE existing bigint; BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR existing IN SELECT jobid FROM cron.job WHERE jobname = 'group-claims-escalate' LOOP
      PERFORM cron.unschedule(existing);
    END LOOP;
  END IF;
END; $function$;
REVOKE ALL ON FUNCTION public.group_claims_escalate_due(),public.install_group_claims_escalate(),
  public.remove_group_claims_escalate() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.group_claims_escalate_due(),public.install_group_claims_escalate(),
  public.remove_group_claims_escalate() TO service_role;
