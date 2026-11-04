# Accepted installation payment drafts

This follows #1324's held trigger-review queue and the Scope Engine producer #869. It is a bounded ordinary single-payer installation path, not complete council or neighbour billing. All provider traffic in verification is captured. No production migration, provider write, customer send, feature-switch change or money-review approval is included.

Staff explicitly selects one later non-deposit schedule stage in Cost review. The sealed printed schedule and its generated calendar-day due wording are saved with the quote. At actual release, a SQL trigger pins the job's existing Xero contact to that revision. A job with named parties, a bill-to override, missing contact or unsupported kind stays held. Browser-supplied payer identities are never read. Old releases are not backfilled.

The real installation assignment create/update and scheduled-status writer follow the durable source review after their source commit. An eligible exact accepted document/revision, balanced sealed schedule and matching later stage create one durable claim. PostgreSQL validates current single accepted-document admission under a shared row lock before insert and before prepared-to-dispatching CAS. Repeated bookings, second crew and rescheduling reuse that identity and the first captured event's Perth calendar date.

A live exact-reference provider search precedes creation. Any unreadable or incomplete search, multiple results or mismatching existing invoice holds. The existing invoice choke point retains its guards, pins the frozen payer and accepted revision, uses Inclusive lines, explicitly requests ACCREC DRAFT and no send, and preserves job lifecycle. The provider identity checkpoints before mirror persistence. Confirmation requires an exact provider GET matching id, type, DRAFT, payer, reference, AUD, inclusive line/amount and due date. The existing #1321 email gate remains in the common provider writer.

A timeout, crash, mismatched read-back or persistence failure never automatically resets a claim. Retry suppression comes from the durable state, not provider replay retention. Office recovery only reads the exact provider id or exact claim reference; it can bind one matching draft, never issue, send or create another. An empty recovery search remains unknown. The actor and recovery timestamp persist. A confirmed draft is still for office review.

## Office API

All actions require an office JWT in the supported organisation or the privileged server credential. Trades and foreign organisations are refused before reads.

- GET `invoice_milestone_reviews&job_id=...`: original held trigger context only, with `reviews_only:true` and a pointer to provider outcomes.
- GET `invoice_milestone_drafts&job_id=...`: `{ok,job_id,drafts,automatic_send:false,send_requires_staff:true}`. Claims have `state`, `label`, `due_date`, `provider_invoice_id`, `hold_reason` and exact source identities.
- POST `{action:'invoice_milestone_drafts',job_id,mode:'process'}`: consume only new/prepared eligible work. Dispatching/unknown/confirmed claims never call create again.
- POST `{action:'invoice_milestone_drafts',job_id,mode:'reconcile',claim_id}`: read-only provider recovery with durable operator audit. No retry release exists.

Source review rows remain preserved and held because they are context, not the claim's provider outcome. A crash after the source commit before follow-up leaves a visible review and can be consumed through the office process action. No background job or feature switch is added.

## Verification

From the backend checkout, with the existing prepared public dependency cache:

```sh
DENO_DIR=/private/tmp/ws6-round2-deno-cache NODE_OPTIONS=--max-old-space-size=2048 deno test --frozen --cached-only --no-check --allow-env --allow-read supabase/functions/ops-api/invoice_milestone_drafts_test.ts supabase/functions/ops-api/invoice_milestone_reviews_test.ts supabase/functions/ops-api/invoice_create_contract_test.ts supabase/functions/ops-api/invoice_email_gate_test.ts supabase/functions/ops-api/job_bookings_test.ts supabase/functions/ops-api/ghost_observer_auto_mirror_test.ts
DENO_DIR=/private/tmp/ws6-round2-deno-cache deno check --frozen --cached-only supabase/functions/ops-api/invoice_milestone_drafts.ts
INVOICE_DRAFT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56437/postgres INVOICE_DRAFT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres bash scripts/test-invoice-milestone-drafts.sh
git diff --check
```

The Deno proof exercises both actual status and actual assignment writers through the existing createInvoice choke point to captured PUT/GET, confirms zero sends/contact redirects and one draft across repeats/second crew, and covers unknown retry suppression beyond the provider's replay window. SQL proves pinned payer, current acceptance admission, immutable commercial payload/provider identity, unknown-no-reset, genuine concurrent CAS, browser grants/RLS and data-preserving rollback. Removing the guard makes the contract fail at commercial-payload mutation. Arithmetic test values are synthetic and carry no catalogue or job prices.

Limits: the post-admission network window cannot hold a PostgreSQL transaction across the provider HTTP request. A quote superseded after dispatch admission may leave the already-admitted frozen draft for office reconciliation; it is never sent. This requires money-path review. No hosted staff trial, live provider acceptance, single combined UI-to-accepted-quote-to-booking voyage, council milestone producer, neighbour billing or accepted-variation invoice adjustment is established here. Those remain owed, separate from these bounded source and persistence proofs.
