-- A rollback must retain pending evidence, not erase the refill obligation.
INSERT INTO public.job_profit_change_events(job_id,reason)
VALUES('ffffffff-ffff-4fff-8fff-ffffffffff45','rollback_fixture');
