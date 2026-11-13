-- Super on top (owner, 13 Nov 2026).
--
-- A trade listed in trade_super_on_top is paid the whole amount they earn and
-- the company pays the 12% super on top. Every other trade keeps the split
-- worked out in ops-api trade_invoice_money.ts (6% withheld, 6% company).
-- ops-api reads the list (trade_super_on_top.ts) when it saves an invoice and
-- stamps the invoice super_basis 'super_on_top_v1' from the row's start date.
--
-- Four changes:
--   1. The staff-only list. RLS on, revoked from the browser roles, so a trade
--      can never put themselves on it (users.trade_details is trade-editable).
--   2. trade_invoices_super_basis_check admits 'super_on_top_v1'.
--   3. trade_invoices_super_gst_split_check: a super_on_top_v1 invoice pays
--      net = gross, exactly like employer_12_v2. Rebuilt from the live
--      20261112090000 definition, every other term unchanged.
--   4. trade_invoice_lines_group_share_snapshot refused any line on an invoice
--      with ANY super_basis, because employer_12_v2 meant "group share only".
--      It now refuses only on employer_12_v2. Guarded text replacement: if the
--      live body does not hold the expected text exactly once, this fails.
--
-- Seeds the four trades the owner named on 13 Nov 2026 (rates set the same
-- day in trade_rates): Isaac and Ryan from the zoo job week (19 Oct), Jonathan
-- from his first day (27 Oct), Ruan from his first day (4 Nov). Matched by
-- user id; a database without those users seeds nothing.
--
-- Apply before the matching ops-api. Old ops-api never writes the new value.

CREATE TABLE IF NOT EXISTS public.trade_super_on_top (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  set_by text NOT NULL DEFAULT 'office',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trade_super_on_top IS
  'Super on top (20261113190000): trades paid their whole gross with the company paying 12% super on top, from effective_from (invoice week start, inclusive). Staff and service role only. Read by ops-api trade_super_on_top.ts.';

ALTER TABLE public.trade_super_on_top ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_super_on_top FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_super_on_top TO service_role;

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis IN ('employer_12_v2', 'super_on_top_v1'));

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL) AND (super_base_ex IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_base_ex IS NULL OR (super_base_ex >= 0 AND super_base_ex < gross_earned))
    AND (super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2))
    AND (
      (super_basis IS NULL AND (
        (net_pay = round(gross_earned - round(COALESCE(super_base_ex, gross_earned) * 0.06, 2), 2))
        OR (super_base_ex IS NULL AND net_pay = round(gross_earned - super_amount, 2))
      ))
      OR (super_basis IN ('employer_12_v2', 'super_on_top_v1') AND net_pay = gross_earned)
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  v_old text := 'i.super_basis IS NOT NULL';
  v_new text := 'i.super_basis = ''employer_12_v2''';
  v_hits int;
BEGIN
  IF position(v_new IN v_def) > 0 AND position(v_old IN v_def) = 0 THEN
    RETURN; -- already applied
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'trade_super_on_top: expected the group-share line guard exactly once in trade_invoice_lines_group_share_snapshot, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$patch$;

INSERT INTO public.trade_super_on_top (user_id, effective_from, set_by, note)
SELECT s.user_id, s.effective_from, 'owner', s.note
FROM (VALUES
  ('a5ea66d2-ee5f-4537-92ab-f76992df051d'::uuid, date '2026-10-19', 'Owner, 13 Nov 2026: Isaac $53 plus super on top from the zoo job.'),
  ('f9a9e835-98a9-4dc4-a927-5edbb1a81a63'::uuid, date '2026-10-19', 'Owner, 13 Nov 2026: Ryan $43 plus super on top from the zoo job.'),
  ('08cfa02f-6c13-420c-acc4-9d81301aac82'::uuid, date '2026-10-27', 'Owner, 13 Nov 2026: Jonathan $45 plus super on top from his first day.'),
  ('6b4a7ad8-698b-4838-9507-d39a6c6cb129'::uuid, date '2026-11-04', 'Owner, 13 Nov 2026: Ruan $40 plus super on top from his first day.')
) AS s(user_id, effective_from, note)
WHERE EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.user_id)
ON CONFLICT (user_id) DO NOTHING;
