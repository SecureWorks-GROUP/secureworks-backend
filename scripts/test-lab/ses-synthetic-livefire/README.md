# SES synthetic live-fire lab

This lab sends one unmistakably synthetic, self-addressed physical make-safe
work-order email through the same M365 group and two-minute deterministic scan
used by real SES traffic. It proves the real intake leg through card creation,
canonical board visibility and classification, then cleans the synthetic card
away. By Captain order, downstream docket and workflow validation uses existing
real cards and is not exercised by the synthetic runner.

No fixture contains a real builder, insurer, client, address or reply route.
Every envelope is exactly:

- From: `marnin@secureworkswa.com.au`
- To: `ses@secureworkswa.com.au`
- Cc/Bcc: empty

The lab never calls a docket, send-pack, invoice, Xero, SMS, GHL, sign-off or
release action. Every synthetic family still has the unconditional blocker
`synthetic_livefire_release_forbidden`.

## Required deployment — this kit has a migration

The matching edge revision and
`20260727080821_makesafe_synthetic_livefire_infrastructure.sql` plus
`20260728035000_synthetic_livefire_readiness_cleanup.sql` plus
`20260728040000_synthetic_livefire_case_tombstone_cleanup.sql` must reach
production through the normal migration-before-edge lane. The preflight
requires the deployed capability versions `ses-synthetic-livefire/v1` and
`ledger-bound-case-tombstone-purge/v2`, fixed company profile, legacy own-mail
terminal accounting and release-refusal probe before it can send anything.

## Fixture provenance

The shapes are based on a read-only, PII-sanitized sample of 1,000 real SES
source records captured on 2026-07-27. The sample contained 451 `NEW WORK ORDER`
subjects, 141 roof-report messages, 88 assessment messages, 10 temporary-fence
messages, 6 re-attend messages, 5 corrected messages and 36 attachment-free
`RE:` replies. Body-label frequencies also confirmed the real traffic's
assessment-report, photos, quote, roof-report, client, mobile and work-order
fields.

The repository keeps these local fixture shapes for regression coverage, but
the production command sends only the physical make-safe fixture. Fixtures copy
real structures, not their facts. All names, phones, sites, references and links
are invented. The reserved builder is
`SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY` with the non-routable identity domain
`synthetic-livefire.invalid`; all actual mail routing remains inside
`secureworkswa.com.au`. The four mobile values are exact ACMA
[fiction-only numbers](https://www.acma.gov.au/phone-numbers-use-tv-shows-films-and-creative-works)
that do not belong to people or businesses.

## One-command full pass

Run from this directory after the migration and matching `ops-api` revision are
deployed from `main`:

```bash
SUPABASE_ACCESS_TOKEN=... SW_API_KEY=... ./run-full.sh
```

The wrapper obtains the database service-role key transiently from the Supabase
CLI and requires the active production `SW_API_KEY` separately for authenticated
`ops-api` probes. It generates a fresh UUID marker and one PDF/email, sends that
single physical make-safe instruction, waits for its real intake fate and card
classification, runs a cleanup dry-run, then applies cleanup.

Evidence is written under the ignored
`artifacts/ses-synthetic-livefire/<marker>/` directory. The signed token is
redacted from the saved manifest.

## Cleanup model

Cleanup is deliberately split by store:

- Mutable operational residue (staged document objects/rows, intake drafts and
  self-send `email_events`) is hard-deleted only when the row itself carries
  the exact marker. Synced attachment bytes are removed and their group rows
  are tombstoned with the same shape as the normal PII-retention purge.
- Mailbox messages and append-only intake/state ledgers remain as audit
  evidence. Their run is transitioned to `terminal` in
  `ses_synthetic_livefire_runs`.
- Mutable synthetic jobs and operational rows are deleted after the exact-marker
  guard passes. Intake cases bound to those jobs are retained as audited
  `synthetic_livefire_terminal` tombstones, with their transition events; other
  append-only/group evidence and the marked mailbox messages remain. Attendance
  cycles and readiness-linked jobs use guarded synthetic-only RPCs bound to the
  run ledger.
- Canonical Ops/Trade projections hide retained evidence only from the terminal
  `ses_synthetic_livefire_runs` ledger, never from mutable job metadata.

The runner refuses cleanup on marker drift, a foreign sender/recipient, an
unmarked case/job, unsafe storage paths, any docket persistence, any approval,
any release revision, any external effect or any Xero invoice. The dry-run
inventory is saved before the first cleanup mutation. Each send attempt is
recorded on the run ledger before Graph is called; cleanup also refuses until
every attempted message is visible and its attachment sync has settled, so an
ambiguous send failure cannot be falsely declared clean.

The ledger uses `cleanup_complete` as a one-way proof window. During that window,
fresh-source health must still include the synthetic traffic so the live-fire
accounting remains honest. After the runner records that pre-terminal inclusion,
it makes the immutable `terminal` transition and re-reads health to prove the
retained evidence is excluded. The migration also terminally accounts the
pre-existing exact own-mail chatter shape required by the Captain's unblock.

After cleanup, the runner requires the marker/job IDs to be absent from:

- `makesafe_board`
- `makesafe_audit`
- `makesafe_pipeline`
- `intake_health`
- `ops_summary`

Raw retained evidence is reported separately and is not misrepresented as
physical deletion. The M365 group and sender Sent Items retain the one marked
message by explicit Captain decision.

If the process is interrupted after the run ledger is created, rerun only the
guarded cleanup for that exact UUID:

```bash
SUPABASE_ACCESS_TOKEN=... \
SW_API_KEY=... \
SYNTHETIC_LIVEFIRE_RUN_ID=<uuid> \
./cleanup-run.sh
```

## Safe local checks

Generate fixtures without network or production writes:

```bash
~/.deno/bin/deno run --allow-env --allow-read --allow-write run.ts generate
```

Run the read-only production preflight:

```bash
SUPABASE_SERVICE_ROLE_KEY=... SW_API_KEY=... ~/.deno/bin/deno run \
  --allow-env --allow-net --allow-read --allow-write run.ts preflight
```
