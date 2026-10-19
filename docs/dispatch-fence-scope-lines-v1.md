# Dispatch fence lines from the frozen scope

Extends slice 4's scope suggestion (`docs/dispatch-slice-4-contract.md`) to fencing jobs. Same action, same press, same rules for what is written: `POST dispatch_materials_suggest { job_id, supplier_id }`, staff only, onto a supplier already chosen on the job, only when the job has no lines, every line `not_reviewed`, `source` `scope`, no price, no order, no send. No migration.

## Source

The job's latest `scope_revisions` row with `status = 'frozen'` (highest `revision_number`), its `scope_canonical_text` parsed as the scoper document. Never `jobs.scope_json` (the live working copy: a draft revision can sit after the frozen one; one job had one on 19 Oct 2026) and never `pricing_json`. No frozen revision is `409 no_frozen_scope`. A revision that does not parse, or any panel the rules cannot read, is `409 scope_unreadable` with the reason; nothing is written.

## Rules

`dispatch_fence_scope_lines.ts`, pure. The fence designer's rules, as `generateWorkOrderDoc` already applies them:

| Line | Quantity | From |
| --- | --- | --- |
| `<profile> fence panel kit, <colour>, <sheet> mm sheet, <post> mm post[, long panel]` | panels in that group | `job.runs[].panels[]` grouped by sheet height, post length and long width |
| `Retaining plinth 150 mm, <colour>` | sum of each panel's plinths | `retaining / 150 + slopePlinths`, at most 4 per panel |
| `Patio tube 76x38 RHS 3000 mm` | per run with any panel on 3 or 4 plinths: those panels + 1 | designer rule |
| `Pedestrian gate kit <w> mm` / `Double swing gate kit <w> mm` | per gate | `job.gates[]` |
| `Gate post` | 2 per pedestrian gate, 4 per double | designer rule |

Post length: `FENCE_POST_LOOKUP` (sheet height x plinth height). A sheet height outside 1200/1500/1800/2100, or retaining not a multiple of 150, refuses the whole offer.

Not lines, returned in `held` for the person: the one end post beyond the panel kits, concrete (crew buy, the designer's bag count), fixings, removal, delivery. When the job's live `scope_json.job.runs` differ from the frozen runs (compared as JSON values; one single-job projection of the runs only), `held` also carries "The scope was changed after it was frozen: check these lines against the latest scope." The lines still come from the frozen revision. If that read fails, or the live scope has no runs to compare, `held` says the change could not be checked. The read is filtered on the job's `org_id`. The response also carries `scope_revision_number` and `scope_supplier` (the scoper's supplier text, shown only; a supplier name is never a key).

## Evidence

Real jobs, read-only 19 Oct 2026 (job numbers kept in the private evidence, not here). Two measurements, and only the second is the path this action reads:

- **Live scope (`jobs.scope_json.job.runs`) against each job's own purchase order**, 7 jobs: panels 7 of 7, plinths 6 of 6, patio tubes 1 of 1, gate kits and gate posts 1 of 1, post length 5 of 6 (one order bought 2400 mm posts where the table says 2700). These are the fixtures pinned in `dispatch_fence_scope_lines_test.ts` (cases A to G).
- **Latest frozen revision against the same orders** (independent check): only 3 of the 7 jobs have a frozen revision. Panels 2 of 3, plinths 3 of 3, patio tubes 1 of 1; gates and post length not testable. The miss is case A: its frozen revision has 8 panels (7 standard and 1 long) where its order took 9; its live scope holds 9 panels, differs from that frozen revision and was never frozen again, and the order matches the live scope. The rules read the frozen revision faithfully; the gap is a scope changed after freezing, which the `held` warning above now points out.
