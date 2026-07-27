# MLB-26267 job recovery — 2026-07-27

## Outcome

- **SWMS-261016 — roof report:** honestly blocked on the builder. The internal
  card note says: `ML Builders' work order contains no roof report link - ask
  MLB to send it.` The card remains `accepted / company_contact_required`.
- **SWMS-261017 — general make-safe:** a real five-page SecureWorks report draft
  now exists on the card, built from the submitted trade report and eight
  selected completion photos. The failed pack is now `drafted`; its old
  `draft_pack` failure and error text are cleared. The card remains
  `processing / admin_to_send_report`, which is now truthful because the draft
  exists.
- Nothing was emailed, invoiced, authorised, or released. Both card notes are
  `internal_only` with GHL sync disabled.
- The remaining human-controlled blocker on SWMS-261017 is the missing
  job-specific MLB SWMS. That exact action is recorded on the card.

## What the source emails actually contained

The SES group source and all aliases/replies for MLB-26267 were checked, not just
the card's captured links:

- The 16 July `NEW WORK ORDER` message said SecureWorks had been assigned
  MLB-26267, asked the trade to contact the client and schedule attendance, and
  asked for before/after photos and a SWMS with the invoice after completion.
- The second 16 July message said the member was away but was happy to be called
  and for the roof report attendance to proceed.
- The 16 and 17 July trade replies only reported unsuccessful attempts to reach
  the member.
- The later 20 July message supplied the separate physical make-safe work order.
- The only body URLs were email-signature/CDN assets and an Outlook mobile link.
  There was no `primeeco.tech/share/...` URL.

Every attachment was downloaded from the intake storage locator and inspected as
both PDF text/link annotations and rendered pages:

- Roof work order PO-56336: five pages, SHA-256
  `5f4bad5b50512370b9a8c4d6aaf21e5d69ff8c161635195b90b5fa75fcd6810e`;
  it says to submit through the “sharelink provided”, but contains no HTTP URL,
  embedded Prime link, or QR code. Its only link annotation is a `mailto:`
  address.
- Make-safe work order PO-56642: four pages, SHA-256
  `8ebf71d1766fb41821707ba22a3730cae8ae1f3eda4fd00697376ae53893cd19`;
  it likewise contains no Prime/share URL.

The roof Prime link is therefore genuinely absent from the emails and
attachments, not merely uncaptured by the card.

## SWMS-261017 report recovery

The 23 July failure came from the retired free-form Claude draft route. Its
provider helper did not check the HTTP response before attempting to extract a
JSON object, so provider failures and non-JSON responses collapsed into the
generic `Claude draft response did not contain a JSON object` error. That route
now returns HTTP 410 and is not the recovery path.

The deployed guarded deterministic renderer was used instead:

- Report document:
  `475a2d68-691b-4310-8eac-303b9e17bf3a`
- File:
  `Make Safe Report - MLB-26267-PO-56642-SWMS-261017 - U24-28-Peninsula-Road-Maylands-WA-6051.pdf`
- Render hash:
  `7c99e4f814b64db2ef3cc2d23a68b1e96f80b7b8083a768a007032984ae37dd2`
- Downloaded PDF SHA-256:
  `a01889ff0be1ec052ed754b924a6a14389f410cd7df740dd15e5aa9bb43c9b28`
- Visual verification: all five pages rendered cleanly; page 1 contains the
  attendance, findings, works and material selections, and pages 2–5 contain
  eight distinct completion-evidence images.
- Pack `6f411357-d543-4223-b2b8-7f6f6139c08f`:
  `status=drafted`, `failed_step=null`, `error_detail=null`,
  `report_doc_id=475a2d68-691b-4310-8eac-303b9e17bf3a`.

The source trade submission recorded two trades, `labour_hours=2`, storm/wind
damage, unsecured bricks and broken plastic sheeting, removal/re-securing work,
and no follow-up requirement. Eleven completion photos remain on the card. The
field is documented as ambiguous between total hours and hours per trade, so it
was not silently promoted into invoiceable hours-per-trade.

## Card truth after recovery

| Card | Final live state | Documents | On-card action |
| --- | --- | --- | --- |
| SWMS-261016 | `accepted / company_contact_required` | Work order only; no roof draft; no external link | Internal note `3c6616f3-e3fd-4077-bed2-3750993d6ab8`: ask MLB to send the missing roof report link |
| SWMS-261017 | `processing / admin_to_send_report` | Work order plus unsent make-safe report draft | Internal note `976b32a8-173a-41ea-95c7-bf6145a1582b`: attach the job-specific MLB SWMS before invoice or release; internal note `df81bea0-1708-4b53-9b94-d67faf3aca1c`: Captain/office must confirm billable hours per trade |

