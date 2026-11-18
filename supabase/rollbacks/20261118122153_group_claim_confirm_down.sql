SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DROP FUNCTION IF EXISTS public.group_claim_decide(uuid,uuid,text,text,text),public.group_claim_hours(uuid,uuid,text,jsonb,jsonb),
  public.group_claim_read(uuid,uuid),public.group_claim_clock(uuid,uuid),public.group_claim_current_hash(uuid),public.group_claim_member(uuid,uuid);
