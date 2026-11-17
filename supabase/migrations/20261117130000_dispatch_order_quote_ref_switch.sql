-- P2-10.4: the switch for the "please quote this reference" line on the
-- Dispatch supplier order email, seeded OFF.
--
-- With dispatch_order_quote_ref_line_v1 on, ops-api's make email
-- (makeDispatchV2Email, dispatch_v2_store.ts) ends the order email's body with
-- "Please quote this reference on your invoice: <job number>", so a supplier
-- bill can be matched to its job. The line is read where the email is made:
-- a missing row, an explicit false or a failed read is off, and the email is
-- then exactly what it was before. No price or dollar figure is ever added.
--
-- Off until the owner says yes to the exact words (a supplier reads them).
-- ON CONFLICT DO NOTHING: a row already there is left exactly as it is.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('dispatch_order_quote_ref_line_v1', false,
        'P2-10.4: the Dispatch supplier order email ends with "Please quote this reference on your invoice: <job number>". Off until the owner approves the words (20261117130000).')
ON CONFLICT (flag_name) DO NOTHING;
