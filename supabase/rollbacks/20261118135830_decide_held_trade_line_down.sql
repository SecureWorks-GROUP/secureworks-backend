SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP FUNCTION IF EXISTS public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text);
