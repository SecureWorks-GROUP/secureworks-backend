\set ON_ERROR_STOP on
\ir migration-contracts/20261118112406_supplier_credit_drafts/setup.sql
BEGIN;
\ir ../migrations/20261118112406_supplier_credit_drafts.sql
COMMIT;
\ir migration-contracts/20261118112406_supplier_credit_drafts/contract.sql
BEGIN;
\ir ../rollbacks/20261118112406_supplier_credit_drafts_down.sql
\ir migration-contracts/20261118112406_supplier_credit_drafts/rollback-contract.sql
ROLLBACK;
\echo PASS supplier credit drafts contract
