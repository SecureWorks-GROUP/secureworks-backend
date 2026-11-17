DO $$ BEGIN
 IF to_regclass('public.xero_supplier_credit_note_allocations') IS NULL THEN
   RAISE EXCEPTION 'credit sync setup: allocations missing'; END IF;
END $$;
