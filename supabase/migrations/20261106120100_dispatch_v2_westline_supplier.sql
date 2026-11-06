-- Dispatch v2: add Westline Fencing to the approved supplier order email list.
--
-- Shaun, 6 Nov 2026: Westline Fencing is an approved fencing supplier. Orders
-- go To info@westlinefencing.com.au, nobody on CC. We have no account with
-- them, so they are pay first (on_account false): a quote reply moves the
-- order to Awaiting payment until someone presses Mark paid.
--
-- No Xero link. On 6 Nov 2026 there is no Westline contact in Xero (checked
-- read only: no suppliers row by name or email), so this adds no row to
-- dispatch_approved_supplier_email_links. Until a Westline supplier contact
-- exists in Xero and is linked to this entry, an order sent to Westline from
-- Outlook waits under Emails to sort ("no Xero supplier contact linked").
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3g.3.
-- Nothing here touches suppliers (the 06:55 Xero sync owns it), jobs, orders,
-- Xero, GHL, SMS or email. Running it again changes nothing (ON CONFLICT on
-- the org and name).
--
-- Rollback: supabase/rollbacks/20261106120100_dispatch_v2_westline_supplier_down.sql.

INSERT INTO public.dispatch_approved_supplier_emails
  (org_id, name, used_for, to_emails, cc_emails, on_account, active, approved_by, approved_on)
VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid, 'Westline Fencing', 'fencing',
   ARRAY['info@westlinefencing.com.au']::text[], ARRAY[]::text[], false, true, 'Shaun', DATE '2026-11-06')
ON CONFLICT (org_id, name) DO NOTHING;
