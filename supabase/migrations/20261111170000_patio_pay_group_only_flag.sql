-- Seed the patio pay rule's switch, patio_pay_group_only_v1 (owner, 3 Nov 2026:
-- "all patio pay needs to go through [group work orders] from now").
--
-- ops-api reads it in group_work_order.ts (assertPatioPaysThroughGroup,
-- readInvoicePayableRoutes) and patio_auto_group.ts, but no migration created
-- the row: production's row was written by hand and is already enabled. This
-- seed only makes a database built from migrations (CI, a preview branch, a
-- fresh `supabase start`) carry the row, switched OFF, so the patio rule is
-- never on by accident there.
--
-- ON CONFLICT DO NOTHING: production keeps its row exactly as it is (enabled).
-- Since 11 Nov 2026 the rule refuses hours on a patio job only while
-- group_work_order_v1 is also on (a patio trade can always be paid).
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('patio_pay_group_only_v1', false,
        'Owner 3 Nov 2026: patio pay goes only through a group work order (hours on a patio job are refused) while group_work_order_v1 is also on (20261111170000).')
ON CONFLICT (flag_name) DO NOTHING;
