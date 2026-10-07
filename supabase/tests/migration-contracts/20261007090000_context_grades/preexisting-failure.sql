-- Two states the guard must refuse before anything is created: the store now
-- accepts a kind this catalogue does not describe (its meaning would be
-- missing on the first read), and a function of one of this migration's names
-- was made by someone else.
DO $$
DECLARE c text;
BEGIN
 SELECT conname INTO c FROM pg_constraint
 WHERE conrelid = 'public.context_ledger_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%item_type = ANY%';
 EXECUTE format('ALTER TABLE public.context_ledger_items DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE public.context_ledger_items ADD CONSTRAINT context_ledger_items_item_type_check CHECK (item_type IN
 ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency', 'agreement', 'event', 'phase_note', 'promise')) NOT VALID;
CREATE FUNCTION public.context_grades_newest(p_kind text) RETURNS integer LANGUAGE sql AS $fn$ SELECT 1 $fn$;
