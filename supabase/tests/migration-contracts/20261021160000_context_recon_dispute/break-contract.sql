-- The writer accepts a staff call and records nothing, so the job view never shows a marker.
CREATE OR REPLACE FUNCTION public.context_recon_set_dispute(
  p_event uuid, p_user_id uuid, p_reason text)
RETURNS TABLE (reason text, disputed_by text, disputed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.users u WHERE u.id = p_user_id
         AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
    RAISE EXCEPTION 'recon_not_staff' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.business_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recon_subject_not_found' USING ERRCODE = 'P0002'; END IF;
  reason := NULL;
  disputed_by := NULL;
  disputed_at := NULL;
  RETURN NEXT;
END $$;
