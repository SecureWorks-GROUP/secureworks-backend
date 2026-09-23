-- A ghl_webhook_receipts table nobody read is already there in another shape:
-- the migration must refuse rather than build on it.
CREATE TABLE public.ghl_webhook_receipts (id bigint PRIMARY KEY, payload jsonb);
