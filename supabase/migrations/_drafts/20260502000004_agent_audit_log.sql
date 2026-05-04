-- T7 Loop 1 — Agent audit log table (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration ("apply 20260502000004_agent_audit_log.sql"). Apply in Loop 4
-- alongside the SMS/GHL/MCP audit writer wave.
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 7 audit, Loop 4)
-- Closes:  T5-DEVQ-7 partial — agent_audit_log table missing per the Iter-2 audit
--          ("Three undefined tables (agent_audit_log, pending_outcomes, decision_memory).
--          Either silently failing or hand-drift on prod.")
--
-- Why:
-- Every MCP tool call by JARVIS / the agent should produce an auditable
-- record. Today the code references agent_audit_log but no migration creates
-- it. This is the migration. Each row is also mirrored to business_events
-- via recordEvidence with channel='audit', direction='system', so the audit
-- trail is part of the same Job Dossier surface.
--
-- This migration only ships the agent_audit_log table. The companion
-- pending_outcomes and decision_memory tables remain deferred to whichever
-- lane needs them; T7 does not need them for capture completeness.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.agent_audit_log CASCADE;
--   Time-to-revert: <2s.
--
-- Downstream impact (post-apply):
--   - Loop 4 wires every MCP tool call writer to insert here.
--   - Evidence Health page surfaces audit volume per tool.
--   - No live behavior change to JARVIS or any tool.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  -- Tool identity
  tool_name           text NOT NULL,                    -- e.g. 'sw_send_sms', 'sw_get_inbox'
  tool_version        text,
  -- Caller identity
  caller              text,                             -- 'jarvis' | 'human' | 'cron' | 'system'
  caller_user_id      uuid,
  caller_chat_id      text,                             -- Telegram chat id when applicable
  -- Job/context linkage
  job_id              text,                             -- text to match business_events.job_id
  contact_id          text,
  correlation_id      uuid,                             -- groups related tool calls (e.g. an approval flow)
  -- Verdict
  verdict             text NOT NULL                     -- 'approved' | 'rejected' | 'gated' | 'executed' | 'dry_run' | 'error'
                          CHECK (verdict IN (
                            'approved','rejected','gated','executed','dry_run','error'
                          )),
  policy_reason       text,                             -- why rejected/gated
  -- Payload (redacted)
  request_summary     text,                             -- <=500 char redacted summary
  response_summary    text,                             -- <=500 char redacted summary
  request_payload     jsonb NOT NULL DEFAULT '{}',      -- full payload (service-role read only)
  response_payload    jsonb NOT NULL DEFAULT '{}',
  -- Spine backref
  spine_event_id      uuid,                             -- business_events.id when mirrored via recordEvidence
  -- Cost / model usage (for AI tool calls)
  model               text,
  input_tokens        integer,
  output_tokens       integer,
  cost_usd            numeric(10,6),
  -- Errors
  error_message       text,
  error_stack         text,
  -- Metadata
  metadata            jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_occurred
  ON public.agent_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_tool
  ON public.agent_audit_log(tool_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_job
  ON public.agent_audit_log(job_id, occurred_at DESC)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_audit_verdict
  ON public.agent_audit_log(verdict, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_spine
  ON public.agent_audit_log(spine_event_id)
  WHERE spine_event_id IS NOT NULL;

ALTER TABLE public.agent_audit_log ENABLE ROW LEVEL SECURITY;

-- Service role: full. Tool writers run as service role.
CREATE POLICY "service_role_all" ON public.agent_audit_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated: SELECT only, for Evidence Health page and operator review.
-- Full payloads remain accessible only via ops-api (which checks role).
CREATE POLICY "authenticated_select" ON public.agent_audit_log
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.agent_audit_log IS
  'T7 + T5-DEVQ-7: every MCP tool call by JARVIS/agent. Mirrored to business_events with channel=audit via recordEvidence. Append-only; full payloads behind service_role + ops-api role check.';

COMMIT;
