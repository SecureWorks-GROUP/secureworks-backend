-- Dispatch v2: which approved suppliers we have an account with.
--
-- Shaun, 29 Oct 2026: five suppliers are on account (we are billed later):
-- Bunnings, Fence Makers, Fencing Warehouse WA, R&R Fencing and Stratco WA.
-- Every other supplier is paid first, so their orders get a payment step
-- (Awaiting payment until someone presses Mark paid). The list lives in one
-- place, on the approved supplier order email list; there is no tick on the
-- supplier box.
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3c. Rules:
-- supabase/functions/ops-api/dispatch_v2_payment.ts (dispatchV2PaymentTerms).
-- Readers: dispatch_board.ts (the board and dispatch_arrival) and
-- dispatch_v2_store.ts (the materials panel).
--
-- One column, false for every entry, then true for exactly the five names as
-- they are stored (checked read only on 29 Oct 2026: all five present and
-- active, 26 entries in all). A name that is missing on a copy of the database
-- simply matches nothing. Nothing here touches suppliers (the 06:55 Xero sync
-- owns it), jobs, purchase orders, Xero, GHL, SMS or email.
--
-- Rollback: supabase/rollbacks/20261029120000_dispatch_v2_on_account_suppliers_down.sql.

ALTER TABLE public.dispatch_approved_supplier_emails
  ADD COLUMN IF NOT EXISTS on_account boolean NOT NULL DEFAULT false;

UPDATE public.dispatch_approved_supplier_emails
SET on_account = true,
    updated_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name IN ('Bunnings', 'Fence Makers', 'Fencing Warehouse WA', 'R&R Fencing', 'Stratco WA')
  AND on_account = false;

COMMENT ON COLUMN public.dispatch_approved_supplier_emails.on_account IS
  'Dispatch v2: true = we have an account with this supplier (no payment step). false = pay first: a quote reply moves the order to Awaiting payment and a confirmed date does not confirm it until Mark paid. Set by Shaun, 29 Oct 2026.';
