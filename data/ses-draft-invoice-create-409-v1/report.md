# SES draft-invoice create 409 — classification report

**Date:** 2026-08-04  
**Branch:** `fm/ses-draft-invoice-create-409-v1`  
**Worktree:** disposable treehouse pool path (verified isolated)  
**Captain rule:** `data/captain-rule-draft-invoice.md` (2026-08-04)  
**Production reads:** Management API `read_only:true` + ops-api probes that refuse before any money write  
**Credentials receipt:** `SUPABASE_ACCESS_TOKEN` set; `SW_API_KEY` set; no secrets printed

## Classification

### **(C) Genuine gap**

There is **no agent-usable path that creates a Xero `DRAFT` invoice on a sealed make-safe card before human approval.**

- Legacy `create_invoice` is **correctly** fenced (`409 sealed_ses_release_required`).
- The approved SES prepare action **works**, but it only commits a **local invoice proposal** (`xero: null`, `external_mutations.xero: 0`). It does **not** create a Xero draft.
- The only code path that creates the Xero draft on sealed SES is `execute_ses_invoice_revision` → `gateway.createDraft` → internal `createInvoice(..., { ses: ... })`. That path **requires a prior human `APPROVE INVOICE`** recorded for the exact revision.
- Docs Ready’s board gate requires a **qualifying linked Xero `DRAFT`**, not a local proposal. So the agent cannot put a sealed card into Docs Ready with a draft invoice sitting there for the Captain to look at, without the Captain first approving create.

This is **not** “caller used the wrong action and prepare already creates the draft” (A).  
This is **not** “prepare is broken / unreachable” (B) — prepare is live and succeeding.  
It **is** a deliberate money-control order that **disagrees with the Captain’s 2026-08-04 create-before-approve rule**.

**Do not code around this.** Punching the fence, widening the read exemption, re-enabling retired free-draft actions, or making `execute` skip approval would weaken a sealed money control. Captain decision required.

---

## What the symptom actually is

Reported: `create_invoice` returns `409 sealed_ses_release_required` on sealed SES cards.

### Verified production probe (job number only)

| Action | Job | HTTP | Result |
| --- | --- | --- | --- |
| `create_invoice` | SWMS-261116 | **409** | `sealed_ses_release_required`, `matched_by: job_seal` |
| `prepare_ses_invoice_obligation` | SWMS-261116 | **200** | `state: prepared`, `revision_state: proposed`, `proposal.xero: null`, `external_mutations: { xero: 0, email: 0 }`, priced totals present |
| `execute_ses_invoice_revision` (no prior approval) | SWMS-261116 | **409** | `invoice_approval_missing` — “Open the current cockpit and press APPROVE INVOICE for this exact revision.” |

So the 409 on `create_invoice` is the fence doing its job. Switching the caller to prepare does **not** produce a Xero draft. Switching to execute without the Captain’s click is refused.

---

## Exact file / line evidence

### 1. Fence refuses legacy create (including public `create_invoice`)

`supabase/functions/_shared/sealed_ses_money_fence.ts`

- Classification of sealed jobs: `ses_money_sealed_at` / `type=makesafe` / `SWMS-` job number / `makesafe_job_details` (lines 44–66).
- Refusal code `sealed_ses_release_required` (lines 217–229). Recovery text names **prepare → approve → execute_ses_invoice_revision → release**, not free create.
- Read exemption is closed to `get_invoice_pdf` only (lines 132–137); write verbs cannot be added without failing tests.

`supabase/functions/ops-api/index.ts`

- Job-level gate: `assertLegacySesMoneyActionAllowedForJob` (≈26636).  
  **Line 26661:** `if (!inspection.sealed || internalSes) return inspection` — sealed jobs refuse unless the **internal SES** flag is set.  
  Public `create_invoice` never sets that flag.
- Public route: `case 'create_invoice': return json(await createInvoice(client, body))` (≈5695) — no `internal.ses`.
- Inside `createInvoice` (≈27132–27136): calls the fence with `!!sesContext`; without SES context, sealed → 409.

### 2. Only internal SES context may create on a sealed card

`supabase/functions/ops-api/index.ts` `makeSesXeroGateway` (≈1246–1260):

- `createDraft` is the only production caller that invokes `createInvoice` with  
  `internal: { ses: { obligationRevisionId, externalToken, operationKey } }`.
