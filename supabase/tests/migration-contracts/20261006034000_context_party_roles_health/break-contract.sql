-- Put back the three bodies this migration replaced (its own down
-- migration): the parties status block must fail again with SQLSTATE 22023,
-- the lane rule must count L1d's other as a crew text again, and our crew and
-- staff templates must read off the contact again. The contract must name all
-- three.
\ir ../../../rollbacks/20261006034000_context_party_roles_health_down.sql
