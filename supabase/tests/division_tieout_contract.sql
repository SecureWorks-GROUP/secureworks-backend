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

\ir migration-contracts/20261118111052_division_tieout_tables/contract.sql
BEGIN;
\ir ../migrations/20261118111052_division_tieout_tables.sql
\ir ../rollbacks/20261118111052_division_tieout_tables_down.sql
\ir migration-contracts/20261118111052_division_tieout_tables/rollback-contract.sql
ROLLBACK;

BEGIN;
\ir migration-contracts/20261118153103_division_tieout_our_lines/setup.sql
COMMIT;
\ir migration-contracts/20261118153103_division_tieout_our_lines/contract.sql
BEGIN;
\ir ../migrations/20261118153103_division_tieout_our_lines.sql
\ir ../rollbacks/20261118153103_division_tieout_our_lines_down.sql
\ir migration-contracts/20261118153103_division_tieout_our_lines/rollback-contract.sql
ROLLBACK;
