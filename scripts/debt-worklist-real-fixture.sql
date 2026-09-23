-- Debtor work list: real-data fixture export (read-only SELECT).
--
-- Produces supabase/functions/ops-api/fixtures/debt_worklist_open_book_v1.json,
-- the open receivable book plus every row the work list reads to place it,
-- as it stood in production. Run with the Management API read-only query (or
-- any read-only session) and save the single `fixture` value.
--
-- Pseudonymised: no debtor or client names, no references beyond the job-number
-- token the link resolver reads, no message bodies, note text or fact values,
-- no email addresses or phone numbers. Contact names become a stable hash so
-- "two contacts, one name" and "one contact, two names" survive as shapes.
-- Ids (Xero invoice/contact ids, job ids) and amounts are kept: they are the
-- identities and totals the work list must account for.
with open as (
  select * from xero_invoices
  where invoice_type = 'ACCREC' and status in ('AUTHORISED', 'SUBMITTED') and amount_due > 0
),
refjobs as (
  select j.id from jobs j join open o on o.job_id is null and upper(j.job_number) = upper(substring(
    coalesce(o.reference, '') || ' ' || coalesce(o.invoice_number, '') from '(SW[A-Za-z]{1,3}-\d{4,8})'))
),
cm as (
  select * from contact_matches
  where xero_contact_id in (select xero_contact_id from open where job_id is null)
),
alljobs as (
  select job_id as id from open where job_id is not null
  union select id from refjobs
  union select job_id from cm where job_id is not null
  union select id from jobs where ghl_contact_id in (select ghl_contact_id from cm where ghl_contact_id is not null)
),
ghl_ids as (select ghl_contact_id from jobs where id in (select id from alljobs) and ghl_contact_id is not null)
select json_build_object(
  'captured_at', now(),
  'xero_invoices', (select json_agg(json_build_object(
      'org_id', org_id, 'invoice_type', invoice_type, 'xero_invoice_id', xero_invoice_id,
      'xero_contact_id', xero_contact_id,
      'contact_name', 'Debtor ' || left(md5(lower(coalesce(contact_name, ''))), 8),
      'invoice_number', invoice_number,
      'reference', substring(coalesce(reference, '') from '(SW[A-Za-z]{1,3}-\d{4,8})'),
      'status', status, 'total', total, 'amount_due', amount_due, 'amount_paid', amount_paid,
      'invoice_date', invoice_date, 'due_date', due_date, 'job_id', job_id, 'job_number', job_number,
      'synced_at', synced_at, 'debt_classification', debt_classification, 'debt_type', debt_type,
      'debt_blocker', debt_blocker, 'debt_owner', debt_owner, 'debt_next_action_at', debt_next_action_at,
      'debt_next_action', case when debt_next_action is null then null else 'next action ' || left(md5(debt_next_action), 6) end,
      'debt_as_of', debt_as_of, 'debt_proposal_status', debt_proposal_status, 'debt_proposal_kind', debt_proposal_kind,
      'raw_json', json_build_object(
        'Contact', json_build_object('ContactID', raw_json->'Contact'->>'ContactID'),
        'SentToContact', raw_json->'SentToContact',
        'Payments', (select coalesce(json_agg(json_build_object('PaymentID', p->>'PaymentID', 'Date', p->>'Date', 'Amount', p->'Amount')), '[]'::json)
                     from jsonb_array_elements(coalesce(raw_json->'Payments', '[]'::jsonb)) p))
    ) order by xero_invoice_id) from open),
  'jobs', (select json_agg(json_build_object('id', id, 'job_number', job_number, 'status', status, 'type', type,
      'ghl_contact_id', case when ghl_contact_id is null then null else 'ghl-' || left(md5(ghl_contact_id), 12) end) order by id)
    from jobs where id in (select id from alljobs)),
  'contact_matches', (select coalesce(json_agg(json_build_object('xero_contact_id', xero_contact_id, 'job_id', job_id,
      'ghl_contact_id', case when ghl_contact_id is null then null else 'ghl-' || left(md5(ghl_contact_id), 12) end)), '[]'::json) from cm),
  'current_job_context_facts', (select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'kind', kind,
      'expires_at', expires_at, '_context_store', _context_store, 'extractor_version', extractor_version, 'trust', trust,
      'provenance', jsonb_strip_nulls(jsonb_build_object(
        'extractor', provenance->>'extractor', 'superseded_by', provenance->'superseded_by',
        'retracted_at', provenance->'retracted_at', 'lifecycle', provenance->'lifecycle',
        'safety', case when provenance->'safety' ? 'memory_trusted' then jsonb_build_object('memory_trusted', provenance->'safety'->'memory_trusted') end))
    ) order by id), '[]'::json) from current_job_context_facts where job_id in (select id from alljobs)),
  'extraction_jobs', (select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'status', status, 'skip_reason', skip_reason) order by id), '[]'::json)
    from extraction_jobs where job_id in (select id from alljobs)),
  'ghl_conversation_cache', (select coalesce(json_agg(json_build_object('job_id', job_id,
      'contact_id', case when contact_id is null then null else 'ghl-' || left(md5(contact_id), 12) end,
      'message_count', message_count, 'synced_at', synced_at)), '[]'::json)
    from ghl_conversation_cache where job_id in (select id from alljobs) or contact_id in (select ghl_contact_id from ghl_ids)),
  'inbox_events', (select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'received_at', received_at) order by id), '[]'::json)
    from inbox_events where job_id in (select id from alljobs)),
  'job_events', (select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'event_type', event_type) order by id), '[]'::json)
    from job_events where event_type = 'note' and job_id in (select id from alljobs)),
  'business_events', (select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'event_type', event_type, 'occurred_at', occurred_at) order by id), '[]'::json)
    from business_events where job_id in (select id from alljobs) and event_type in ('client.reply', 'client.email_in', 'client.email_out',
      'client.sms_in', 'client.sms_out', 'client.call_complete', 'client.message_in', 'supplier.email_in', 'ghl.note_added')),
  'payment_chase_logs', (select coalesce(json_agg(json_build_object('id', id, 'xero_invoice_id', xero_invoice_id, 'job_id', job_id,
      'method', method, 'outcome', outcome, 'follow_up_date', follow_up_date, 'follow_up_resolved', follow_up_resolved,
      'chased_by', 'operator', 'created_at', created_at) order by id), '[]'::json)
    from payment_chase_logs where xero_invoice_id in (select xero_invoice_id from open))
) as fixture;
