\set ON_ERROR_STOP on
-- Disposable PostgreSQL database only. Minimal persistence boundary, not the
-- complete production schema/RPC. Execute the actual migration under test.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.trade_invoice_lines (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 line_type text, group_share_id uuid, office_review_status text
);
\ir ../migrations/20261028070000_group_share_office_review_insert.sql

-- Reproduce v1's explicit projection: JSON's approval field is NOT selected.
INSERT INTO public.trade_invoice_lines(line_type)
SELECT line->>'line_type' FROM jsonb_array_elements(
 '[{"line_type":"group share","office_review_status":"approved"}]'::jsonb
) line;
-- Direct and frozen-share paths cannot seed a pre-approved claim either.
INSERT INTO public.trade_invoice_lines(line_type,office_review_status)
VALUES (' GROUP SHARE ', 'approved'), ('labour',NULL), ('commission','approved');
INSERT INTO public.trade_invoice_lines(line_type,group_share_id)
VALUES ('labour','00000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.trade_invoice_lines WHERE id IN (1,2,5) AND office_review_status='awaiting') <> 3 THEN
   RAISE EXCEPTION 'group inserts escaped office review'; END IF;
 IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=3) IS NOT NULL THEN
   RAISE EXCEPTION 'ordinary labour policy changed'; END IF;
 IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=4) <> 'approved' THEN
   RAISE EXCEPTION 'ordinary commission policy changed'; END IF;
END $$;
UPDATE public.trade_invoice_lines SET office_review_status='approved' WHERE id=1;
UPDATE public.trade_invoice_lines SET office_review_status='queried' WHERE id=2;
DO $$ BEGIN
 IF (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=1) <> 'approved'
 OR (SELECT office_review_status FROM public.trade_invoice_lines WHERE id=2) <> 'queried' THEN
   RAISE EXCEPTION 'office decisions were overwritten'; END IF;
END $$;
SELECT 'PASS: projected draft, direct group, frozen pointer, ordinary policy, office updates' AS result;
