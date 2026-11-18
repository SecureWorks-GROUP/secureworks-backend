-- P2-03.2 rollback: drop the three functions this migration created.
-- The list, the log and every row they hold are P2-03.1's and stay.
DROP FUNCTION IF EXISTS public.reconcile_item_withdraw(text,text,text,text);
DROP FUNCTION IF EXISTS public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.reconcile_item_org(text,text,uuid[]);
