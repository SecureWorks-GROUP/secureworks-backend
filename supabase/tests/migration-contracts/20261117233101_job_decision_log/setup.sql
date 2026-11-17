-- Registered prerequisites supply the real four source tables.
-- Fixtures run only inside contract.sql's rolled-back transaction.
\if :{?decision_log_fixtures}
SET LOCAL session_replication_role = replica;
INSERT INTO public.organisations(id,name) VALUES
 ('00000000-0000-4000-8000-000000000401','Organisation') ON CONFLICT DO NOTHING;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
 ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401','ZZTEST-401','fencing','accepted');
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('00000000-0000-4000-8000-000000004019','00000000-0000-4000-8000-000000000401','Office','ops_manager');
INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader)
 VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401','rebuild','live','fixture');
INSERT INTO public.context_ledger_items(id,generation_id,job_id,item_key,item_type,status,from_role,what,opened_at,opened_by,written_by)
 VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401',
 '00000000-0000-4000-8000-000000000401','note:fixture','claim','open','unknown','Note',
 '2026-11-17 00:00Z','[]','model:fixture');
INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,at,by,evidence)
 VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401',
 '00000000-0000-4000-8000-000000000401',NULL,'open','2026-11-17 01:00Z','rule:record_close_v1',NULL);
INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,payload,metadata,
 occurred_at,attribution_status,attributed_at,attribution_checked_at,candidate_job_ids)
 VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401',
 'message','fixture','sms','inbound','{}','{"luna_outcome":"job"}','2026-11-17 00:00Z',
 'luna','2026-11-17 02:00Z','2026-11-17 03:00Z',ARRAY['00000000-0000-4000-8000-000000000401']::uuid[]);
INSERT INTO public.agent_action_proposals(id,job_id,actor,auth_mode,action,params,params_sha256,kind,summary,status,decided_by,decided_at)
 VALUES ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000401',
 'fixture','api_key','xero_approve','{}',repeat('a',64),'xero_approve','Action','carried_out',
 '00000000-0000-4000-8000-000000004019','2026-11-17 04:00Z');
INSERT INTO public.job_truth_weekly_samples(week,job_id,page,story_total,notes_total,marks,missing,read_by,read_at)
 VALUES ('2026-11-16','00000000-0000-4000-8000-000000000401','{}',3,2,
 '[{"target":"story","ref":"headline:1"}]','["Missing note"]',
 '00000000-0000-4000-8000-000000004019','2026-11-17 05:00Z');
\endif
