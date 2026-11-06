-- Rollback proofs receive a fresh forward stack, without positive-contract rows.
-- Seed the existing synthetic council binding and claim before reversing writes.
\ir contract.sql
