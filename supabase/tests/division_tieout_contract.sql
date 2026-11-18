-- Standalone proof for a fresh, disposable PostgreSQL cluster.
\set ON_ERROR_STOP on
\ir migration-contracts/20261118075750_xero_division_month_accounts/setup.sql
BEGIN;
\ir ../migrations/20261118075750_xero_division_month_accounts.sql
COMMIT;
\ir migration-contracts/20261118075750_xero_division_month_accounts/contract.sql
BEGIN;
\ir ../rollbacks/20261118075750_xero_division_month_accounts_down.sql
\ir migration-contracts/20261118075750_xero_division_month_accounts/rollback-contract.sql
ROLLBACK;
