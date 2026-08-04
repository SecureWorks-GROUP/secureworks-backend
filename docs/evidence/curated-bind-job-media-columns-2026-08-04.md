# Curated bind phantom `job_media` columns

Date: 2026-08-04

Follow-up defect fix to `bind_current_cycle_curated_makesafe_report`
(`docs/evidence/curated-bind-ops-deadend-v1.md`). The durable diagnosis and the
Munster acceptance ledger live in the secondmate home at
`data/munster-live-docs-ready-v1/report.md`, not in this repository.

## The defect

`assertCurrentWikiSourceEvidence` enumerated the photo-source read as:

```
.select('id,storage_url,type,phase,attendance_cycle_id,cycle_attribution,cycle_number,created_at,sort_order,order_index')
```

`job_media` has **no `cycle_number`, no `sort_order` and no `order_index`** — in
any environment. No migration declares them; the base table
(`20250301000001_schema.sql`) never had them and
`20260728000001_makesafe_state_authority_u2.sql` adds only
`attendance_cycle_id`, `cycle_attribution`, `makesafe_fact_version` and
`makesafe_content_hash`.

So PostgREST answered `42703 undefined_column`, the client set `error`, and
**every** curated bind that reached the photo step refused with
`curated_bind_source_evidence_read_failed` (HTTP 503). Reproduced against
production on the deployed `62e66d5` build; the production Postgres log for that
request reads `column job_media.cycle_number does not exist`.

This is the hazard the root `CLAUDE.md` records for enumerated selects: an
explicit projection turns schema drift into a PostgREST 400, and here the
enumeration was wrong from the first commit. The mocked suite could not see it,
because a stub answers any select and the fixtures supplied columns production
does not have.

## The second half: ordering

The in-memory comparator claimed to "match assembler ordering
(sort_order/order_index then id)". It did not. With neither column present every
row scored `0`, so the comparator fell straight through to the `id` tiebreak and
the photo sequence was ordered by id.

The served curated artifact is ordered by `created_at`. Verified empirically on
the Munster report (`SWMS-261065`, raw SHA-256 `8891cba8…`): its nine rendered
photo pages were matched back to their `job_media` rows perceptually, all nine
uniquely and at Hamming distance 0, and the rendered sequence equals `created_at`
ascending and does **not** equal id ascending.

Photo order is therefore `created_at` ascending with `id` as a stable tiebreak
for equal timestamps — the same order the media read already asks PostgREST for.

Note the separate, untouched inconsistency: the assembler's own photo list
(`ses_assembler_input_adapter.ts`) still applies the same
`sort_order ?? order_index ?? 0` sort after its `created_at` fetch, so it too
collapses to id order. That is outside this fix's boundary and is recorded, not
changed.

## Boundary

No schema migration — the missing columns are **not** added to the database. No
evidence gate is weakened: photo-source accounting and photo-byte SHA-256
verification stay exactly as strict, and a payload whose photo sequence
disagrees with the source order is still refused
`curated_bind_photo_source_mismatch`.

## Regressions

`makesafe_render_report_action_test.ts`:

- `curated bind job_media select names only real columns` — pins
  `CURATED_BIND_JOB_MEDIA_COLUMNS` against the live `job_media` column set and
  names the three phantom columns explicitly.
- `curated bind survives a client that rejects unknown job_media columns` — a
  schema-faithful stub that answers `42703` for any unknown column, so a mocked
  fixture can no longer hide this class.
- `curated bind photo accounting orders by created_at, then id` — id order and
  `created_at` order deliberately disagree, with a shared timestamp to exercise
  the tiebreak; the id-ordered payload must be refused.

All three fail against the previous code and pass against this one.
