# Skill: Make-safe deterministic-intake batch AI gap-fill

**Version:** makesafe-gap-fill-skill@2026-07-21.v1
**Runs on:** the captain's subscription Claude (Claude Code, or the always-on
Claude browser). **NOT the paid API.** This skill calls no paid model endpoint and
uses no API key beyond the ops master key already held by the ops tooling.
**Contract:** ops-api actions `makesafe_gap_fill_queue` (read) and
`makesafe_gap_fill_apply` (additive audited write). Code:
`supabase/functions/ops-api/makesafe_gap_fill.ts` +
`supabase/functions/ops-api/makesafe_gap_fill_report_ready.ts`.

This document is self-contained: a fresh subscription-Claude session can execute it
end to end with nothing but this file and the ops key.

---

## 1. What this does and why

The deterministic make-safe intake (live in production since 2026-07-21,
`docs/makesafe-deterministic-full-live-2026-07-21.md`) creates cases from builder
make-safe emails with **zero AI**. Anything it cannot resolve deterministically it
**flags for a human** instead of guessing:

- an **`exception`** case (reason-coded: `adapter_parse_failure`,
  `conflicting_fields`, `below_identity_floor`, `unknown_builder`, ...), or
- a **`blocked_live_job`** case (a live job blocked on a missing secondary field,
  in practice `client_phone`).

These flags stall the make-safe reporting run and Hugo's trade app. This skill
drains that backlog: it pulls the queue, resolves each flag with AI judgment where
the evidence already in the system is sufficient (email bodies, attachments, WO
PDFs), and writes the fill back with an audit trail. Genuinely unresolvable items
are left flagged with a one-line reason.

### Binding rules (captain rulings 2026-07-21)

1. **NO paid API.** Do all reading and judging inside this subscription-Claude
   session. Never call the Anthropic API or add an API key anywhere.
2. **NO approval gate.** Fills land directly. The reporting run and Hugo's trade
   app are the downstream human review surfaces.
3. **ADDITIVE ONLY.** A fill sets a currently-**empty** job-material field. Never
   overwrite a populated value, never delete/archive, never create a job, never
   change state / reason_code / lineage / canonical identity, never send anything.
   The `makesafe_gap_fill_apply` endpoint enforces all of this server-side — it is
   a backstop, not a licence to try.
4. **AUDITED.** Every fill is written with `last_decision_provenance='ai'` and a
   fresh decision reason, which the case triggers record as an append-only
   `case_update` event naming the AI gap-fill as the source.
5. **AI NEVER MINTS IDENTITY.** Builder WO/PO/reference identity is off-limits.
   If a case's only gap is its builder identity (`unknown_builder`, or
   `below_identity_floor` with no client/site material to recover), leave it for a
   human. The queue marks these `human_only: true`.

---

## 2. How to call ops-api

- **Endpoint:** `https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api`
- **Auth:** header `x-api-key: $SW_API_KEY` (the ops master key already held by the
  ops tooling / `ops.html`). Never paste the key into a file, a commit, or a
  browser page. If you do not have it, stop and ask the captain — do not proceed.
- **Reads** (`makesafe_gap_fill_queue`, `get_makesafe_email`,
  `get_makesafe_attachment_url`) are `GET action=...`.
- **The write** (`makesafe_gap_fill_apply`) is `POST` with a JSON body and
  `Content-Type: application/json`.

All actions here are also reachable through the SecureSuite MCP if the session has
it, but the raw HTTP calls above are the source of truth.

---

## 3. The procedure

### Step A — pull the queue

```
GET ops-api?action=makesafe_gap_fill_queue&limit=100
```

Response shape (`contract_version: "makesafe-gap-fill.v1"`):

```jsonc
{
  "totals": { "intake_flags": N, "ai_fillable": N, "human_only": N, "report_ready": N },
  "intake_flags": [
    {
      "kind": "intake_flag",
      "case_id": "…", "instruction_key": "…",
      "state": "exception" | "blocked_live_job",
      "reason_code": "adapter_parse_failure" | "conflicting_fields" | …,
      "builder": "mlb", "external_ref": "MLB-27037",
      "builder_wo": "WO-27037", "builder_po": null,
      "present": { "client_name": null, "site_address": null, "client_phone": null, … },
      "missing_fields": ["client_name","site_address"],
      "conflicting_fields": {},            // { field: [candidateA, candidateB] }
      "blocked_reasons": [],
      "gap": "Exception: deterministic parse left required field(s) empty: …",
      "ai_fillable_fields": ["client_name","client_phone","client_email","site_address","site_suburb"],
      "human_only": false,
      "recovery_hints": { "client_name": "extract_client_name_from_selected_instruction" },
      "evidence_sources": [
        { "post_id": "…", "role": "original", "subject": "…", "from_email": "…",
          "attachments": [ { "attachment_id": "…", "name": "Work Order.pdf",
                             "content_type": "application/pdf", "status": "uploaded",
                             "is_pdf": true } ] }
      ]
    }
  ],
  "report_ready": [
    { "kind": "report_ready", "job_id": "…", "job_number": "SWM-…",
      "builder": "ajs-ajbr", "external_ref": "AJBR-…", "service_report_id": "…",
      "why": "trade report submitted; make-safe report pack not yet drafted" }
  ]
}
```

