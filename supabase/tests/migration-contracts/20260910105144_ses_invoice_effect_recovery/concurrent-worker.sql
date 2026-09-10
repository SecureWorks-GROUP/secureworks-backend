BEGIN;

-- Keep both sessions open together before the advisory-lock-protected claim.
SELECT pg_sleep(0.2);

SELECT id::text
FROM public.claim_ses_invoice_no_dispatch_retry_v1(
  jsonb_build_object(
    'effect_id', '61000000-0000-4000-8000-000000000021',
    'invoice_obligation_revision_id', '62000000-0000-4000-8000-000000000021',
    'operation_key', 'ses:invoice_create:concurrent-proof',
    'effect_kind', 'invoice_create',
    'external_token', 'SES-concurrent-proof',
    'payload_hash', 'sha256:2121212121212121212121212121212121212121212121212121212121212121',
    'state', 'failed'
  ),
  :'lease_owner',
  :'actor'
) \gset

\if :{?id}
  \echo CLAIMED
\else
  \echo HELD
\endif

COMMIT;
