-- Seed the three switches for the trades' app open access (owner, 13 Nov 2026).
-- Every one is seeded OFF: a missing, unreadable or false row leaves ops-api
-- exactly as it was. The owner turns each on by hand, in the order given in
-- docs/trade-open-access-v1.md.
--
--   trade_company_job_view_v1  any trade may find and open any live job in
--                              their company, read only, no prices; the
--                              customer's phone and email only once the trade
--                              is on the job (ops-api tier `company_view`).
--   trade_self_booking_v1      a trade may book themselves on a job for today
--                              or a future day (`self_book_job`) and undo their
--                              own booking (`self_unbook_job`).
--   trade_rate_editable_v1     a trade may type their hourly rate on a job card
--                              of their weekly invoice; a rate above the office
--                              limit is held for office review.
--
-- ops-api reads them in trade_open_access.ts. No schema change: only rows.
-- ON CONFLICT DO NOTHING: a row already there keeps its value.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('trade_company_job_view_v1', false,
   'Owner 13 Nov 2026: any trade may find and open any live job in their company, read only, no prices, customer contact only once on the job (20261113090000).'),
  ('trade_self_booking_v1', false,
   'Owner 13 Nov 2026: a trade may book themselves on a job for today or a future day and undo their own booking (20261113090000).'),
  ('trade_rate_editable_v1', false,
   'Owner 13 Nov 2026: a trade may type their hourly rate on a weekly invoice job card; above the office limit it is held for office review (20261113090000).')
ON CONFLICT (flag_name) DO NOTHING;
