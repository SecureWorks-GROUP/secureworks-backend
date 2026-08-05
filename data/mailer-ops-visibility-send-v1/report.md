# Mailer ops-visibility send v1

**Status:** STOPPED before any external send — transport path unavailable under standing fences.  
**Checkpoint:** card one (Maylands) prepared; zero of eight emails sent.  
**Authorised scope (Captain YES):** eight ordinary `admin@` → `mlb.mailer@primeeco.tech` sends (report PDF + capped photos), no invoice, no `makesafes@` packs, no `execute_ses_release_revision`.

---

## Cards (resolved)

| # | Prefix | Full job id | Job number | Ref | Suburb | Sealed |
|---|--------|-------------|------------|-----|--------|--------|
| 1 | `1e05db49` | `1e05db49-cc42-477b-9689-cbdceed649da` | SWMS-261017 | MLB-26267 | Maylands | yes |
| 2 | `f8c19311` | `f8c19311-611d-4c8f-87b6-bb2005c47bda` | SWMS-261080 | MLB-27148 | Floreat | yes |
| 3 | `db3f2242` | `db3f2242-d10c-42f0-80b9-7d684e62c6fe` | SWMS-261020 | MLB-27037 | Floreat | yes |
| 4 | `d97067be` | `d97067be-62e7-48e2-acff-344bb7473dd5` | SWMS-261115 | MLB-27387 | Morley | yes |

All four are `type=makesafe` with `ses_money_sealed_at` set. Per standing fence, every SWMS / makesafe card is treated as sealed for legacy Outlook send.

---

## Card 1 — Maylands (MLB-26267) readiness

### Subject (PR 591 resolution path)

PR 591 order: `emails.subject` for a **proven** intake `post_id` → `makesafe_intake_drafts.subject` → `jobs.metadata.builder_email_subject`. Ambiguity refuses; never invent.

| Tier | Result |
|------|--------|
| Intake case sources / `emails.subject` | **Empty** — case `ad6b6a2e-206f-49af-9d8f-e41ea2504081` has no `makesafe_intake_case_sources` rows (`post_id` null). |
| Approved intake draft subject | **Exact match** — draft `6960c405-50b5-4008-9513-e05c0a25c0b3` subject: `NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051` |
| `jobs.metadata.builder_email_subject` | **Same string** (single candidate, not ambiguous) |

**Subject to use (exact, not fallback):**  
`NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051`  
**Subject source for ledger:** `makesafe_intake_drafts.subject` / `metadata.builder_email_subject` (aligned).  
**Photo fallback `Photo Evidence - MLB-26267`:** not required for this card.

### Report attachment (ready, not sent)

| Field | Value |
|-------|--------|
| `job_documents.id` | `f24ae0f7-4bc7-4fe0-877a-74a95fb13d9e` |
| `type` | `makesafe_report` |
| `file_name` | `Make-Safe-Report-MLB-26267-Maylands-e925c4e48396.pdf` |
| Public URL | `…/job-documents/1e05db49-…/Make-Safe-Report-MLB-26267-Maylands-e925c4e48396.pdf` |
| Downloaded size | 2 387 411 bytes (`%PDF-1.4`) |

Chosen as the newest `makesafe_report` on the card (2026-08-03). Older report/SWMS/work-order rows intentionally not used. **No invoice document selected.**

### Photos (ready, not sent)

| Metric | Value |
|--------|--------|
| Photos available | **11** (all `type=photo`) |
| Cap | ~10–15 (Captain exception for this path only) |
| Planned send | **11 / 11** (under cap; full set is the representative set) |

Billing pack / docket photo completeness is untouched by this plan.

### Send plan (not executed)

1. Report email: from `admin@secureworkswa.com.au` → to `mlb.mailer@primeeco.tech` only; exact subject above; attach report PDF only; no CC/BCC; no invoice.
2. Photo email: same from/to/subject; 11 photos; no invoice.
3. Prove both in admin@ Sent Items (message id, subject, recipient, attachment names, `x-secureworks-ses-operation` if stamped).
4. **Stop** and re-report before cards 2–4.

