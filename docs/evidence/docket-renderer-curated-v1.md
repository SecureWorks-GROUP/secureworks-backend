# Docket renderer curated-report evidence

Date: 2026-08-03 (Australia/Perth)

Scope: served make-safe docket PDF only. Production reads were read-only. No
trade report, document, docket, storage object, invoice, message, migration or
deployment was mutated.

## CAUSE

The initiating trigger is `POST ops-api?action=prepare_ses_docket_revision`
(`index.ts`), which builds the live dependencies in
`createSesAssemblerRuntimeDependencies`. Before this correction, its
`renderPhysicalReport` dependency called `physicalReportRenderJob`, which
silently assembled builder-facing prose from immutable trade evidence:

- `materials_used` became Materials;
- `damage_cause` became Site Findings;
- `work_done`, `damage_description`, report notes and invoice/labour fields were
  fallback report copy;
- an assignment crew name became the client-facing Crew value.

That guessed payload then entered `renderMakesafeReportPdf`, whose deployed
contract rendered a billing row, a fifth Access/Follow-up prose section and two
photos per page. The masking condition was the existence of a deterministic PDF
and render hash: repeat assembly looked healthy because the same bad input
produced the same bad five-page bytes. The visible symptom was a compact raw
submission dump served from the docket artifact bucket.

Smallest counterfactual: if the live dependency had recovered the already typed
curated `makesafe_report` artifact and refused when no commercially clean,
current-cycle artifact existed, the raw checklist could never have reached the
served docket PDF.

## CHANGE

- The docket dependency now recovers an exact current-job/current-cycle typed
  `makesafe_report`, mirroring the existing bundled-report URL/byte recovery.
- A type alone is not trusted. The document must be cycle-bound and carry the
  active curated contract, renderer version and render hash in
  `data_snapshot_json`. Accepted renderer provenance is mechanically pinned to
  secureworks-wiki main revision
  `8348325bee364b2ddeddd7d853eb28d3178cde5e` and the reviewed authoritative
  renderer dependency hash recorded by the current docket sweep.
- `physicalReportRenderJob` now always raises `ses_curated_report_missing`; it
  cannot translate raw checklist fields into report prose.
- `makesafe_render_report` is retired for current curated evidence and refuses
  before attachment. The guarded current-wiki rerender path stamps trusted
  contract/hash/cycle provenance while preserving typed `makesafe_report`, the
  report-type-job refusal and existing visibility defaults.
- The TypeScript renderer now ports the current curated contract: embedded
  SecureWorks logo, no billing row, trade-count-only Crew, four required prose
  sections, commercial-content refusal and one large ordered photo per page.
  Legacy billing/access/follow-up inputs remain hash-compatible but are ignored
  by the builder-facing PDF.

No review page/spec, trade-document visibility filter, quote protection,
attachment bucket, report hash input or submitted trade record was changed.

## WHY IT FIXES IT

The served docket no longer has a data-flow edge from trade checklist prose to
the PDF renderer. The only production path is now:

`prepare_ses_docket_revision` -> exact current-cycle typed document selection ->
provenance guard -> HTTPS PDF byte recovery -> `supporting_report_pdf` docket
artifact.

The explicit renderer path separately validates structured curated prose before
creating the typed source artifact. Because its trusted provenance is written
only by the internal renderer-to-attach call, a legacy typed PDF cannot become
eligible merely by being named `makesafe_report`. Missing structure or a legacy
artifact therefore fails before docket persistence instead of falling back.

## VALIDATION

### Live before: named guinea pig

Job `208450c0-7161-4b30-9514-66226b054609`, reference `AJBR-70271`:

- actual `makesafe-docket-artifacts` PDF fetched read-only;
- SHA-256 `5f91cced8093c991c1fce314fc66a02ff6d9c74bf90beb31824ea4a854dbf01a`;
- 3,487,912 bytes, A4, five pages;
- contained `BILLING TIME NOTED`, `Storm / wind` as findings, the raw
  `materials_used` checklist and two evidence photos per page.

The existing typed nine-page report was also inspected as disconfirming
evidence. It has the desired curated narrative, `star pickets x 20` Materials
and one-photo-per-page shape, but it predates the commercial-separation contract
and contains a billing row with dollar/GST content. The new provenance guard
therefore rejects it; the implementation does not blindly serve it.

The live review page was opened read-only through `chrome-devtools-axi`. It
showed the current five-page docket attachment. Its page/spec presentation is
owned by `review-spec-trade-report-v1` and was not edited here.

### Live before: independent class card

Tuart Hill job `744cd493-831f-4d38-911e-76e281c4be6b`, reference
`MLB-26658PO-56313`:

- actual served PDF fetched read-only;
- five A4 pages, 4,128,405 bytes;
- contained the labour/trade billing row, raw material checkboxes and two
  photos per evidence page;
- live review page read confirmed that served attachment.

### Local correction proof

Focused Deno tests prove:

- legacy commercial inputs are absent from output while commercial content in
  rendered fields fails closed;
- crew names and missing curated prose fail closed;
- raw checklist fallback values cannot become renderer input or served docket
  bytes;
- a legacy typed PDF without clean renderer provenance is rejected;
- eight deliberately ordered photos produce nine A4 pages;
- the API action reaches the corrected renderer;
- identical curated input has the same render hash and byte-stable PDF after
  the repository's existing jsPDF `/ID` normalisation;
- the persisted docket uses the exact recovered curated PDF bytes and records
  their provenance.

Fresh focused result: 147 passed, 0 failed, 1 permission-gated subprocess test
ignored. The subprocess was then run with `--allow-run`: 4 passed, 0 failed,
including an eight-photo render under a 64 MB V8 old-space cap. `deno check`
passed for `index.ts` and every changed-path test; changed files pass `deno
fmt --check`, `deno lint` and `git diff --check`.

A privacy-safe local PDF was rendered and inspected with Poppler and page
images: 247,664 bytes, A4, nine pages. Extracted text contained the four prose
sections, `Star pickets x 20.` and evidence captions 1 through 8; deliberately
supplied legacy `billing_note: "$999 plus GST"` was absent.

The repository-wide `test:ops-api` command is not currently green independent
of this change: its type-check stops at two existing optional-string errors in
`cp1_drag_reschedule_test.ts`. A full `--no-check` runtime pass reached 3,080
passing tests and 18 existing failures outside the changed renderer/assembler
surface. No unrelated baseline test was changed for this task.

### Required live after proof

The Captain authorised this bounded production correction after the local
implementation evidence was established. It must run in this order:

1. merge and deploy only the corrected `ops-api` function and sweep code;
2. render AJBR-70271 and the selected Tuart Hill card from current
   secureworks-wiki main using its authoritative Python renderer, each with the
   already curated four-section payload and deliberate eight-photo selection,
   then attach the typed, cycle-bound artifact with the exact pinned source
   revision and hash provenance;
3. run the reviewed `ses-curated-docket-sweep-v1.ts` manifest in explicit
   apply mode; the operator invokes `prepare_ses_docket_revision` only for
   cards selected by the reviewed dry-run manifest;
4. perform read-only bucket fetch, PDF text/page/hash inspection and live
   review-page reads for both cards.

The after gate must show nine pages for eight photos, no commercial terms, AJBR
Materials `star pickets x 20`, the written trade narrative in its curated
section(s), and the same corrected class behavior on Tuart Hill. No send/contact
action or invoice authorisation is part of this correction; Xero remains at most
DRAFT.
