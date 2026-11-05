# Invoice milestone preparation: held office reviews

WS6 note 41, first slice. This preserves a review item when a patio or fencing job is scheduled or a named council step is completed. It does **not** create an invoice in Xero. Automatic invoice drafting remains unfinished.

## What records a review

The database captures the existing writers, in the same transaction:

- A job's status changes into `scheduled`.
- The first-party calendar or assignment writer records a live `scheduled` or `confirmed` install booking with a date. Ghost/observer rows, delivery/visit/meeting rows and cancelled rows do not count. The calendar can leave the job's lifecycle at `processing`; the assignment trigger covers that path.
- A council submission's named `step_id` changes to `complete`. Changing only the workflow cursor or overall status is not completion evidence. The workflow-jump writer tags positioning-only completions as `workflow_jump`; these are excluded even though the workflow marks those earlier steps complete. Unnamed or malformed steps provide no named milestone evidence.

There is one review per job, accepted document and milestone key. All crew bookings and lifecycle scheduling share `scheduled`. Repeated saves, rescheduling, council reset/recompletion and simultaneous crew bookings reuse the existing review. With no current accepted sent quote document, one unbound review records that missing input. An unbound review and a later document-bound review are **review context, never separate payable obligations**.

**Atomic failure:** if a qualifying source write cannot persist its review, PostgreSQL rejects that source write. The booking, status transition or council completion is not saved. The caller receives the database error and may retry after recovery. Capture failures are not silently swallowed, and no unrelated invoice/Xero action runs.

## Why every review is held

An accepted document is context, not sufficient billing authority. When its explicit `quote_revision_id` matches a released revision for that exact job and document, the queue retains that id. It never chooses the latest revision. Missing, unreleased or mismatched links remain `accepted_revision_binding_missing`.

Current W37 payment schedules are printed terms. Their `when` is free text, and the saved job pricing serializes only the first payment as a deposit. There is no accepted, typed schedule/council billing trigger. Every queue row therefore remains `held` with `machine_billing_terms_missing`. No default percentage, council fee, payer share, mutable live price or free-text interpretation supplies an amount. A missing accepted document is separately `accepted_document_missing`.

The table has no ready/creating/sent states, invoice amount, provider id, retry writer or send action. Existing draft and acceptance invoice behavior is unchanged. This queue must not be used as an invoice or a balance-due report.

## Office read

`GET ops-api?action=invoice_milestone_reviews&job_id=<uuid>` returns only the requested organisation/job's review rows and explicit `preparation_only: true`, `automatic_xero_drafts: false`, `send_requires_staff: true`.

Only an `admin`, `owner` or `ops_manager` session in the supported organisation, or the existing privileged server credential, can read it. A foreign/missing organisation, trade, crew, lead installer or unprivileged key is refused before database reads. There is no new browser UI in this slice. Missing/unreadable storage is an error, not a false empty success. Direct browser table access and function execution are revoked, with RLS enabled.

## Next connected slice

Save explicitly typed trigger ids and calculations in the quote's frozen payment schedule, preserve them through sending, and bind the exact accepted revision and party. Then add a separate staff-visible consumer with a durable provider claim per job/revision/party/milestone, existing-invoice reconciliation, unknown-outcome retry holds and explicit ACCREC DRAFT read-back. It must never authorise or send automatically. Existing invoice-send safeguards remain separate.

## Rerun

Deno uses local stand-ins with no runtime network permission:

```sh
deno test --cached-only --no-check --allow-env --allow-read supabase/functions/ops-api/invoice_milestone_reviews_test.ts
deno check --cached-only supabase/functions/ops-api/invoice_milestone_reviews.ts
```

Against an already-running **disposable localhost** PostgreSQL 17 cluster only:

```sh
INVOICE_REVIEW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56436/postgres \
INVOICE_REVIEW_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
bash scripts/test-invoice-milestone-reviews.sh
```

The script creates its own PID-named database, runs the registered SQL contract, checks two independent concurrent booking transactions, runs rollback proof, and removes only that database. A forward migration contract also runs in the existing CI migration suite. Rollback removes capture triggers/functions while preserving review records and access restrictions.

No migration was applied to a live system for this build. No Xero call, send, issue/authorise, feature-switch change or existing customer-data change was used for verification.
