-- Update existing make-safe requesting companies with billing rules.
-- Additive only. Does not modify existing data beyond billing_rules.

UPDATE public.makesafe_companies SET
  billing_rules = '{"hourly_rate": 80, "min_hours": 2, "payment_terms_days": 7, "holiday_rate": 100}'::jsonb,
  special_instructions = 'CC vanessa@ajs.build on all correspondence',
  updated_at = now()
WHERE slug = 'aj';

UPDATE public.makesafe_companies SET
  billing_rules = '{"hourly_rate": 85, "min_hours": 3, "payment_terms_days": 14}'::jsonb,
  updated_at = now()
WHERE slug = 'kba';
