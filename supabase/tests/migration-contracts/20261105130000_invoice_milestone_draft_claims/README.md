# Accepted invoice draft migration contract

This case verifies the immutable accepted quote/payer binding, draft claim admission and preserving rollback. It uses synthetic rows in disposable localhost PostgreSQL. It makes no provider request and sends nothing.

The registered runner executes positive contracts against the complete forward stack, then rebuilds a fresh forward stack for each rollback proof. Positive-contract rows do not carry into that rollback database. `rollback-before.sql` therefore includes this case's existing `contract.sql` to populate the exact confirmed draft identity before applying the down migration. `rollback-contract.sql` must still prove that identity survives and dispatch writes are disabled.

Before this fixture seed existed, the full registered run passed the positive contract but failed the rollback contract with `Rollback lost draft identity` (exit 3). Omitting the seed reproduces the same failure in the bounded registry proof; restoring it passes. The fixture INSERTs also supply the mandatory `totals_snapshot_json`, and the focused setup enforces its NOT NULL constraint. No production migration or runtime guard is relaxed.

Run the full registered proof only against a disposable localhost database, replacing the example port if needed:

```sh
MIGRATION_CONTRACT_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:56437/postgres \
MIGRATION_CONTRACT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
bash supabase/tests/migration-contracts/run.sh
```

The narrower invoice command checks its positive contract, concurrent claim admission and preserving rollback in one disposable database. It is separate from the full registered runner and its freshly rebuilt rollback phase:

```sh
INVOICE_DRAFT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56437/postgres \
INVOICE_DRAFT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres \
bash scripts/test-invoice-milestone-drafts.sh
```

A local focused pass does not substitute for current-head required CI. Full registered CI, browser acceptance and live supplier/accounting outcomes remain distinct evidence.
