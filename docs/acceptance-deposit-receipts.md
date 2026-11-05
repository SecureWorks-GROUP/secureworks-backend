# Exact acceptance deposit receipts

This is a metadata-only follow-on to invoice automation #1329. It records the deposit returned by the existing acceptance invoice flow against its exact accepted document, released revision, first printed payment and frozen payer. It does not calculate, create, authorise, send, void or adjust an invoice. No old event, job deposit pointer or matching amount/reference is backfilled into authority.

The private third argument of `createDepositInvoice` is supplied only by `sendAcceptanceInvoice` for an explicit whole-job accepted document. Request bodies cannot supply it. Immediately before the existing provider create call, the helper validates the exact document/revision/payer and makes a fresh exact-reference provider read. Complete pagination is required. An unbound existing invoice, unreadable response or incomplete result leaves the receipt held. An existing invoice is reusable only when an immutable receipt already names that same document and revision; the remaining payer, stage, amount and provider checks still run.

A private WeakMap token carries this dispatch context across the existing call. It is never serialized or accepted from a request body. The returned provider ID/reference must pass an exact provider GET: ACCREC, AUTHORISED or PAID, AUD, pinned contact and the frozen first printed gross amount. Acceptance must be at or after both the document's sent timestamp and the exact revision's released timestamp. The final insert and read-back converge on the immutable receipt; conflicting identities never overwrite a row. Any metadata failure leaves later automatic billing held while the existing acceptance effect and response keep their existing success/status/send behavior.

The helper uses `quote_invoice_deposit_receipts` and its exact-source/immutable/least-privilege guard from #1329. Apply that schema before this function. This PR does not add a migration, alter a feature switch or grant production access. Existing accepted quotes without the explicit frozen payment/payer contract remain unbound.

This is fresh dispatch evidence, not proof of global provider-origin or absence. Another external operation can race the pre-read and provider PUT. The existing provider key is unchanged. A reused legacy ID without a matching immutable receipt stays held; no receipt recovery path retries invoice creation. This boundary requires money-path review before release.

Exact checks from the backend checkout:

```sh
DENO_DIR=/private/tmp/ws6-round2-deno-cache deno test --frozen --cached-only supabase/functions/ops-api/acceptance_deposit_receipt_test.ts
DENO_DIR=/private/tmp/ws6-round2-deno-cache deno test --frozen --cached-only --no-check --allow-env --allow-read supabase/functions/ops-api/acceptance_deposit_receipt_handler_test.ts
DENO_DIR=/private/tmp/ws6-round2-deno-cache deno check --frozen --cached-only supabase/functions/ops-api/acceptance_deposit_receipt.ts
deno lint supabase/functions/ops-api/acceptance_deposit_receipt.ts supabase/functions/ops-api/acceptance_deposit_receipt_test.ts supabase/functions/ops-api/acceptance_deposit_receipt_handler_test.ts
INVOICE_DRAFT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56437/postgres INVOICE_DRAFT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres bash scripts/test-invoice-milestone-drafts.sh
git diff --check
```

Eight typed helper cases and two actual acceptance function tests, with seven scenario steps in the first use captured persistence and fake provider traffic, with no runtime network permission. They retain the existing single acceptance PUT and observed AUTHORISED status, suppress sends in the fixture, and cover an existing legacy provider ID, unknown pre-read, gross mismatch, stale/future/malformed chronology and forged provenance. The dependency's actual PostgreSQL script proves receipt source/grants/immutability and preserving rollback, including simulated default ALL grants. No live acceptance, hosted staff trial or global provider-origin proof is claimed.
