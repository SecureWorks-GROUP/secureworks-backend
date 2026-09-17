-- Grant a browser role so contract.sql must fail on the no-client-access invariant.
GRANT SELECT ON TABLE public.sales_booking_packs TO anon;