- That gateway is used by `executeSesInvoiceRevisionAction`, not by public `create_invoice`.

### 3. Prepare is agent-usable and deliberately non-Xero

`supabase/functions/ops-api/ses_reporting_actions.ts` `prepareSesInvoiceObligationAction` (≈689–871):

- Commits local obligation revision via `commit_ses_invoice_obligation_revision_v1`.
- **Line 870:** `external_mutations: { xero: 0, email: 0 }`.

`supabase/functions/ops-api/makesafe_invoice_obligation.ts`:

- Proposal type pins `xero: null` (line 59); prepared proposals always set `xero: null` (line 264).

Routine auth: `prepare_ses_invoice_obligation` is on the routine allow-list  
(`makesafe_wave0_hardening_test.ts` ≈123, 233, 253).  
`approve_ses_invoice_revision` and `execute_ses_invoice_revision` are routine-**denied** (same file ≈169–170, 258–259).

### 4. Xero draft is created only after human APPROVE INVOICE

`supabase/functions/ops-api/ses_reporting_actions.ts`:

- `approveSesInvoiceRevisionAction` (≈1438): JWT operator only; records `APPROVE INVOICE`.
- `executeSesInvoiceRevisionAction` (≈1599):
  - Loads approval via `currentInvoiceApproval` (≈1548–1565); missing approval → `invoice_approval_missing`.
  - RPC `begin_ses_invoice_execution_v1` re-checks that approval hash against current readiness (migration `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` ≈1062–1155).
  - Dispatches `gateway.createDraft` → Xero DRAFT.
  - If `includes_authorise` is false, returns `state: "xero_draft_created"` (≈1795–1801) and does **not** send.

Retired free-draft surfaces (410, not 409):

- `create_makesafe_draft_invoice` / `draft_makesafe_report_pack` / `draft_makesafe_report_pack_due`  
  (`index.ts` ≈6434–6445): `legacy_free_invoice_path_retired` — “can create a Xero DRAFT without the current U6 invoice approval.”

### 5. Docs Ready means a real Xero DRAFT

`supabase/functions/ops-api/makesafe_docs_ready_invoice.ts` `qualifyMakesafeCurrentDraftInvoice` (≈67–91):

- Requires linked `job_id`, `ACCREC`, **`status === "DRAFT"`**, current-cycle boundary, reference match.

`supabase/functions/ops-api/makesafe_computed_status.ts` `docsReady` (≈361–365):

- Fails closed unless `evidence.invoiceQualifiesAsCurrentDraft === true`.

A local `proposed` obligation does **not** satisfy Docs Ready.

---

## Production snapshot (read-only, 2026-08-04)

| Fact | Count |
| --- | --- |
| SES board cards (active population used here) | 414 |
| Sealed among those | 414 |
| Cards with linked ACCREC `DRAFT` | 19 |
| Cards with current invoice obligation | 11 |
| Current obligation states | **11 × `proposed`** |
| Current obligations with `xero_binding` | **0** |

All live prepared invoices are local proposals with **no** Xero binding. The 19 historical drafts are not explained by the current prepare path (they predate or sit outside the U5 execute binding).

Sample proposed job numbers (no client identity): SWMS-261109, SWMS-261114, SWMS-261079, SWMS-261115, SWMS-261080, SWMS-261116.

---

## Exact working sequences (as the code is today)

### Sequence the system actually implements (U4 / U5 / U6R)

1. **U4 docket** — local pack/proposal facts (`prepare_ses_docket_revision` / sealed assembler path).
2. **`prepare_ses_invoice_obligation`** — agent/routine **may** call. Commits local obligation revision. **No Xero. No email.**
3. **Captain `APPROVE INVOICE`** — `approve_ses_invoice_revision` (JWT admin/owner/captain path only). Agent must **never** do this.
4. **`execute_ses_invoice_revision`** — after that approval, creates the **Xero DRAFT** (optional authorise only if approval `includes_authorise`). Still does not send builder mail.
5. **Later release** — separate `approve_ses_release_revision` / `execute_ses_release_revision` for routes. Agent must not send without that authority.

This is the sequence named by the fence recovery text and by the retired free-path recovery (`index.ts` ≈6443).

### Sequence the Captain’s 2026-08-04 rule requires

