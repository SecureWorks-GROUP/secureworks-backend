-- Dispatch v2: where each supplier order is at (the material stage), set by a
-- person on the order's supplier box.
--
-- Shaun and Marnin, 27 Oct 2026: the job's stage (Order Materials through
-- Scheduled, and now In Progress and Rectification) is one thing; where the
-- materials themselves are at is another, and it needs its own stages, each
-- saying who it is waiting on:
--
--   order_materials   Order materials       waiting on us (send the list)
--   sent              Sent to supplier      waiting on the supplier
--   quote_received    Quote received        waiting on us (check the quote)
--   awaiting_payment  Awaiting payment      waiting on us (pay the supplier)
--   order_confirmed   Order confirmed       paid and dated: on us until the
--                                           install is booked, then supplier
--   manufacturing     Manufacturing         waiting on the supplier
--   ready             Materials ready       waiting on us (delivery or pickup)
--   delivered         Delivered             done
--
-- Contract: docs/dispatch-v2-board-contract.md, section 3b. Rules and readers:
-- supabase/functions/ops-api/dispatch_v2_material_stage.ts (the stage list,
-- the stage a box shows and the set press) and dispatch_board.ts (the board's
-- Arrival line and the Waiting on us flag).
--
-- In v2 one supplier box (job_material_suppliers) is one supplier's orders on
-- a job, so the stage lives on the box. Three nullable columns and one check:
-- every existing box and every other Dispatch action is untouched. A box with
-- no stage of its own shows one worked out from its lines and order emails
-- (code, not here). No table, trigger, function or publication. Nothing here
-- writes jobs, purchase_orders, suppliers, Xero, GHL, SMS or email.
--
-- Writer: dispatch_v2_set_material_stage (a person's press, audited in
-- job_events). It never moves the job's own stage.
--
-- Rollback: supabase/rollbacks/20261028170000_dispatch_v2_material_stages_down.sql.

ALTER TABLE public.job_material_suppliers
  ADD COLUMN IF NOT EXISTS material_stage text NULL,
  ADD COLUMN IF NOT EXISTS material_stage_set_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS material_stage_set_by_email text NULL;

DO $$
BEGIN
  -- Only the eight stages, and a stage always says when and by whom it was
  -- set.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_suppliers_material_stage_valid'
                 AND conrelid = 'public.job_material_suppliers'::regclass) THEN
    ALTER TABLE public.job_material_suppliers
      ADD CONSTRAINT job_material_suppliers_material_stage_valid
      CHECK (
        material_stage IS NULL
        OR (
          material_stage IN ('order_materials', 'sent', 'quote_received', 'awaiting_payment',
                             'order_confirmed', 'manufacturing', 'ready', 'delivered')
          AND material_stage_set_at IS NOT NULL
          AND material_stage_set_by_email IS NOT NULL
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.job_material_suppliers.material_stage IS
  'Dispatch v2: where this supplier''s order is at, set by a person (order_materials, sent, quote_received, awaiting_payment, order_confirmed, manufacturing, ready, delivered). Null = worked out from the box''s lines and order emails.';
COMMENT ON COLUMN public.job_material_suppliers.material_stage_set_at IS
  'Dispatch v2: when a person last set the material stage. A newer order email sent from the box puts it back to Sent to supplier.';
