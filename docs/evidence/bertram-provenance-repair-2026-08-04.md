# Bertram protected report repair — 2026-08-04

Owner evidence for the protected repair of `SWMS-261109` / `AJBR-70271`
(`208450c0-7161-4b30-9514-66226b054609`). This lane may replace the current
curated report and prepare a new review revision; it may not edit the submitted
trade report, create or approve an invoice, or send a communication.

## Audit finding

Production proves a same-name `attachMakesafeDocument` overwrite, followed by a docket prepare that copied the damaged source rather than causing it: document `1378390d-4d88-4ab8-99ea-b8d937782c76` retained the filename `Make Safe Report - AJBR-70271 - Bertram.pdf`, was attached with the corrected content at `2026-08-03T10:05:25Z`, then received a second `makesafe_document_attached` event at `2026-08-03T10:28:08.927Z`, advanced to version 3, and its fixed storage object was updated at `2026-08-03T10:28:08.826351Z`; both that object and the current review artifact now serve the older 9-page SHA-256 `3e2ee3b9ac47fc2d21fd58144ce7152a97b01c46eedc10485c0e5bda3d5d97ad`. Revision `c38ac9e4-8729-586d-8c15-7466311964d2` was committed later at `2026-08-03T10:32:12.514508Z` and records the same source document and hash, so re-prepare merely propagated the already-overwritten bytes. The exact HTTP caller is not recoverable because `uploaded_by` is null, but the overwrite mechanism is conclusive: `attachMakesafeDocument` uploads with `upsert: true` to the stable `${jobId}/${fileName}` path and updates the existing `(job_id,type,file_name)` row with a version bump, while docket prepare reads that current document and writes a separate immutable artifact with `upsert: false`. This is the filed `job-document-attach-versioning-v1` idempotent-destructive attach class.

All production inspection used the Supabase Management API database-query
endpoint with `read_only: true`. No client-identifying fields are reproduced in
this document.

## Protected repair contract

The card remains mutation-excluded by default. The additive exception accepts
only all of the following together:

- job `SWMS-261109` at the exact job UUID;
- operator authority `bertram-provenance-repair-v1`;
- the reviewed old document ID, version 3, and served SHA-256 `3e2ee3b9…`;
- the reviewed current docket revision and its served SHA-256 `3e2ee3b9…`;
- deterministic candidate SHA-256 `5c0dfc02488907f9e4ac1196a1dee6d390ba61a38afd0fb3b20e37139c6f13f8`.

The compare-and-swap check runs before storage or database mutation. A moved
source document, review pointer, artifact metadata, or served byte stream is a
409 refusal. The new report uses a content-addressed filename, so it does not
overwrite the old object. The normal current-wiki attachment boundary then
stamps the renderer revision and script hash, report contract/version/input
hashes, `evidence_source=current_cycle_curated_makesafe_report`, the
self-referential `source_document_id`, attendance-cycle binding, and the scope
narratives consumed by the assembler's pricing evidence gate.

The operator `scripts/ses-bertram-provenance-repair-v1.ts` defaults to dry-run.
Its `--apply` path invokes exactly two mutation actions: the protected current
report attach, then one content-addressed docket prepare. It subsequently performs a
read-only fresh prepare and refuses unless the pack is `ready`, has no blockers,
contains 6 labour hours at $80 and 20 pickets at $13.50, totals $750 ex / $75
GST / $825 inc, and exposes all three email drafts. There is no call to any
invoice mint, approval, release, or send action.

## Render proof

The renderer is the reviewed current wiki implementation at
`915e9b423fc597d656c7cb090671bf206138114b`, renderer script SHA-256
`fda63bcffa0177b702089e67b5719ae50642a9972aa3628c516fcedb1cfe42dc`,
with `RL_invariant=1` and content-backed `ImageReader` inputs. The protected
candidate is deterministic:

- SHA-256: `5c0dfc02488907f9e4ac1196a1dee6d390ba61a38afd0fb3b20e37139c6f13f8`
- bytes: 6,528,305
- PDF pages: 36 A4 pages
- completion photos: 35/35, with 35 extracted `Photo evidence N` labels
- materials: `20 star pickets installed to prop and secure the existing fence line.`
- scope, findings, and works: present in full
- commercial text scan: zero dollar, AUD, GST, invoice, billing, billed,
  dollar, hour, hourly, rate, subtotal, or total tokens

`pdftotext` output and `pdfimages -list` were byte-for-byte identical to the
preserved corrected `fac1ad93…` content standard. The new raw PDF hash differs
because the current trusted renderer now fixes PDF creation/modification
timestamps for deterministic output. Poppler renders of pages 1, 18, and 36
were inspected and show the full narrative, photo 17, and photo 35 without
layout defects.

## Verification and release boundary

Local verification on this branch:

```text
deno fmt                                      clean
deno lint                                     clean
deno check index.ts + protected operator      clean
makesafe_render_report_action_test.ts          7 passed / 0 failed
Bertram sealed-picket pricing regression       1 passed / 0 failed
ses-curated-docket-sweep tests                14 passed / 0 failed
git diff --check                              clean
```

Production application is intentionally not possible from this feature
worktree. `docs/project-knowledge/OPS_API_SOURCE_OF_TRUTH.md` forbids an
`ops-api` deploy from any feature/card worktree; the change must merge to
`main`, deploy through the serialized production Edge workflow, and pass its
smoke checks first. After that deploy, the protected operator's `--apply` path
must produce the final evidence envelope. It verifies, before reporting
success, the new job-document production row and provenance snapshot, the
current review pointer and artifact metadata, the exact bytes downloaded from
both the job-document URL and the review-served `supporting_report_pdf` URL,
and the fresh READY pricing/draft contract above.
