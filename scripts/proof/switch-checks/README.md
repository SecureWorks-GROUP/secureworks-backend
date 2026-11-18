# Switch checks: stored reader and draft register

One file per precondition for turning on two switches. The director runs them
against ZZTEST; the builder ran them only against a disposable local copy of
the migration stack (`test-local.sh`). Every file prints one row:
`check | PASS or FAIL | evidence`. Evidence is counts, ids, hashes, flags and
times, never an amount, name or address.

| Switch | Turns on | Folder |
| --- | --- | --- |
| `job_story_stored_profit_v1` | the story card reads Job Profit from the stored snapshot | `stored-reader/` |
| `xero_draft_standard_v1` | the Xero draft register and draft standard (PR 1641, with P3-01.7 and P3-01.8) | `draft-register/` |

## How a file stays a read

`session.sql`, included by every file, stops the file with one FAIL row
unless all three hold:

1. The session is read only, read back after `SET default_transaction_read_only`.
   Any write, including a temporary table, then errors instead of running.
2. The role sees every row (superuser or `BYPASSRLS`). The stores read here
   have row security; a role without it reads zero rows with no error, which
   would pass "nothing waiting" and "register empty" falsely.
3. `job_number` names exactly one job, and it starts `ZZTEST`.

`switch-checks_static_test.ts` fails CI if a file loses the include or gains a
write verb, a `SET` other than the read-only one, or a function call not on
the list below.

## Application functions called

Most files read tables and catalogs only. These call functions, all stable
reads; the role needs EXECUTE on them (they are granted to `service_role`):

| Function | Files | What it does |
| --- | --- | --- |
| `job_story_stored_profit_setup()` | stored 06 | lists the 11 source triggers and their modes |
| `job_story_stored_profit_as_at(job, as_of)` | stored 08, 10, 11, 12 | the stored snapshot's time, or null when it is not usable |
| `context_job_story_book_stored(job, as_of)` | stored 08, 12 | the story book from the stored snapshot |
| `context_job_story_book_fast(job, as_of)` | stored 08, 12 | the live story book |

`install_job_story_stored_profit`, `job_profit_refresh_*`, `job_mark_changed`
and `job_profit_stored_compare` are never called (the compare builds a
temporary table; check 9 makes the same comparison as a plain read).

## Stored reader (`stored-reader/`)

| File | PASS means |
| --- | --- |
| `01-switch-off.sql` | the story switch row exists and is off |
| `02-refresh-on.sql` | `job_profit_refresh_v1` is on (the store answers nothing while off) |
| `03-refresh-timer.sql` | both refresh cron jobs active, the minute job succeeded in the last 5 minutes. pg_cron row security can hide another role's job: run as the jobs' owner before reading FAIL as "not scheduled" |
| `04-source-triggers.sql` | all 11 `job_profit_changed` triggers present and enabled |
| `05-installed.sql` | the live book and staff read are the switch and stamped bodies (bodies compared, no hash literal), both store triggers enabled |
| `06-armed.sql` | the arm row exists and the trigger set equals the armed set |
| `07-nothing-waiting.sql` | no queued change, dirty row or real change mark newer than the stored refresh |
| `08-stored-equals-live.sql` | the store answers with the snapshot's time, after the arm, and the stored book equals the live book (one statement) |
| `09-compare-clean.sql` | stored row equals the view row in every shared column, no view column missing, events equal in count and sum |
| `10-change-waiting.sql` | run straight after a ZZTEST change: something is waiting and the store gives no answer (live book served) |
| `11-change-folded.sql` | run after the next refresh, with `changed_at`: the change reached the job and the store answers from a refresh begun after it |
| `12-faster.sql` | three rounds: stored read plus its check took less time than the live book |

Order for the change test: 01 to 09 PASS; make one ZZTEST Xero change and
note the time; 10 PASS at once; wait for the minute refresh; 11 PASS with
that time; 08 and 09 PASS again.

## Draft register (`draft-register/`)

| File | PASS means |
| --- | --- |
| `01-switch-off.sql` | the draft switch row exists and is off |
| `02-register-table.sql` | every column the writer and daily check use, and unique `(org_id, xero_document_id)` for the upsert |
| `03-register-access.sql` | row security on, no anon or authenticated privilege, service_role can select, insert, update |
| `04-register-empty.sql` | switch off and no register row in any organisation |
| `05-account-rules.sql` | a `default` account rule for each of the four source kinds (codes not printed) |
| `06-rules-confirmed.sql` | every account rule confirmed (who is not printed). The migration seeds today's codes unconfirmed, so this FAILs until the bookkeeper confirms them |
| `07-division-options.sql` | every stock division an ACTIVE option, copied in the last 36 hours |
| `08-raise-kind.sql` | the Reconcile kind `draft_incomplete` exists |
| `09-raise-door.sql` | `reconcile_item_raise_named` (PR 1643) exists with the eight argument names PR 1641 sends, in order; service_role may run it, anon and authenticated may not. **FAILs on main today**: without it the raise answers PGRST202, the draft is recorded and nothing is raised |
| `10-first-draft-readback.sql` | after the first ZZTEST draft with the switch on, given `xero_document_id`: one row, on the job, type fits its register row, fingerprint shape, flags agree with problems, approval columns consistent, and an office draft with problems has its one open item |

Not observable by SQL, so not checked here: the Job Profit page showing
`computed_at`; PR 1641 deployed (read `ops-api?action=ops_api_version` and
test ancestry); a draft actually created in Xero.

## Commands

From the repository root, one file at a time, with an existing connection
(no credentials on the command line):

```sh
psql -X -v ON_ERROR_STOP=1 -v job_number="$ZZTEST_JOB_NUMBER" \
  -f scripts/proof/switch-checks/stored-reader/01-switch-off.sql
psql -X -v ON_ERROR_STOP=1 -v job_number="$ZZTEST_JOB_NUMBER" \
  -v changed_at="$ZZTEST_CHANGE_AT" \
  -f scripts/proof/switch-checks/stored-reader/11-change-folded.sql
psql -X -v ON_ERROR_STOP=1 -v job_number="$ZZTEST_JOB_NUMBER" \
  -v xero_document_id="$ZZTEST_XERO_DRAFT_ID" \
  -f scripts/proof/switch-checks/draft-register/10-first-draft-readback.sql
```

Local behaviour test (disposable localhost Postgres only):

```sh
PROOF_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
PROOF_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
PROOF_TEMPLATE_DATABASE=<database holding every registered migration> \
  bash scripts/proof/switch-checks/test-local.sh
```

The local test runs every check on the ready state, the guard refusals, and
at least one mutation per check that must turn it to FAIL (and PASS controls
for checks 10 and 11 and the named raise door): 61 runs.