### Step B — resolve each intake flag

Iterate `intake_flags`. **Skip** any item where `human_only == true` or
`ai_fillable_fields` is empty (nothing an AI may safely recover) — record it in
the run summary as left-for-human with its `gap` line.

For each remaining item, for each field in `ai_fillable_fields` that you want to
resolve:

1. **Read the evidence.** For each `evidence_source`:
   - Email body + metadata: `GET ops-api?action=get_makesafe_email&post_id=<post_id>`.
   - Each PDF attachment (`is_pdf: true`, `status: "uploaded"`):
     `GET ops-api?action=get_makesafe_attachment_url&attachment_id=<attachment_id>`
     returns a short-TTL signed URL. Fetch and read the PDF yourself in-session.
   - `recovery_hints[field]` tells you what the deterministic engine wanted (e.g.
     "extract_client_name_from_selected_instruction" — the value lives on the
     selected instruction, often in the WO PDF's client block).
2. **Judge.** Only decide a value when the evidence is **unambiguous**. MLB "NEW
   WORK ORDER" emails commonly carry the homeowner only in an image-font PDF — the
   client name/phone/address are in the WO PDF's client block. If two sources
   disagree (a `conflicting_fields` case), pick the value the primary WO document
   states; if you cannot tell, do not fill it.
3. **Never invent.** No plausible-but-unsourced values. No builder WO/PO/reference
   identity. If the field is not clearly present in the evidence, leave it.

### Step C — write the fill

```
POST ops-api?action=makesafe_gap_fill_apply
Content-Type: application/json
{
  "case_id": "<case_id>",                     // or "instruction_key": "<key>"
  "fills": { "client_name": "Jane Doe", "site_address": "10 Test St, Perth WA 6000" },
  "evidence_note": "client_name + address from WO PDF att-<id> (post <post_id>)"
}
```

- Only include fields you actually resolved. Empty/blank values are ignored.
- The endpoint fills only currently-empty allow-listed fields
  (`client_name, client_phone, client_email, site_address, site_suburb`). It
  **skips and reports** any field that is not allow-listed, is already populated,
  or is blank — those come back in `skipped[]`. This is expected and safe.
- Response: `{ ok, applied, filled, skipped, reason }`. `applied: false` with
  `reason: "no_fillable_change"` means nothing needed writing (idempotent re-run).
- The write drops each filled field from `missing_fields` and clears the matching
  `conflicting_fields` key. It does **not** change the case state — the case stays
  a flag until the deterministic resume or a human promotes it. That is correct:
  the point is to make the case review-ready, not to auto-promote it to a job.

### Step D — report-ready items

`report_ready` lists jobs where a trade submitted a report but the make-safe
report **pack has not been drafted yet** (same predicate the reporting run uses,
`selectDraftPackDueJobIds`). This skill does not draft packs. Surface the count and
job numbers in the run summary and hand them to the make-safe reporting autopilot
(`draft_makesafe_report_pack_due`) — that is the run that converts them to
human-review-ready drafts. See the ping design in
`docs/makesafe-gap-fill-ping-design.md` for how this queue gets nudged in
real time.

### Step E — write a run summary

At the end, record (in the campaign folder / close-out, not in production data):

- counts: flags seen, fills applied, fields filled, items left human-only, items
  left unresolvable;
- for each unresolvable item: `case_id` + a one-line reason (e.g. "WO PDF
  illegible; no client block");
- the `report_ready` job numbers handed to the reporting run.

---

## 4. Triggers (how this skill gets run)

Two triggers drive this subscription-Claude skill (never the paid API):

- **(b) Scheduled batch — 3 to 4 times daily.** A Claude Code `/schedule` routine
  (or equivalent always-on Claude job) runs Steps A-E on a cron. This is the
  steady drain of the backlog into human-review-ready state.
- **(a) Trade-report-submitted ping.** When a trade submits a report, a ping tells
  this session that reporting work is ready, so a sweep can run promptly instead of
  waiting for the next scheduled slot. The pull side (the `report_ready` queue
  section) is live now; the real-time push wiring is specified in
  `docs/makesafe-gap-fill-ping-design.md` (it needs a captain decision on the
  delivery channel because a real push requires a secret, which the no-new-secrets
  rule forbids adding blind).

---

## 5. Safety checklist (run before every write)

- [ ] The case is `exception` or `blocked_live_job` (the endpoint refuses others).
- [ ] Every value is copied from evidence you actually read this session.
- [ ] No builder WO/PO/reference identity in `fills`.
- [ ] No field you are overwriting was already populated.
- [ ] `evidence_note` cites the source (post id / attachment id).
- [ ] You did not call any paid API and added no secret anywhere.

If any box is unchecked, do not write — leave the flag and note why.