---

## Why zero emails left this machine

Captain forbids `execute_ses_release_revision` (Maylands has a prior release effect in `unknown`; do not touch/reconcile/retry). Ordinary direct send was attempted via every available production transport:

### 1. `send-outlook-email` (Graph Mail.Send) — refused

Live probes with `SW_API_KEY` (no mail delivered; invalid/non-builder recipients only):

| Probe | HTTP | Result |
|-------|------|--------|
| PDF `contentBytes` without `job_id` / `job_document_id` | 409 | `pdf_provenance_required` |
| Any body with sealed `job_id` | 409 | `sealed_ses_release_required` (`matched_by: job_seal`) |

So:

- Report PDF **cannot** go through this function without a `job_document_id` (or invoice id).
- Supplying the real `job_document_id` loads the sealed Maylands job and hits the money fence.
- Passing `job_id` alone is also refused for all sealed SES jobs.

This is the standing design: *“Do not route sealed SES releases through send-outlook-email; that function refuses sealed jobs by design.”* (`ses_graph_mail_gateway.ts`)

### 2. SES Graph gateway (`createDraftAndSend`) — out of scope

The only production ordinary Mail.Send + Sent Items proof path for sealed SES is the release execute path. Captain boundary: **do not call `execute_ses_release_revision`.**

### 3. SecureSuite `sw_send_email` — recipient gate

With `to_email=mlb.mailer@primeeco.tech` (with or without Maylands `job_id`):

```text
code: recipient_unverifiable
reason: no_anchor
```

Agent layer requires a trusted contact/job recipient anchor. MLB company row has `sender_patterns: ["mlb.mailer@primeeco.tech"]` but `report_recipient: makesafes@mlbuilders.com.au` (billing pack destination — out of scope for this path).

### 4. Direct Graph from the crewmate environment — no app credentials

- Project secrets are available only as **digests** (Management API / `supabase secrets list`).
- Plaintext `MICROSOFT_TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` are not on the local agent env.
- Production Edge Deploy Rule forbids shipping `ops-api` / `send-quote` from this worktree; no mailer-specific action exists on live `ops-api` (`mailer_ops_send`, `ops_visibility_send`, … all `Unknown action`).

### 5. Boundaries observed (nothing written to builder)

- No call to `execute_ses_release_revision`.
- No invoice attach, mint, approve, authorise, void.
- No `makesafes@` resend.
- No re-prepare / pack / docket mutation.
- Bertram / Munster / Queens Park not touched.
- No real send to `mlb.mailer@primeeco.tech`.

---

## Cards 2–4

Not started. Checkpoint rule: prove card one Sent Items first. Card one has no Sent Items proof because no send was possible.

---

## Decision needed (firstmate / Captain)

Pick one transport that keeps the money fence intact and still matches the YES:

1. **Temporary sealed-SES ordinary-mail exemption** for this path only: `send-outlook-email` may send when  
   `from=admin@` AND `to` is exactly `mlb.mailer@primeeco.tech` AND attachments contain no invoice PDF AND optional `job_document_id` is `makesafe_report` only — then crewmate re-runs card one.
2. **New ops-api action** (e.g. `send_mailer_ops_visibility`) wired to `createSesGraphMailGateway` / ordinary Mail.Send with operation-token Sent Items proof, hard-coded recipient and no-invoice allow-list — deploy from release `main` only.
3. **Provide a one-shot Graph app credential channel** to the crewmate (or run the eight sends from a host that already has `MICROSOFT_*` plaintext) without going through release execute.

Until one of those lands, remaining three cards must not be attempted.

---

## Evidence artefacts on this branch

- This report: `data/mailer-ops-visibility-send-v1/report.md`
- Local (ephemeral) Maylands PDF download under `/tmp/fm-mailer-ops-visibility-send-v1/` for size/magic checks only — not committed.

**Emails sent:** 0 / 8  
**Sent Items proofs:** none  
**Next:** resume only after transport decision; restart at card one report + photo sends, then stop again for proof before card two.
