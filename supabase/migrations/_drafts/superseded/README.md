# Superseded drafts — scope_revisions / scope_artifacts lineage note

Added 2026-06-10 by mission `scope-freeze-live-2026-06-10` (M1 git-parity
reconciliation, issue secureworks-backend#127).

## What happened

The frozen-scope substrate migrations were authored as drafts, applied to
production on 2026-05-04, then promoted and renamed — but only on the
`feat/slice-4-smart-booking` branch, which never merged to main. Main
therefore carried NO scope_revisions migration at all while production had
the schema live (confirmed by `supabase migration list --linked` on
2026-06-10: ledger versions 20260504090757 and 20260504125852 both applied
2026-05-04).

Lineage (all commits on `feat/slice-4-smart-booking`):

1. `d9e003a` — authored as drafts:
   - `_drafts/20260504000001_scope_revisions_and_artifacts.sql`
   - `_drafts/20260504000002_extend_artifact_type_enum.sql`
2. `031bedd` — promoted out of `_drafts/` after production apply
   (Codex stop-time review #1).
3. `9d682b3` — renamed to match the Supabase ledger versions exactly
   (Codex stop-time review #2):
   - `20260504090757_scope_revisions_and_artifacts.sql`
   - `20260504125852_extend_artifact_type_enum.sql`

## Resolution (this branch)

The final renamed files were copied byte-for-byte from
`origin/feat/slice-4-smart-booking` into `supabase/migrations/` so git main
matches production migration history. No database write was performed —
this is a git-parity commit only (step-0 outcome decision, mission evidence
`coding/work/missions/scope-freeze-live-2026-06-10/evidence/` in the wiki).

The `20260504000001` / `20260504000002` draft variants are superseded by
those files. They are not present in this directory because they never
existed on main; their content survives in branch history at `d9e003a` and
differs from the applied files only in header/status comment banners and
one `COMMENT ON` metadata string — the executable SQL is identical.

Do not re-apply: both migrations are idempotent (IF NOT EXISTS /
DROP IF EXISTS + CREATE / ON CONFLICT DO NOTHING) and already applied.
