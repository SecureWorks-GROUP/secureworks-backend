-- Debt desk chase log (docs/debt-book/PLAN.md section 6 step 3, "Schema").
--
-- One additive change to payment_chase_logs, so the desk can draft, approve,
-- send and log against the invoice. The captain's rulings are in
-- docs/debt-book/DECISIONS.md; the code that writes these columns is
-- ops-api/debt_desk_actions.ts and the reader is ops-api/debt_morning_list.ts.
--
-- 1. method stays the one channel field (no new channel column). Its CHECK is
--    widened with visit (Jan's door knock), statement (a builder statement)
--    and letter. Every existing value is re-listed from the newest repo
--    definition, 20260911120000_debt_picture.sql: call, sms, auto_sms, email,
--    note, status_change, personality_note, classification, proposal. A row
--    carrying any other method makes the ADD CONSTRAINT fail, so live drift
--    stops the migration instead of being dropped.
-- 2. New nullable columns (old rows and old writers are untouched):
--      direction             outbound or inbound
--      outcome_code          closed list beside the free-text outcome column,
--                            which stays for notes and older rows
--      promised_amount       a promise to pay: the amount
--      promised_date         a promise to pay: the date
--      amount_due_at_promise the amount due on the covered invoices when the
--                            promise was logged, read live from Xero, so a part
--                            payment can prove the promise kept
--      schedule_step         the chase step this row carries out
--      approved_by_user_id   the signed-in user who approved the message
--      automated             true only for a machine-sent message (default false)
--      provider_message_id   the SMS or email provider's message id
--      covers_invoice_ids    every Xero invoice one message or promise covers
--      draft_id              the morning-list draft a decision, send or refusal
--                            belongs to
--      draft_amount          the invoice's amount due that the draft was written
--                            against; the send refuses when Xero shows less
--    A send claims its draft first: one 'sending' row per covered invoice, which
--    becomes 'sent' once the text goes. A partial unique index allows one
--    sending-or-sent row per draft and invoice, so two overlapping sends of one
--    draft cannot both text the client, and a send whose 'sent' write failed
--    stays claimed rather than becoming sendable again.
-- 3. Row-level security. The table had none (debt-map-s1 B19). Every reader
--    and writer today is a server function on the service role (ops-api,
--    daily-digest, reporting-api), which keeps full access through an explicit
--    policy. anon and authenticated get no policy, so the browser's anon key
--    and a signed-in session read and write nothing directly; the Clear Debt
--    screen already goes through ops-api.
--
-- 4. The desk owner (captain D5: "shaun" owns the desk and approves every
--    message). public.debt_desk_settings is one row naming the users who may
--    approve and send desk messages, seeded with Shaun's users.id
--    (shaun@secureworkswa.com.au), which is the id ops-api records as
--    approved_by_user_id for his signed-in session. ops-api reads it when the
--    DEBT_DESK_OWNER_USER_IDS secret is not set, and never falls back to a
--    role: an empty list means nobody can approve. Service role only.
--
-- Re-applying is a no-op, and keeps a changed owner list.

ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_method_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_method_check
  CHECK (method IN (
    'call', 'sms', 'auto_sms', 'email', 'note', 'status_change',
    'personality_note', 'classification', 'proposal',
    'visit', 'statement', 'letter'
  ));

ALTER TABLE public.payment_chase_logs
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS outcome_code text,
  ADD COLUMN IF NOT EXISTS promised_amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS promised_date date,
  ADD COLUMN IF NOT EXISTS amount_due_at_promise numeric(12, 2),
  ADD COLUMN IF NOT EXISTS schedule_step text,
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS covers_invoice_ids text[],
  ADD COLUMN IF NOT EXISTS draft_id text,
  ADD COLUMN IF NOT EXISTS draft_amount numeric(12, 2);

ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_direction_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_direction_check
  CHECK (direction IS NULL OR direction IN ('outbound', 'inbound'));

ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_outcome_code_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_outcome_code_check
  CHECK (outcome_code IS NULL OR outcome_code IN (
    'no_answer', 'spoke', 'promised', 'disputed', 'says_paid',
    'sending', 'sent', 'failed', 'skipped'
  ));

ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_schedule_step_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_schedule_step_check
  CHECK (schedule_step IS NULL OR schedule_step IN (
    'friendly_text', 'firm_text', 'call', 'jan_visit',
    'statement', 'builder_call', 'deposit_reminder'
  ));

-- A promise is an amount and a date (Q14: "record amount + date").
ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_promise_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_promise_check
  CHECK (
    (promised_amount IS NULL OR promised_amount > 0)
    AND (outcome_code IS DISTINCT FROM 'promised'
         OR (promised_amount IS NOT NULL AND promised_date IS NOT NULL))
  );

CREATE INDEX IF NOT EXISTS idx_chase_logs_draft
  ON public.payment_chase_logs (draft_id) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chase_logs_draft_send_claim
  ON public.payment_chase_logs (draft_id, xero_invoice_id)
  WHERE outcome_code IN ('sending', 'sent');

COMMENT ON COLUMN public.payment_chase_logs.method IS
  'The one channel field. call, sms, auto_sms (GHL workflow), email, note, status_change, personality_note, classification, proposal; visit (Jan at the door), statement (builder statement), letter.';
COMMENT ON COLUMN public.payment_chase_logs.outcome_code IS
  'Closed list: no_answer, spoke, promised, disputed, says_paid (what a contact achieved); sending (a send claimed, not yet confirmed), sent, failed, skipped (what happened to a desk message). The free-text outcome column stays for notes and older rows.';
COMMENT ON COLUMN public.payment_chase_logs.amount_due_at_promise IS
  'Amount due on the covered invoices when the promise was logged, read live from Xero. The promise is kept when Xero shows that much less owing by the morning after the date.';
COMMENT ON COLUMN public.payment_chase_logs.approved_by_user_id IS
  'The signed-in user (users.id) who approved the message. Set on approval rows and copied onto the send row.';
COMMENT ON COLUMN public.payment_chase_logs.covers_invoice_ids IS
  'Every Xero invoice id one message or promise covers. The row itself is written against each covered invoice.';
COMMENT ON COLUMN public.payment_chase_logs.draft_id IS
  'The morning-list draft this decision, send or refusal belongs to (debt_morning_list items[].draft.id).';
COMMENT ON COLUMN public.payment_chase_logs.draft_amount IS
  'The invoice''s amount due the draft was written against. The send refuses when Xero shows less owing.';

ALTER TABLE public.payment_chase_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_chase_logs_service_role_all ON public.payment_chase_logs;
CREATE POLICY payment_chase_logs_service_role_all ON public.payment_chase_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.debt_desk_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner_user_ids uuid[] NOT NULL DEFAULT '{}',
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.debt_desk_settings (id, owner_user_ids, note)
VALUES (
  1,
  ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[],
  'Shaun (shaun@secureworkswa.com.au): the desk owner approves every message (DECISIONS.md D5)'
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.debt_desk_settings IS
  'One row: the users (users.id) who may approve and send debt desk messages. Read by ops-api when DEBT_DESK_OWNER_USER_IDS is unset. Empty means nobody.';

ALTER TABLE public.debt_desk_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debt_desk_settings_service_role_all ON public.debt_desk_settings;
CREATE POLICY debt_desk_settings_service_role_all ON public.debt_desk_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
