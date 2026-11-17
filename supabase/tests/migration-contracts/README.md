# PostgreSQL migration contracts

The `migration-contracts` PR job runs these tests against a disposable
PostgreSQL 17 service. It does not use production credentials or a live
Supabase project.

To register a new migration contract:

1. Create a directory under `supabase/tests/migration-contracts/` whose name
   exactly matches the migration filename without `.sql`.
2. Add `setup.sql` with only the pre-migration tables and columns that contract
   needs. Make it compatible with the setup files for earlier registered
   migrations because the runner applies registered cases in timestamp order.
3. Add `contract.sql` with observable SQL assertions. Wrap fixture writes in
   `BEGIN` / `ROLLBACK` so they do not leak into the next contract. Never mix
   a recorded date with the run's clock: give a job that a dated fixture
   message is placed on a fixed `created_at` before the message (since
   `20260924140000` a job created after a message is its candidate only
   inside its 30-day lead window), and set any first-apply instant a fixture
   reads to a fixed value inside the rolled-back transaction. Otherwise the
   contract passes until a calendar date and then fails on every PR (C1a R7
   on 8 Oct 2026).
4. When the migration promises fail-closed behavior, add
   `preexisting-failure.sql` and `preexisting-failure.expected`.
5. When practical, add `break-contract.sql` and `break-contract.expected` to
   deliberately remove the promised behavior and prove the contract detects
   the break.
6. When a down migration exists, add `rollback-contract.sql`. The runner
   applies the forward stack through that case, executes
   `supabase/rollbacks/<case>_down.sql`, and then asserts the restored legacy
   surface. This catches dependency-order failures that static SQL review does
   not.
7. Run `bash supabase/tests/migration-contracts/run.sh` against disposable
   localhost PostgreSQL using the command below. CI runs the same entrypoint.

The required directory shape is:

```text
supabase/tests/migration-contracts/<timestamp>_<migration_name>/
  setup.sql
  contract.sql
```

The runner applies every registered migration in timestamp order, then runs
each `contract.sql` with `psql -X -v ON_ERROR_STOP=1`.

Two optional pairs make failure behaviour executable:

- `preexisting-failure.sql` plus `preexisting-failure.expected` proves the
  migration fails closed on an invalid pre-existing state.
- `break-contract.sql` plus `break-contract.expected` deliberately removes the
  promised behaviour and proves that `contract.sql` fails for the expected
  reason.

An optional `rollback-contract.sql` executes after the matching down migration
and proves both that it ran cleanly and that the promised legacy schema remains
queryable.

Each fail-closed, rollback and break proof runs in a copy of a database the
runner already built (`CREATE DATABASE ... TEMPLATE`), never in a fresh replay
of the whole registered stack: a fail-closed proof copies the forward walk just
before its migration, a rollback proof copies a second walk just after its
migration, and a break proof copies the full stack as it stood before any
contract ran. Replaying the stack per proof made the job grow with the square
of the case count (35 to 80 minutes on 16 Oct 2026, past the 90 minute job
limit on slower runners). Do not reintroduce a per-proof replay.

Every statement runs under a 15 minute `statement_timeout`
(`MIGRATION_CONTRACT_STATEMENT_TIMEOUT` overrides it), so a statement that
waits forever fails with its own error under its `== label ==` line instead of
holding the job until GitHub cancels it.

Run the suite locally only against disposable localhost PostgreSQL:

```sh
MIGRATION_CONTRACT_ADMIN_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/postgres' \
MIGRATION_CONTRACT_DISPOSABLE_ACK='I-confirm-this-is-disposable-local-postgres' \
bash supabase/tests/migration-contracts/run.sh
```

The full historical migration directory is not replayed by this job. It
contains Supabase-only schemas and extensions, duplicate historical versions,
and known live-schema baseline drift. The narrow setup files keep this job a
deterministic constraint test rather than pretending that history is a clean
database bootstrap.

## Job Profit, context and pay parity (cx-ci-parity)

`supplemental-migrations.txt` inventories the omitted domain migrations. Both
forward walks try these at their number alongside registered cases. Each try
uses `psql --single-transaction`: a refusal rolls back that whole file and is
listed as `supplemental refused` with SQLSTATE, never partly applied. The
`public-object-parity` artifact includes the applied/refused inventory for
both walks. Client/connection failures stop the walk. Existing registered
migration errors still fail the suite. A successful supplemental application
is schema-build coverage, not a new behaviour contract. Historical migration
files and their guards are unchanged. These are disposable database writes only.

The runner exports view/function digests with the comparison script's `--sql`
when `MIGRATION_CONTRACT_CATALOG_OUTPUT` is set, immediately after the first
walk and before assertions or rollbacks. It never exports business rows or
function bodies. The existing fixtures still contain stand-ins; equality is
limited to the actual exported view definitions and function bodies.

Shard 0 on main and manual runs compares that export with
`live-public-object-md5.tsv`, the director's 18 Nov catalog. The snapshot was
inspected before copying: object identifiers, argument type signatures and md5
only, no business names, amounts or row ids. The director refreshes that file
from `compare-public-object-md5.ts --sql` on live, with UTC, matching
`search_path` and PostgreSQL deparser version, then commits the new snapshot.
Workers and CI never query live. The snapshot's date is evidence of that read,
not proof of current production. No automatic re-snapshot or digest waiver.

`--scope job-profit-context-pay` fails for changed, live-only or fresh-only
objects in the union of both catalogs, except the closed unsourced inventory below. Job Profit covers `job_profit`,
`job_cost`, job cost/revenue/expected/profit views and Bookkeeping evidence;
context covers context-named routines, evidence-health views and the
attribution/booking entries;
pay covers trade/group routines, crew guards and their views. Each input must
contain all three areas. Other domains remain outside this gate. An unreadable,
empty or malformed input fails. A difference after an intentional code change
still needs the director's live refresh; it is never silently accepted.

Required job names and all existing contracts/proofs remain unchanged. The
catalog and comparison report are retained in the `public-object-parity` CI
artifact for seven days. No live switch, install, Xero payload or customer
behaviour changes on merge. No new migration, trigger, schedule or stand-in.

The director's 18 Nov instruction classifies the 23 objects without a repository
declaration in `live-only-unsourced.tsv` (source: `docs/evidence/cx-schema-sort-18nov.md`).
The parity step passes `--live-only-unsourced` and lists exact live-only matches
as **live-only-unsourced**, informational rather than failing. The report lists
all matching objects across the full snapshot, including the six context evidence
views and objects outside the scoped gate. This is source-recovery work for the
director, not equality proof or permission to remove live objects.

The inventory is kind/signature/hash pinned. A changed live hash, another overload,
a changed definition present in both catalogs, a fresh-only object or any unlisted
live-only object still fails inside the scope. Without the flag the comparator
keeps its original full-difference behaviour. Malformed or unreadable inventories
fail like other inputs. The two context first-apply literals and all sourced
differences remain failures; no body is normalised or replaced by this classification.
