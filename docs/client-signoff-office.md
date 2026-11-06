# Client confirmation and the office paper form

The existing public client link and on-site signature remain the client doors.
The same job sign-off ledger also accepts an identified office person's record
of what the client confirmed. Nothing in these actions sends a message,
completes a job, freezes shares, submits an invoice or writes to Xero.

## The office workflow

On a fencing or patio job, download the blank PDF form. It contains the job
number and address, work completed, outstanding items, client acceptance,
name, signature and date. The office prints or shares it itself. Downloading
creates no stored approval. Unsupported identity characters or overlong
identity text refuse rendering rather than silently changing the identity.

To record confirmation, use an identified staff session. Enter the client's
name, date, work completed, outstanding items and whether the client accepts
the work. Attach the signed PDF/PNG/JPEG, or give a reference identifying the
client's written confirmation. The office confirms this covers the current
work and any changes since the last sign-off. The server records its own
verified office user and timestamp; caller-supplied attribution is ignored.
A client rejection is retained and does not unlock completion.

Signed copies live in the private `client-signoff-copies` bucket, at most 8 MB.
They can be read only through the office action after job/organisation checks
and a byte-hash readback. No copy goes into a public job-document bucket.
Recording is append-only. A request UUID plus its exact payload hash makes an
uncertain retry converge on the same record. Changed details cannot reuse it.

## Current confirmation and frozen groups

The ruling starts at 6 November 2026, 05:55:58 UTC, fixed independently of the
deployment clock. Groups already frozen before that instant keep their
historical authority. A general office waiver does not unlock a new freeze.
New end-work and freeze decisions require the current client signature or a
complete office entry on the client's behalf. New hours, changed hours,
participant removal and reopening invalidate an earlier confirmation.
Reopening always requires a new confirmation, even when hours did not change.
The installer completion handler checks this before changing the job status.
It also checks patio jobs whose canonical payable route requires group setup,
even before their group exists. It reuses that route’s existing flag,
pre-group scheduling and prior-pay rules. Genuine ordinary pre-group work
keeps its existing completion policy.
Daily attendance and saving actual hours keep their existing behaviour.

The SQL freeze/release path and application reads use the same newest-row,
latest-hours and reopening boundaries. The office can record unhappy clients;
that evidence remains visible while completion stays held. The old waiver
route remains available to existing non-group callers but cannot satisfy a
new group freeze. A waiver is displayed as a historical office approval.

## Actions and release order

- `GET client_signoff_office`: office read, current evidence and existing client link.
- `GET client_signoff_form_pdf`: office download, bytes only.
- `GET client_signoff_copy`: office download of a verified private signed copy.
- `POST record_client_signoff`: identified staff JWT only, append-only confirmation.
- `GET group_work_order_public` with `format=pdf`: the existing token credential
  downloads the same price-free form. No new public sign-off route is added.

Apply `20261106054912_client_signoff_copies.sql` before the matching ops-api.
Then publish the matching office/client screens. The schema preflight lists the
new columns, policy, evidence constraint and reopening trigger. The send flag
stays unchanged. The rollback refuses once new confirmation evidence, a reopen
marker or a private signed copy exists, so rollback cannot discard that proof.

## Checks and limits

Existing Deno suites cover office attribution, idempotent retries, file
ownership/integrity, client rejection, currentness and refusal before a job
completion write. The registered SQL contract checks historical frozen groups,
the ruling cutoff, future waiver refusal, evidence constraints and reopening.
The browser cases cover explicit recording, retained inputs after refusal,
the PDF download and the existing public signature path. These checks do not
claim a real installer submitted an invoice or a real client signed the form.
