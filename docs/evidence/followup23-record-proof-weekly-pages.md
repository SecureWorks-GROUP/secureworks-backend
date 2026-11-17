# Follow-up 23: record proof and weekly stored pages

This slice fixes the three assigned follow-ups. `context_record_close_v1`
stays off. The weekly timer is not installed by this change.

- An exact receivable closes an invoice-issued item only at AUTHORISED or PAID.
  SUBMITTED is not issued.
- A supplier payment item must name the exact local bill as `bill:<row id>`.
  A supplier role alone, or a different paid bill on the same job, closes nothing.
  Missing bill identity leaves the item open for a person to resolve.
- With `job_page_stored_read_v1` on, the weekly draw samples a ready stored page
  only if its page version and mark version match and its covered timestamp is
  at least the latest mark. It refreshes stale pages only. A late mark with an
  older timestamp still invalidates the version. Failed or busy refreshes keep
  the existing per-job skip behavior. Missing or unreadable switch retains the
  previous refresh-every-page path.

The two changed definitions are copied from main and guarded by their body
pre-images. Re-applying accepts the same successor; rollback restores the prior
bodies. No existing sealed revision, business row, trigger, schedule, switch or
Xero payload is changed by the migration. There is no new retained storage.

The added equality read uses `job_pages_pkey`, `jobs_pkey`, the renamed base
mark table's `job_change_marks_pkey`, and `job_change_mark_events_job`.
The contract tests the actual plan with 2,000 unrelated synthetic jobs, with no
planner settings changed: index scans on all four tables, no sequential scan,
at most two rows per scan. Existing quote/invoice candidate reads are narrowed,
not expanded.

## Proof

`supabase/tests/migration-contracts/20261117233201_followup23_record_proof_weekly_pages/contract.sql`
contains three behavior cases plus the execution-plan and reapply/rollback
checks. All fixtures and rollback checks run in one rolled-back transaction.
The three earlier supplier positive controls now name their exact bill; no test
or proof was removed.

Local proof uses that single contract and its focused setup on disposable
PostgreSQL on the SSD. The general runner's earlier Job Profit pre-image guard
failed before this case, so that unrelated failure is not reported as a passing
full-stack check. GitHub runs the remaining registered contracts.

Still owed by the director: the record-close 20-of-20 dry run before switch-on,
and a timed draw on a representative copy before installing the weekly timer.
This slice does not resolve the other Follow-up 23 generation-lock, session
settings or worker-state observations.
