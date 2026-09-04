-- Minimal job_documents surface before trade_pack_json.

CREATE TABLE IF NOT EXISTS public.job_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  type text,
  quote_number text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
