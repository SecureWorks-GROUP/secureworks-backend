-- Keep structured Dispatch producer identity. The generic attribution trigger
-- was rewriting matched/direct_job_id dispatch-context/v1 rows to unresolved/none.
-- Additive. Does not copy dispatch_source_version. Does not weaken event_at.

CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.event_type='dispatch.plan.changed'
     AND coalesce(NEW.payload->>'contract_version','')='dispatch-context/v1'
     AND coalesce(NEW.match_method,'') IN ('direct_job_id','direct_reference','manual')
     AND NEW.job_id IS NOT NULL THEN
    IF NEW.event_at IS NULL THEN
      RAISE EXCEPTION 'dispatch_event_at_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id::text=NEW.job_id::text
        AND j.org_id::text=coalesce(NEW.payload->>'org_id','')
    ) THEN
      NEW.job_id:=NULL;
      NEW.match_status:='unresolved';
      NEW.match_method:='none';
      NEW.match_confidence:=NULL;
      NEW.attribution_status:='admin_bucket';
      NEW.attribution_step:=6;
      NEW.attribution_checked_at:=clock_timestamp();
      NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)||jsonb_build_object('attribution_error','dispatch_job_org_mismatch');
      RETURN NEW;
    END IF;
    NEW.attribution_status:='direct';
    NEW.attribution_step:=1;
    NEW.attribution_confidence:=1;
    NEW.attributed_at:=clock_timestamp();
    NEW.attribution_checked_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  NEW:=public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