There are no Xero invoices on either card and the report document has
`sent_to_client=false`.

## Final U4 dry-run envelopes

### SWMS-261016

```json
{
  "http_status": 200,
  "action": "prepare_ses_docket_revision",
  "assembler_version": "ses-pack-assembler/v1",
  "dry_run": true,
  "state": "blocked",
  "docket_revision_id": "0574a126-0029-5c6e-9db8-97e4dbb2b375",
  "input_content_hash": "sha256:952b7aa65a4c04008857c7f224ab3366bb838c93884172aa6e02f2c63501db31",
  "output_content_hash": "sha256:d46afc803fe30d013e0eed3c8b01c4c22c8bf9080dfe9ab779ee59a22204d8f9",
  "classification": {
    "builder_key": "MLB",
    "family": "ordinary_roof_portal",
    "job_type": "roof_report",
    "report_delivery": "portal",
    "builder_reference": "",
    "required_deliverable_ids": []
  },
  "blockers": [
    {
      "reason_code": "spine_missing_source",
      "reason": "Correlation spine has no source_instruction_id.",
      "recovery_action": "Repair the U1 source accounting bind and re-run."
    },
    {
      "reason_code": "spine_missing_lineage",
      "reason": "Correlation spine is missing lineage, job, or source content identity.",
      "recovery_action": "Repair the U1 lineage/job authority bind and re-run."
    },
    {
      "reason_code": "spine_missing_source",
      "reason": "Builder reference is absent from the canonical source instruction.",
      "recovery_action": "Recover the WO/PO/external reference from the canonical source case."
    },
    {
      "reason_code": "spine_missing_deliverables",
      "reason": "Source instruction has no typed deliverables.",
      "recovery_action": "Complete deterministic instruction classification before pack preparation."
    },
    {
      "reason_code": "portal_link_absent",
      "reason": "The work order email contains no roof report link - ask the builder to send it.",
      "recovery_action": "Recover and bind exactly one typed roof report link from the source instruction."
    },
    {
      "reason_code": "invoice_reference_missing",
      "reason": "A local invoice proposal requires a non-empty builder WO/PO reference.",
      "recovery_action": "Recover the canonical builder reference before assembling any invoice line."
    }
  ],
  "portal_evidence": [],
  "invoice_proposal": null,
  "release_payload": {
    "invoice_create_approved": false,
    "client_send_approved": false,
    "send_email": false,
    "send_sms": false,
    "create_invoice": false,
    "authorise_invoice": false,
    "close_job": false
  },
  "persisted": false,
  "timing_summary": {
    "count": 1,
    "max_ms": 2309,
    "p95_ms": 2309,
    "all_within_five_minutes": true
  }
}
```

### SWMS-261017

The live deployed U4 action did not return a docket envelope. Its exact response
was:

```json
{
  "http_status": 500,
  "body": {
    "error": "renderMakesafeReportPdf: job.ref required"
  }
}
```

The source spine seed had not landed when this was run, so the canonical builder
reference was still empty. U4 nevertheless called the physical renderer and
turned a known blocker into an HTTP 500. This branch fixes that fail-closed
boundary: a physical dry run without a canonical builder reference now returns a
blocked result and never invokes the renderer. The regression test proves that
behavior locally. A fresh production envelope is required after this branch and
the parallel board-truth seed are merged/deployed.

## Code correction

No migration was added.

- `ses_assembler_input_adapter.ts` now consumes the exact keys written by
  `submit_makesafe_report`: `trade_count`, `damage_description`,
  `damage_cause`, `work_done`, `materials_used`, `invoice_notes`, and
  `arrival_time`. It carries `labour_hours` into exact report prose, but does not
  reinterpret that ambiguous field as invoiceable hours per trade.
- Numeric typed facts are no longer discarded by the adapter's non-empty check.
- `materials_used` remains report prose only; it is not promoted into priced
  invoice material lines.
- Physical report preparation now blocks before render when the canonical
  builder reference is absent instead of throwing HTTP 500.

Verification:

```text
deno test:
  ses_assembler_input_adapter_test.ts
  ses_prepare_docket_revision_test.ts
  makesafe_submit_report_test.ts
48 passed, 0 failed

deno check --config deno.jsonc supabase/functions/ops-api/index.ts
Check passed

deno task test:ops-api
2271 passed, 21 failed in unrelated fixture paths (compact-read fake clients,
portal queue cardinality, legacy send-pack cycle fixtures, and other tests
outside the changed U4 files); no changed U4 test failed
```
