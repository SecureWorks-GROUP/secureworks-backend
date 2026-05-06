-- Trade Reimbursement + Expense Management — v1 evidence contract
-- Card: Finance-AI-First/trade-reimbursement-expense-management
-- Date: 2026-05-06
--
-- Adds the columns + storage bucket needed to make the existing OCR-assisted
-- expense pathway evidence-rich and DRAFT-only. Pairs with the ops-api code
-- changes in the same PR. Apply manually after PR review.
--
-- This migration is additive only:
--   * No drops, no renames, no destructive backfills.
--   * Existing rows pushed to Xero before this lands keep their xero_bill_id.
--     They are tagged legacy_accpay_push=true so analytics can split pre-DRAFT
--     rows from post-DRAFT rows.

-- ── 1. expense_receipts: evidence-contract columns ──────────────────────────

alter table expense_receipts
  add column if not exists flow text
    check (flow in ('reimbursement','company_expense','supplier_bill','unknown'))
    default 'unknown',
  add column if not exists category text
    check (category in (
      'fuel','materials','tools','parking','meals','accommodation',
      'consumables','utilities','vehicle_maintenance','professional_services',
      'other','unknown'
    ))
    default 'unknown',
  add column if not exists payment_method text
    check (payment_method in (
      'personal_card','company_card','cash','supplier_invoice','unknown'
    ))
    default 'unknown',
  add column if not exists business_category text,

  -- Submitter snapshot (survives role/name changes)
  add column if not exists submitter_role_at_submission text,
  add column if not exists submitter_display_name text,

  -- GST handling for non-GST suppliers
  add column if not exists gst_status text
    check (gst_status in ('included','excluded','non_gst_supplier','unknown'))
    default 'unknown',

  -- Evidence integrity
  add column if not exists receipt_storage_path text,
  add column if not exists receipt_sha256 text,
  add column if not exists receipt_storage_bucket text,
  add column if not exists no_receipt_reason text,

  -- OCR / classification audit trail
  add column if not exists field_confidence jsonb default '{}'::jsonb,
  add column if not exists jarvis_job_suggestion jsonb default '{}'::jsonb,

  -- Preflight + Xero state
  add column if not exists preflight_failed_reasons jsonb,
  add column if not exists xero_status text
    check (xero_status in ('draft','authorised','voided','paid','unknown'))
    default 'unknown',
  add column if not exists legacy_accpay_push boolean not null default false,

  -- Reason fields for queried/rejected rows
  add column if not exists query_reason text,
  add column if not exists rejection_reason text,

  -- Approver routing as a real FK (alongside the legacy 'shaun'/'jan' string).
  -- Application code populates this in submit_expense; approveExpense uses it
  -- to authorise the caller. Old text column stays for backwards-compat.
  add column if not exists approval_routed_to_user_id uuid references users(id);

create index if not exists idx_expense_receipts_flow on expense_receipts(flow);
create index if not exists idx_expense_receipts_payment_method on expense_receipts(payment_method);
create index if not exists idx_expense_receipts_xero_status on expense_receipts(xero_status);

-- One-shot backfill: tag every row that has already been pushed to Xero so
-- post-DRAFT analytics can exclude them. This runs once on apply; new pushes
-- after this migration set legacy_accpay_push=false (the column default) and
-- set xero_status='draft' explicitly via the application code.
update expense_receipts
   set legacy_accpay_push = true
 where xero_bill_id is not null
   and legacy_accpay_push = false;

-- ── 2. New status values are accepted by application logic, no enum change ──
-- Existing status column is text with no enum constraint. Application code
-- now uses these values in addition to the old set:
--   submitted, pending_extraction, pending, approved,
--   xero_pushed (was: pushed_to_xero — both are accepted),
--   queried, rejected
-- A future migration can lock to an enum once the app is stable.

-- ── 3. Storage bucket: dedicated, public-read by random UUID path ───────────
--
-- Bucket "expense-receipts" holds receipt photos / supplier-bill PDFs. Path
-- convention: {org_id}/{yyyy}/{mm}/{expense_id}-{rand}.{ext} where rand is a
-- short random suffix, so a leaked org_id alone does not reveal the file. We
-- match the existing 'job-photos' bucket pattern (public=true) because the
-- Haiku OCR pass is an external fetch and signed-URL expiry made the prior
-- private design fragile. The path is unguessable in practice; sensitive PII
-- on receipts (cardholder name, last-4) is not collected.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-receipts',
  'expense-receipts',
  true,
  20971520,  -- 20 MB ceiling on a single receipt; redundant with client compression
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']
)
on conflict (id) do nothing;

-- Insert: service-role only (signed URL pattern via ops-api). Public read
-- comes from public=true on the bucket itself, no policy needed.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'expense_receipts_service_write'
  ) then
    create policy expense_receipts_service_write on storage.objects
      for insert to service_role
      with check (bucket_id = 'expense-receipts');
  end if;
end $$;

-- ── 4. Notes on expense_receipts read RLS ───────────────────────────────────
--
-- The existing 20260322000010_spine_infrastructure.sql does NOT add a SELECT
-- policy on expense_receipts (service-role only). Trade workers cannot query
-- the table directly. We are NOT adding a user-level SELECT policy in this
-- migration — the Trade UI's "My expenses" view should read via an ops-api
-- endpoint (list_expenses) that already does its own filtering. Adding an
-- RLS policy would be a separate, future change after the surface is built.

comment on column expense_receipts.flow is
  'reimbursement = worker out-of-pocket; company_expense = company-card or float spend; supplier_bill = supplier-issued invoice PDF';
comment on column expense_receipts.payment_method is
  'Drives Xero behaviour: personal_card → bill against merchant (reclass deferred); company_card → DRAFT bill, bank-feed reconciles later; cash → DRAFT bill against vendor; supplier_invoice → DRAFT bill against supplier';
comment on column expense_receipts.receipt_sha256 is
  'SHA256 of the uploaded receipt bytes, computed server-side at confirm_upload. Immutable after first set; used to prove evidence has not been swapped.';
comment on column expense_receipts.legacy_accpay_push is
  'true for rows pushed to Xero before the DRAFT-only enforcement landed (likely AUTHORISED). Used to filter analytics; not used by application logic.';
comment on column expense_receipts.field_confidence is
  'Per-field Haiku extraction confidence. Replaces the hard-coded 0.8 single-field value. Shape: {"vendor_name":0.9,"total_amount":0.95,...}';
comment on column expense_receipts.jarvis_job_suggestion is
  'Audit trail of what suggest_job_for_expense proposed vs what the human chose. Shape: {"suggestions":[{"job_id":"...","score":0.9,"reason":"clocked_on"}],"chosen":"...","chosen_via":"jarvis_top|jarvis_alt|manual_search|general_business"}';
