CREATE TABLE IF NOT EXISTS public.trade_savings_goals (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  target_amount numeric(12,2) NOT NULL CHECK (target_amount > 0),
  saved_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
  target_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trade_savings_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_savings_goals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_savings_goals TO service_role;
