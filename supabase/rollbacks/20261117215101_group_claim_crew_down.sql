DROP FUNCTION IF EXISTS public.group_claim_crew_sources(uuid);
DROP FUNCTION IF EXISTS public.group_claim_search_trades(uuid,text);
DROP FUNCTION IF EXISTS public.group_claim_update_crew(uuid,uuid,text,uuid[]);
DROP FUNCTION IF EXISTS public.group_claim_on_job(uuid,uuid);
DROP FUNCTION IF EXISTS public.group_claim_active_trade(uuid,uuid);
DROP INDEX IF EXISTS public.group_claim_recent_invoice_user_idx;
DROP INDEX IF EXISTS public.group_claim_clock_user_idx;
DROP INDEX IF EXISTS public.group_claim_people_search_idx;
