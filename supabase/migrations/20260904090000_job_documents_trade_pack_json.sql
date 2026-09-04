-- Trade-safe scope-of-works snapshot, frozen onto each sent quote document.
-- Written at send time. Trades list every sent quote by quote_number and
-- read this pack (quantities + installer charge kinds, no client sell).

alter table public.job_documents
  add column if not exists trade_pack_json jsonb;

comment on column public.job_documents.trade_pack_json is
  'Trade-safe scope of works frozen at quote send. No client price. Crew triages by quote_number.';
