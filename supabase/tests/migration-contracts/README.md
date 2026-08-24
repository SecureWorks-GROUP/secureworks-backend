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
   `BEGIN` / `ROLLBACK` so they do not leak into the next contract.
4. When the migration promises fail-closed behavior, add
   `preexisting-failure.sql` and `preexisting-failure.expected`.
5. When practical, add `break-contract.sql` and `break-contract.expected` to
   deliberately remove the promised behavior and prove the contract detects
   the break.
6. Run `bash supabase/tests/migration-contracts/run.sh` against disposable
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