1. Reporting path **creates the Xero DRAFT** before Docs Ready.
2. Card lands in **Docs Ready** with pack **and draft invoice visible**.
3. Captain review click **is** the approve step.
4. A later run sends the approved invoice.

### Where they disagree

| Step | Captain rule | Code today |
| --- | --- | --- |
| Create Xero DRAFT | Agent, before Docs Ready | Only after Captain APPROVE + execute |
| What agent may mint pre-review | Visible draft invoice | Local proposal only (`xero: null`) |
| Docs Ready entry | Pack + draft already there | Requires qualifying Xero DRAFT fact |
| Captain click | Approves an existing draft | Approves *permission to create* the draft |

---

## What still refuses, and why that refusal is correct

| Call | Refusal | Correct? | Why |
| --- | --- | --- | --- |
| Public `create_invoice` on sealed SES | `409 sealed_ses_release_required` | **Yes** | Bypasses obligation identity, duplicate probe, approval hash, SES external token, and release ledger. |
| Retired `create_makesafe_draft_invoice` / draft pack | `410 legacy_free_invoice_path_retired` | **Yes** | Free Xero draft without U6 approval was deliberately retired. |
| `execute_ses_invoice_revision` without APPROVE INVOICE | `409 invoice_approval_missing` | **Yes under current U5 design** | Prevents unattended money creation. **Conflicts with Captain create-before-approve rule.** |
| `approve_ses_invoice_revision` / execute / release as routine | 403 / default-deny | **Yes** | Agents must not approve or send. |
| Read exemption for anything but `get_invoice_pdf` | still sealed | **Yes** | Captain 2026-08-02 read ruling; tests pin membership and forbid write verbs. |

---

## Hypothesis A / B rejected

### Not (A)

Prepare is not “the draft an agent is allowed to create” in the Docs Ready sense. It is a **pre-Xero obligation proposal**. Production and code both show `xero: 0` / `xero: null`. Fixing callers to use prepare alone does **not** land a draft invoice for the Captain to review in Docs Ready.

### Not (B)

Prepare is reachable (api_key / routine), returns `prepared` with executable pricing on live proposed cards, and commits current revisions. Execute’s legitimate approved-draft path is covered by tests (`sealed_ses_money_fence_test.ts` “execute_ses_invoice_revision legitimate approved draft path remains operational”). The path is not broken; it is **approval-gated before create**.

---

## What was deliberately not touched

- **No code changes** to the sealed-SES money fence, allow-lists, or read exemption.
- **No** re-enable of `create_makesafe_draft_invoice` / draft pack free create.
- **No** change to make `execute_ses_invoice_revision` runnable without approval.
- **No** Xero writes, approvals, sends, or production mutations.
- **`ops-api/index.ts`:** not edited (Door 1 owns curated bind / `job_media` region; this lane stays out of the shared file).
- No PR opened; no merge; no deploy.

---

## Decision required (for Firstmate / Captain)

The system and the 2026-08-04 Captain rule disagree on **when** a Xero DRAFT may be created relative to human approval.

Options that need a Captain ruling (worker must not pick):

1. **Keep U5 order (approve → create draft → later release).** Then Docs Ready’s “qualifying DRAFT” gate and the Captain’s “draft before Docs Ready” wording need an explicit product rewrite: Docs Ready would show the **local proposal**, or the approve click moves earlier than the Docs Ready column, etc.
2. **Adopt create-before-approve.** Then a new **approved SES draft-create** action (or a controlled widening of prepare/execute) must mint Xero DRAFT **without** recording `APPROVE INVOICE`, while still refusing authorise/send/link/legacy create. That is a captain-level money-control change, not a silent fence tweak.
3. **Clarify “draft” means local proposal only.** Then board Docs Ready must stop requiring `xero_invoices.status = DRAFT` for the invoice prerequisite, or treat the prepared obligation as the visible draft. That is also a product/stage-contract change.

Until one of those is ruled, agents should:

- Call **`prepare_ses_invoice_obligation`** after a U4 pre-Xero docket (not `create_invoice`).
- Treat a successful prepare as **proposal ready**, not Docs Ready with draft.
- **Never** approve, execute, authorise, or send.

---

## Deliverable status

- Classification: **(C)**
- Report: this file
- Code fix: **none** (stop per brief — do not code around a deliberate money control)
- Next: Firstmate / Captain decision on options 1–3 above
