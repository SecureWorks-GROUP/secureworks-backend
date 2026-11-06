# Granny flat build: existing-job classification

`granny_flat` is one new `jobs.type` value, labelled **Granny flat build**.
This supports a separately commissioned reclassification of one existing job.
The migration changes the check constraint only. It preserves all eleven prior
values, refuses an unexpected baseline, keeps the constraint comment and leaves
other constraints, numbering, triggers and business rows alone. Applied migrations
are unchanged. There is no new-job mint, numbering branch or create-job redesign.

The exact selected-job operation, private identity binding, before/after hashes
and undo script are held in Firstmate's task-private operation packet. They are
not a migration or an automatic backfill. Root commissions the operation only
after exact backend and frontend release readbacks.

## Existing access and filters

`_jobVertical` already preserves an ordinary raw job type. No granny-flat manager
vertical or profile/access grant is added. See-everything staff retain access;
allocated crew retain full-range search and per-job access through their existing
assignments. The personal feed still has its existing date window. Unassigned
patio-only managers do not inherit a different type. Calendar and work-order
`type=granny_flat` filters accept the classification separately from manager
authority; their existing viewer/tenant gates still apply. Ops pipeline and
Dispatch preserve the raw type through their existing generic paths.

Frontend labels, classifier and existing-job filters are a separate root/UX
handoff. This backend PR changes no frontend or dispatch source. A source merge
or SQL read is not affected-user UI proof.

## Financial boundary

No authoritative granny-flat revenue account or tracking division has been
provided. `accountCodeForJob` refuses this type with
`job_account_mapping_required` instead of choosing the default account 200.
`trackingCategoryForJob` returns no tracking for an explicit granny-flat type,
even if its retained number resembles another division. Backend descriptions
name Granny flat build instead of defaulting to patio installation.
Existing expense-account rules are unchanged. Saved money, invoice/Xero links,
pricing and frozen costs are never rewritten. This is not a completed future
billing or new-job workflow. Existing raw-type fencing/patio quote-fill,
closeout, deposit and signoff rules are not expanded. The live SES-only
`job_financials` view excludes the selected patio job before and after this
classification; this slice does not redesign its population.

## Exact-operation precondition and undo

The live `trg_jobs_open_job_work_order` reacts to a type update and can open a
work order under its all-types flag. The root-only operation must lock and prove
the selected job's existing current `kind=job`, draft/approved work order first.
If absent or changed, stop. Do not call an ensure/backfill/issue/status API.
The prepared CAS checks exact job, tenant, number, old type, status, archive flag,
updated_at, every other jobs field and the live trigger/source manifest; exactly
one row may change. Read back that row and related assignments, documents, media,
orders and invoice links. No work order, message, quote, invoice or payment is
part of reclassification.

The down migration refuses while any granny-flat row remains. First undo the
separately commissioned job operation by its exact post-operation timestamp and
preserved hash, then restore the eleven-type constraint. Never coerce rows to
make schema rollback pass. Coordinate frontend support with root.

## Validation boundary

The existing migration-contract runner registers the narrow forward and rollback
constraint checks. It exercises acceptance of the twelve values and rejection
of an unsupported value without job fixture writes or new feature tests.
Existing PR Check, migration-contracts and ses-proof-harness stay unchanged.
The allowed cached/frozen static compile passed; no local feature/browser/smoke
campaign or optional dependency installation was run. Production application
and the exact existing-job readback remain root's work.
