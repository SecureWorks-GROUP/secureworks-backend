-- Put back the three bodies this migration replaced (its own down
-- migration): the parties status block must fail again with SQLSTATE 22023,
-- the lane rule must count L1d's other as a crew text and our office alerts as
-- texts again, and our crew and staff templates (the roof report make-safe
-- alert among them) must read off the contact again. The contract must name
-- every one.
\ir ../../../rollbacks/20261006034000_context_party_roles_health_down.sql
