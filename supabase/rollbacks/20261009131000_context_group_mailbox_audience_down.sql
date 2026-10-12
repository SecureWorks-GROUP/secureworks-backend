-- Rollback of 20261009131000_context_group_mailbox_audience: every row the group mailbox audience
-- rule relabelled (the backfill or the reader's resolver: metadata.audience_relabel, rule
-- group_mailbox_audience_v1) takes back the label, counterpart, To and Cc, basis and captured time
-- its original recorded; a row the new reader saved under the rule (payload.audience_basis
-- group_thread or unknown, never relabelled) takes the label the old rule gave it (our own email
-- with no outside recipient: staff.email_internal, internal, no counterpart); a basis recorded
-- without a relabel (a confirmed label) is taken off; then the four functions are dropped. The
-- party-roles trigger re-stamps each row it writes. Nothing is deleted. A reading built while the
-- new labels stood is not marked for a re-read by this (each row's captured time goes back to
-- what it was). Redeploy the previous outlook-mail-capture with it: the new reader calls
-- context_email_audience_resolve, and a failed call only counts audience_resolve_errors.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Relabelled rows: the original back.
UPDATE public.business_events b SET
 event_type = b.metadata #>> '{audience_relabel,original,event_type}',
 direction = b.metadata #>> '{audience_relabel,original,direction}',
 payload = (b.payload - 'audience_basis' - 'recipients_from')
  || jsonb_build_object('email', coalesce(b.metadata #> '{audience_relabel,original,email}', 'null'::jsonb),
   'to', coalesce(b.metadata #> '{audience_relabel,original,to}', b.payload -> 'to', '[]'::jsonb),
   'cc', coalesce(b.metadata #> '{audience_relabel,original,cc}', b.payload -> 'cc', '[]'::jsonb))
  || CASE WHEN jsonb_typeof(b.metadata #> '{audience_relabel,original,audience_basis}') = 'string'
      THEN jsonb_build_object('audience_basis', b.metadata #> '{audience_relabel,original,audience_basis}') ELSE '{}'::jsonb END,
 metadata = b.metadata - 'audience_relabel',
 context_captured_at = CASE WHEN jsonb_typeof(b.metadata #> '{audience_relabel,original,captured_at}') = 'string'
  THEN (b.metadata #>> '{audience_relabel,original,captured_at}')::timestamptz ELSE b.context_captured_at END
WHERE b.metadata #>> '{audience_relabel,rule}' = 'group_mailbox_audience_v1'
 AND b.metadata #>> '{audience_relabel,original,event_type}' IS NOT NULL
 AND b.metadata #>> '{audience_relabel,original,direction}' IS NOT NULL;

-- 2. Rows the new reader saved under the rule: the old rule's label.
UPDATE public.business_events b SET
 event_type = 'staff.email_internal',
 direction = 'internal',
 payload = (b.payload - 'audience_basis') || jsonb_build_object('email', 'null'::jsonb)
WHERE b.source = 'outlook-mail-capture' AND b.payload ->> 'sender_kind' = 'ours'
 AND b.payload ->> 'audience_basis' IN ('group_thread', 'unknown')
 AND NOT coalesce(b.metadata ? 'audience_relabel', false);

-- 3. A basis recorded with no relabel (a confirmed label) is taken off.
UPDATE public.business_events b SET payload = b.payload - 'audience_basis'
WHERE b.source = 'outlook-mail-capture' AND b.payload ? 'audience_basis'
 AND NOT coalesce(b.metadata ? 'audience_relabel', false);

-- 4. The functions.
DROP FUNCTION IF EXISTS public.context_email_audience_resolve(jsonb);
DROP FUNCTION IF EXISTS public.context_email_audience_backfill(boolean);
DROP FUNCTION IF EXISTS public.context_email_audience_plan();
DROP FUNCTION IF EXISTS public.context_email_audience_topic(text);
