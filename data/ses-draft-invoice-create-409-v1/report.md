# SES draft-invoice create 409 — classification report

**Date:** 2026-08-04  
**Branch (evidence commit, no code change):** `fm/ses-draft-invoice-create-409-v1`  
**Classification:** **(C) Genuine gap** — stop; do not touch the fence  
**Captain rule:** `data/captain-rule-draft-invoice.md` (2026-08-04)  
**Production reads:** Management API `read_only:true` + ops-api probes that refuse before money write  
**Credentials receipt:** `SUPABASE_ACCESS_TOKEN` set; `SW_API_KEY` set; secrets not printed  
**PII rule:** job number / builder reference only

---

## Classification (unchanged)

### **(C) Genuine gap**

There is **no agent-usable path that creates a Xero `DRAFT` on a sealed make-safe card before human `APPROVE INVOICE`.**

| Hypothesis | Verdict |
| --- | --- |
| **(A)** Wrong caller; `prepare_ses_invoice_obligation` already creates the draft | **False.** Prepare is live but local-only (`xero: null`, `external_mutations.xero: 0`). |
| **(B)** Approved prepare path broken / unreachable | **False.** Prepare returns 200 `prepared` on live cards; execute’s draft path exists but is approval-gated. |
| **(C)** No agent-usable pre-approval Xero draft-create; fence blocks create, not only approve/send | **True.** |

Do **not** punch the fence, widen the read exemption, re-enable retired free-draft actions, or make execute skip approval without a Captain ruling.

---

## Probe table (live, sealed SWMS-261116)

| Action | HTTP | Result |
| --- | --- | --- |
| `create_invoice` | **409** | `sealed_ses_release_required`, `matched_by: job_seal` |
| `prepare_ses_invoice_obligation` | **200** | `state: prepared`, `revision_state: proposed`, `proposal.xero: null`, `external_mutations: { xero: 0, email: 0 }`, priced lines present |
| `execute_ses_invoice_revision` (no prior approval) | **409** | `invoice_approval_missing` — “Open the current cockpit and press APPROVE INVOICE for this exact revision.” |

---

## Exact file:line — fence and approval gate

### Fence (legacy create refused)

| Location | What |
| --- | --- |
| `supabase/functions/_shared/sealed_ses_money_fence.ts:19` | Refusal code `sealed_ses_release_required` |
| `supabase/functions/_shared/sealed_ses_money_fence.ts:44–66` | Sealed classification (`ses_money_sealed_at` / `type=makesafe` / `SWMS-` / detail row) |
| `supabase/functions/_shared/sealed_ses_money_fence.ts:132–137` | Read exemption closed to `get_invoice_pdf` only |
| `supabase/functions/_shared/sealed_ses_money_fence.ts:217–229` | `sealedSesMoneyRefusal()` — recovery names prepare → approve → execute → release |
| `supabase/functions/ops-api/index.ts:26661` | **Gate:** `if (!inspection.sealed \|\| internalSes) return inspection` — sealed jobs refuse unless **internal SES** context |
| `supabase/functions/ops-api/index.ts:5695` | Public `create_invoice` → `createInvoice(client, body)` with **no** `internal.ses` |
| `supabase/functions/ops-api/index.ts:27104+` | `createInvoice` calls the job fence with `!!sesContext` |
| `supabase/functions/ops-api/index.ts:6434–6445` | Retired free paths `create_makesafe_draft_invoice` / draft pack → **410** `legacy_free_invoice_path_retired` |

### Only internal SES context may create on sealed jobs

| Location | What |
| --- | --- |
| `supabase/functions/ops-api/index.ts:1246–1260` | `makeSesXeroGateway.createDraft` → `createInvoice(..., { ses: { obligationRevisionId, externalToken, operationKey } })` |
| `supabase/functions/ops-api/index.ts:27297–27299` | SES ref stamp: `` `${reference} \| ${sesContext.externalToken}` `` |
| `supabase/functions/ops-api/index.ts:27360–27361` | Idempotency: `ses-invoice-create-${obligationRevisionId}` |
| `supabase/functions/ops-api/index.ts:27424–27425` | Mirror stamps `invoice_obligation_revision_id` + `ses_external_token` |
| `supabase/functions/ops-api/index.ts:27442–27443` | `job_events.invoice_created` gets `ses_operation_key` only when `sesContext` set |

### Prepare = local proposal only (agent OK)

| Location | What |
| --- | --- |
| `supabase/functions/ops-api/ses_reporting_actions.ts:689` | `prepareSesInvoiceObligationAction` |
| `supabase/functions/ops-api/ses_reporting_actions.ts:870` | `external_mutations: { xero: 0, email: 0 }` |
| `supabase/functions/ops-api/makesafe_invoice_obligation.ts:59,264` | Proposal type / body pin `xero: null` |

### Approval gate before Xero draft (the create gate)

| Location | What |
| --- | --- |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1438` | `approveSesInvoiceRevisionAction` — JWT operator only |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1548–1565` | `currentInvoiceApproval` — missing row → **`invoice_approval_missing`** (line **1560–1561**) |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1599` | `executeSesInvoiceRevisionAction` |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1683` | RPC `begin_ses_invoice_execution_v1` re-checks approval hash |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1732` | `gateway.createDraft` (only Xero create after approval) |
| `supabase/functions/ops-api/ses_reporting_actions.ts:1797` | Returns `state: "xero_draft_created"` when `includes_authorise` is false |
| Migration `20260728020000_makesafe_ses_invoice_release_u5_u6.sql:1062–1155` | `begin_ses_invoice_execution_v1` refuses without matching approval |

### Docs Ready requires a real Xero DRAFT

| Location | What |
| --- | --- |
| `supabase/functions/ops-api/makesafe_docs_ready_invoice.ts:67–91` | Qualifier: linked job, ACCREC, **`status === "DRAFT"`** (line **79**), cycle + reference |
| `supabase/functions/ops-api/makesafe_computed_status.ts:361–365` | `docsReady` fails unless `invoiceQualifiesAsCurrentDraft === true` |

---

## Production read — obligations and board drafts

### Current invoice obligations (all of them)

| Fact | Count |
| --- | --- |
| Obligation revision rows by state | **11 × `proposed`**, 1 × `superseded` |
| Current obligations | **11 × `proposed`** |
| Current with `xero_binding` | **0** |
| Current without `xero_binding` | **11** |
| Ever `create_executed` / `create_approved` / `authorised` / `released` | **0** |
| `makesafe_revision_approvals` rows with `action = 'invoice'` | **0** |

Sample proposed job numbers: SWMS-261109, SWMS-261114, SWMS-261079, SWMS-261115, SWMS-261080, SWMS-261116.

### Board population used for the 19-draft count

Same active SES-ish board predicate as the first pass (non-cancelled/lost; `makesafe`/`restoration` or has `makesafe_job_details`):

| Fact | Count |
| --- | --- |
| Board cards | 414 |
| Sealed among those | 414 |
| With linked ACCREC `DRAFT` | **19** |
| With current obligation | 11 |

---

## Code order vs Captain rule

### Code order today (U4 / U5 / U6R)

1. U4 docket (local pack facts)  
2. **`prepare_ses_invoice_obligation`** — agent may; **no Xero**  
3. Captain **`APPROVE INVOICE`** (`approve_ses_invoice_revision`)  
4. **`execute_ses_invoice_revision`** — creates **Xero DRAFT** (authorise only if approval says so)  
5. Later release approve + execute — send routes only  

### Captain rule 2026-08-04

1. Reporting path **creates the Xero DRAFT** before Docs Ready  
2. Card in Docs Ready with pack **and draft visible**  
3. Captain click **is** approve  
4. Later run sends  

### Conflict

| Step | Captain | Code |
| --- | --- | --- |
| Xero DRAFT timing | Before Docs Ready / before approve | Only after APPROVE + execute |
| What agent may mint pre-review | Visible draft invoice | Local proposal only |
| Docs Ready invoice fact | Draft already there | Requires linked Xero `DRAFT` |
| Captain click | Approves existing draft | Grants permission to **create** the draft |

---

## THE DECIDING QUESTION — those 19 historical DRAFT ACCRECs

### Answer (short)

**All 19 were created by the pre-U5 free ops-api create path** — `createInvoice` **without** internal SES context (the legacy make-safe draft / public create family).  

**None** required, and **none** had, a human `APPROVE INVOICE`.  

**None** were created by today’s approved SES path (`execute_ses_invoice_revision`).  

**That free path is retired and fenced.** It is **not** a live agent option. The 19 drafts do **not** prove a current pre-approval create route still exists.

### Evidence matrix (all 19)

| Provenance signal | Result for all 19 |
| --- | --- |
| `xero_invoices.invoice_obligation_revision_id` | **null** (0/19) |
| `xero_invoices.ses_external_token` | **null** (0/19) |
| Reference contains SES `` \| <token> `` stamp | **false** (0/19) |
| `job_events.invoice_created.detail.ses_operation_key` | **absent** (0/19) |
| `makesafe_revision_approvals` (`action=invoice`) on job | **0 rows** (0/19) |
| `makesafe_invoice_obligation_revisions` on job | **0 rows** (0/19) |
| `ses_external_effects` on job | **0 rows** (0/19) |
| `makesafe_report_packs` row on job | **none** (0/19) |
| `job_documents` type `invoice` | **0** (0/19) |
| `job_events.invoice_created` present for the draft | **yes** (19/19) — proves ops-api `createInvoice`, not pure Xero-UI + silent sync |
| Event detail `status` | `DRAFT` |
| Event detail `emailed` | `false` |

Global check (not just the 19): **every** ACCREC DRAFT in the DB (28 rows) has **zero** obligation binding and **zero** SES token. There has **never** been a production invoice-approval row.

### How we identify the code path

U5 execute stamps **four** durable marks that free create never sets:

1. `invoice_obligation_revision_id`  
2. `ses_external_token`  
3. Reference `` `${ref} | ${externalToken}` `` (`index.ts:27297–27299`)  
4. `job_events` `ses_operation_key` (`index.ts:27443`)  

Plus an `ses_external_effects` claim for `invoice_create`.

**All four marks are absent on all 19.** Therefore not U5.

What remains is `createInvoice` **without** `internal.ses`:

- Public route `create_invoice` (`index.ts:5695`)  
- Server helper `createMakesafeDraftInvoice` (`index.ts:34024+` → `createInvoice` with `xero_status: DRAFT`, `send_email: false`, `makesafe_idempotency_key` only — **no** SES context)  
- Formerly wired through `create_makesafe_draft_invoice` / `draft_makesafe_report_pack` (now **410** retired at `index.ts:6434–6445`)

### Sub-path discrimination among free creates

| Sub-path | Expected extra marks | On the 19 |
| --- | --- | --- |
| Full `draft_makesafe_report_pack` success | `makesafe_report_packs.xero_invoice_id` + often invoice PDF doc | **None** — no pack rows, no invoice docs |
| `create_makesafe_draft_invoice` / bare `createMakesafeDraftInvoice` | `invoice_created` only; no pack required | **Consistent** with all 19 |
| Public skill `create_invoice` DRAFT | Same event shape as free create | Also consistent with event shape |
| U5 execute after APPROVE | obligation + token + pipe ref + effect + approval | **Ruled out** |
| Manual Xero create only | Usually no same-second `invoice_created` from ops-api | **Ruled out** (events present) |

Batch timing supports automation, not hand-entry:

- 2026-06-29 ~22:13 — four drafts within ~14s  
- 2026-07-02 ~09:58 — five drafts within ~13s  
- 2026-07-02 ~10:28–10:29 — three drafts  
- 2026-07-06 ~04:59 — three drafts  

References are make-safe style builder refs (`MLB-…`, sometimes ` - Make-Safe` / ` - Assessment report` / ` - Roof report`), not SES token-stamped refs.

### Timeline: free path then, not now

| Draft create window (local mirror) | 2026-06-29 → 2026-07-21 |
| --- | --- |
| U5/U6 migration in repo | `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` (**2026-07-28**) |
| Fence hardening migration | `20260728050000_makesafe_ses_fence_hardening.sql` |
| Free draft actions today | **410 retired** |
| Public `create_invoice` on sealed today | **409 sealed** |

So the 19 are **historical residue of the free draft era**, left as live Xero DRAFTs. They do **not** show that a current pre-approval create route remains open.

### Material effect on options

| If the 19 had been U5 pre-approval drafts… | Reality |
| --- | --- |
| Would mean some approved path already creates Xero DRAFT without APPROVE | **False** — U5 has never created a production draft (0 approvals, 0 bound drafts) |
| Would open “just use that path” | No such path exists |
| Free path created drafts without APPROVE | **True historically**, **false today** (retired + fenced) |

**Decision impact:** adopting Captain create-before-approve requires a **new deliberate** SES draft-create (or a ruled re-open of free create under new controls). It is **not** “turn back on something still quietly working.” The only live agent money-adjacent step is still **prepare (local)**.

---

## What still refuses (and why correct under current design)

| Call | Refusal | Correct under U5? |
| --- | --- | --- |
| Public `create_invoice` on sealed | `409 sealed_ses_release_required` | **Yes** — bypasses obligation/approval/token ledger |
| Retired free draft / pack create | `410 legacy_free_invoice_path_retired` | **Yes** — free Xero draft without U6 approval |
| `execute_ses_invoice_revision` without APPROVE | `409 invoice_approval_missing` | **Yes under U5**; **conflicts with Captain create-before-approve** |
| Routine approve / execute / release | default-deny / 403 | **Yes** — agents must not approve or send |
| Read exemption for non-`get_invoice_pdf` | still sealed | **Yes** — 2026-08-02 read ruling |

---

## What was not touched

- Money fence, allow-lists, read exemption — **untouched**  
- No re-enable of free draft paths  
- No execute-without-approval change  
- No Xero writes, approvals, sends, production mutations  
- No PR, no merge, no deploy  
- Door 1 region of `ops-api/index.ts` (curated bind / `job_media`) — **not edited**

---

## Decision still required (Captain / Firstmate)

1. **Keep U5 order** (approve → create draft → later release) and rewrite Docs Ready / Captain wording around **local proposals**.  
2. **Adopt create-before-approve** with a **new** captain-approved SES draft-create that still refuses authorise/send/legacy create.  
3. **Redefine “draft”** as the local proposal and change the Docs Ready invoice prerequisite accordingly.

Until then: agents call **`prepare_ses_invoice_obligation`** after a U4 pre-Xero docket; treat success as **proposal ready**, not Docs Ready with a Xero draft; never approve, execute, authorise, or send.

---

## CAPTAIN DECISION (resolved product) — Option B create-before-approve

**Received:** 2026-08-04 via Firstmate / Rayleigh.  
**Binding rule:** `data/captain-rule-draft-invoice-b-2026-08-04.md` (supersedes earlier draft-invoice rule).  
**Prior classification (C)** stands as engineering fact; product now **authorises a deliberate money-control change for DRAFT mint only**.

Phase 1 below is **design only**. No implementation in this pass.

---

## PHASE 1 DESIGN — Option B (create before approve)

### Verified facts (not re-derived)

| Fact | Location | Implication |
| --- | --- | --- |
| Internal gateway already mints DRAFT, `send_email: false`, full SES stamps | `ops-api/index.ts:1244–1262` `makeSesXeroGateway.createDraft` | **Reuse this.** Do not invent a second Xero create path. |
| Fence already admits internal SES context | `ops-api/index.ts:26661` `if (!inspection.sealed \|\| internalSes) return inspection` | **Do not weaken the fence.** If a patch seems to require it → stop and escalate. |
| Free / retired create stays shut | `ops-api/index.ts:6434–6445` `legacy_free_invoice_path_retired` | Do not reopen. |
| Public `create_invoice` stays sealed | fence + no `internal.ses` on public route | Unchanged. |
| Docs Ready already wants linked ACCREC DRAFT | `makesafe_docs_ready_invoice.ts:79`, `makesafe_computed_status.ts:361–365` | Once mint works, readiness rule need not relax. |

### The three `invoice_approval_missing` sites — which guard what

| Site | Function | Guards | Under Option B |
| --- | --- | --- | --- |
| `ses_reporting_actions.ts:1474` | `approveSesInvoiceRevisionAction` | Cockpit hold / approve control disabled when obligation not executable | **Not the create gate.** Keep as approve-side hygiene. Cockpit *enablement* of APPROVE changes (see below). |
| `ses_reporting_actions.ts:1560` | `currentInvoiceApproval` → used by `executeSesInvoiceRevisionAction` **before** Xero create | **This is the create blocker.** | **Remove from the draft-mint path only.** Keep (or re-target) for authorise execution. |
| `ses_reporting_actions.ts:2095` | release / SEND IT approval | Requires prior invoice approval with `includes_authorise: true` before send | **Keep.** Authorise/send stay human-gated. |

Additional create-path blockers that must be separated (same theme):

| Site | What it does | Option B |
| --- | --- | --- |
| `executeSesInvoiceRevisionAction` ≈1610–1616 | Refuses `auth.mode === "routine"` entirely | Draft **mint** must not live behind this “approved execute” wall. Authorise execute may stay non-routine. |
| `begin_ses_invoice_execution_v1` (migration U5/U6) | Requires matching approval hash before flipping to `create_approved` | **Do not call for draft mint.** Authorise path may keep an approval-bound begin, or a dedicated authorise begin later. |
| Cockpit `approve_invoice` enablement `ses_review_cockpit.ts:360–367` | Enabled when obligation exists and **`!docket.xero_binding`** (i.e. create-permission UI) | **Must flip:** enable when a **linked DRAFT** binding exists (approve existing draft), not when binding is absent. |

---

### 0. BLOCKING — duplicate-invoice guard (mandatory before any mint)

**This is a hard ops requirement (Captain rule B / Maverick). Implementation must not start without it. Unattended mint without this guard can double-invoice a real client — the single worst failure mode of Option B.**

#### Semantic source of truth (do not reimplement)

| Authority | Path | Role |
| --- | --- | --- |
| **Python module (canonical semantics)** | `projects/secureworks-wiki/harness/ops/skills/secureworks-makesafe-reporting/scripts/invoice_utils.py` | `fetch_all_invoices`, `resolve_existing_invoice`, `split_ref_po`, `_same_work_ref`, `VOID_STATUSES` — **one module** so skill create and close-out backfill cannot drift. Header contract also restated in sibling `create_makesafe_draft_invoice.py` lines **9–20**. |
| **TS port already in ops-api (must reuse, not fork)** | `supabase/functions/ops-api/makesafe_send_pack.ts`: `resolveExistingInvoice`, `sameWorkRef`, `splitRefPo`, `normRef`, `isVoidStatus` | Existing port of `invoice_utils.py`. Edge mint **imports this**; it does **not** invent a third private resolver in `ses_reporting_actions.ts`. |
| **Full ACCREC fetch (TS)** | `ops-api/index.ts` `_fetchAllAccrecInvoices` (≈33654–33671) | Paginated live mirror scan (page 500 until short page) — port of `fetch_all_invoices`. **Not** a ~50-row recent window. |

Skill/Python continues to call **`invoice_utils.py`**. Server mint continues the same algorithm via the **existing TS port** of that module. **Reimplementing the 3-tier / PO logic a third time is forbidden.**

#### Exact semantics (preserve, do not approximate)

1. **Before creating ANY draft**, fetch the **FULL** live ACCREC set, **paginated to completion**.  
   - The old ~50-row exact-reference window was the **broken** guard and must **not** return.  
   - **Live lookup every attempt** — never a cached / same-day snapshot as authority (`--invoice-cache` is refused in Python for this reason).
2. Run the **3-tier resolver**, ignoring `VOID_STATUSES` (`VOIDED` / `DELETED` never block create):  
   1. `invoice.job_id == job.id`  
   2. exact normalised `reference == external_ref`  
   3. `external_ref` as **substring** of invoice reference (norm length ≥ 5)
3. **PO-scoping (load-bearing):**  
   - **job_id tier ALWAYS blocks** — second invoice on the same card is a true re-invoice, any PO.  
   - **Reference tiers are PO-scoped:** same builder base + **different** PO (e.g. `MLB-24732` vs `MLB-24732PO-55712`) is **different work** and must **NOT** block; identical full refs and no-PO refs keep the **strict** block.  
   - Wrong direction either **double-invoices** or **silently refuses** legitimate sibling work.
4. On a live hit: **no new invoice** — refuse naming **existing invoice number, status, and match_method**.  
5. Guard is **mandatory and unskippable** (no flag, no body bypass).

#### WHERE the check lives inside `create_ses_invoice_draft`

```
create_ses_invoice_draft handler
  1. load prepared obligation + job_id + external_ref (proposal reference)
  2. *** MANDATORY DUP GUARD (unskippable) ***
       rows = _fetchAllAccrecInvoices(client)          // full paginated live ACCREC
       hit  = resolveExistingInvoice(rows, job_id, external_ref)  // invoice_utils parity
       if hit:
         // if hit is already THIS obligation's SES-bound DRAFT → idempotent return existing (no twin)
         // else → 409/skip naming invoice_number + status + match_method; createDraft NEVER called
  3. only if no blocking hit: buildSesEffect + makeSesXeroGateway.createDraft + mirror bind
```

- **Call site:** first money-affecting step of `create_ses_invoice_draft`, **before** `buildSesEffect` / `gateway.createDraft`.  
- **Not sufficient alone:** `makesafe_invoice_duplicate_resolver.ts` / `resolveSesInvoiceDuplicates` — indexed only; **never** scans the whole ACCREC estate. May supplement; **must not replace** this guard.

---

### 1. Which action creates the draft

**Public action name (proposed):** `create_ses_invoice_draft`

**Not** `create_invoice`, **not** retired `create_makesafe_draft_invoice` / draft pack, **not** “prepare alone” (prepare stays local-only).

**Sequence:**

1. U4 docket with pre-Xero local invoice proposal (existing).  
2. `prepare_ses_invoice_obligation` — commits local obligation revision (`xero: null`). Unchanged; agent/routine/api_key.  
3. **`create_ses_invoice_draft`** — **new** action; skill / MCP / **api_key** (and, if the skill uses the same standing key as prepare, **routine** allow-list for mint only — **never** approve/authorise/send).  
4. **Inside that action, in order:**
   1. Load prepared obligation / `job_id` / `external_ref`.  
   2. **Mandatory full live-ACCREC duplicate guard** (§0) — refuse or idempotent-return **before** any mint.  
   3. Only if clear: `buildSesEffect` + `executeSesExternalEffect` for idempotent `invoice_create`.  
   4. **`makeSesXeroGateway(client).createDraft`** only (`index.ts:1244–1262`).  
   5. `persistSesInvoiceMirror` + obligation `state → create_executed` + `xero_binding`.  
5. Hard invariants on this action:
   - **Dup guard always runs first** (see §0) — unskippable.  
   - **No** call to `currentInvoiceApproval` (L1560 path).  
   - **No** call to `begin_ses_invoice_execution_v1` (approval-bound).  
   - **No** call to `gateway.authorise`.  
   - **No** email / release / void.  
   - Returns only when mirror shows `status: DRAFT` with `invoice_obligation_revision_id` + `ses_external_token` set **or** structured skip naming an existing live invoice.  
   - Replay-safe: second call does not mint a twin (dup guard + SES token reconcile).

**Where the approval precondition is removed:** only on this draft-mint path — specifically the pair  
`currentInvoiceApproval` (≈1560) + `begin_ses_invoice_execution_v1` approval requirement — **for create**.  
They remain required for the post-draft money steps below.  
**The dup guard is not an approval gate** — it is a separate money-safety gate and stays on create forever.

**Fence:** no change. Gateway already passes `internal.ses`, so L26661 admits the write.

**Why not fold mint into `execute_ses_invoice_revision`?**  
Today that action means “run the approved money plan” (create and optionally authorise under one approval). Collapsing “mint without click” into it blurs authorities and keeps the routine ban on “execute approved invoice.” A dedicated create action keeps approve/authorise semantics clean.

**Why not fold mint into `prepare_ses_invoice_obligation`?**  
Prepare is explicitly zero external mutations (`external_mutations.xero: 0`). Keeping prepare local preserves that contract and lets mint fail/retry independently of proposal commit.

---

### 2. Which action cockpit APPROVE INVOICE maps to

**Still:** `approve_ses_invoice_revision` (JWT human only — api_key/routine must remain unable to record the approval as a Captain substitute; today it requires `auth.mode === "jwt"` + identified user).

**Semantic change (product + cockpit, not a new action name):**

| Before (U5) | After (Option B) |
| --- | --- |
| APPROVE INVOICE = permission to **mint** the draft (and optionally authorise) | APPROVE INVOICE = approval of an **existing** Xero DRAFT — “make it real” |
| Cockpit enables when obligation present and **no** `xero_binding` | Enable when obligation present and `xero_binding.status === "DRAFT"` (and clean/non-stale rules still hold) |
| Control plan text: “Create one Xero DRAFT…” (`ses_review_cockpit.ts:412–413`) | Plan text: approve existing draft for authorise / later release — **no create** |

**After approve:**

- `includes_authorise: false` — approval recorded; draft remains DRAFT; no authorise (Captain may only be signing off commercial lines for Docs Ready visibility, if product keeps that band).  
- `includes_authorise: true` — unlocks **authorise** via existing `execute_ses_invoice_revision` (approval-gated; create half becomes no-op / reconcile-only when binding already exists).  
- **SEND IT** stays `approve_ses_release_revision` + `execute_ses_release_revision`, still requiring invoice approval with authorise where L2095 applies.

So the click maps to **`approve_ses_invoice_revision`**, not to create, and the next money effect on that approval is **authorise (and later release)**, never mint.

---

### 3. Acceptance test (design contract)

Prove four things: **mint without human click**, **ledger identity**, **authorise/send still blocked**, **dup guard blocks twin mint / allows PO-sibling**.

**A. Positive — skill mints DRAFT with no human click**

1. Fixture: sealed SES job, U4 pre-Xero docket, priced `prepare_ses_invoice_obligation` → state `proposed`, no approval rows, no `xero_binding`.  
2. Call `create_ses_invoice_draft` with **api_key** (or standing skill key) only — **no** JWT Captain session, **no** prior `approve_ses_invoice_revision`.  
3. Assert:
   - HTTP success, `state: xero_draft_created` (or equivalent).  
   - `xero_invoices` row: `status = DRAFT`, `invoice_type = ACCREC`, `job_id` linked.  
   - `invoice_obligation_revision_id` set to the prepared revision.  
   - `ses_external_token` set; reference carries SES token stamp (`ref | token`).  
   - Obligation revision `state = create_executed` with matching `xero_binding`.  
   - `ses_external_effects` has confirmed `invoice_create` for that obligation.  
   - **Zero** rows in `makesafe_revision_approvals` for `action = invoice` on that revision.  
   - Gateway path used: createDraft / internal ses context only (no authorise effect).  
   - Dup guard ran first (fetch + `resolveExistingInvoice`); `createDraft` only after clear.  
4. Replay same call → idempotent (same `xero_invoice_id`, no second live DRAFT).

**B. Negative — authorise still blocked without Captain**

1. After A, call `execute_ses_invoice_revision` without approval → still **`invoice_approval_missing`** (L1560 family) or equivalent authorise gate.  
2. Call gateway authorise / legacy `approve_invoice` / `approve_and_send_invoice` on the sealed job → still refused.  
3. Invoice status remains **DRAFT**, never AUTHORISED.

**C. Negative — send / release still blocked**

1. `approve_ses_release_revision` / `execute_ses_release_revision` without prior Captain invoice approval (`includes_authorise`) → still refused (L2095 family).  
2. No Graph/email side effects; `send_dispatched` stays false.

**D. Negative — free and public create stay shut**

1. Public `create_invoice` on sealed job → **409** `sealed_ses_release_required`.  
2. `create_makesafe_draft_invoice` / `draft_makesafe_report_pack` → **410** `legacy_free_invoice_path_retired`.  
3. Fence allow-list / read exemption membership unchanged (tests that pin `get_invoice_pdf` only still pass).

**E. Docs Ready (optional in unit suite; required in integration)**

1. With pack artifacts + qualifying linked DRAFT from A, `docsReady` / Docs Ready qualifier true **without** changing the DRAFT prerequisite rule.

**F. Negative — duplicate-invoice guard (BLOCKING; without this case the design is incomplete)**

Proves a second mint against an existing **live** ACCREC **refuses without creating a twin**, and that the **PO-sibling case must NOT block**.

1. **Second mint / twin refused (job_id or exact-ref live hit)**  
   - Seed a live ACCREC (DRAFT or AUTHORISED — not VOIDED/DELETED) already linked to the same `job_id`, **or** carrying the exact same builder `external_ref` on another job.  
   - Call `create_ses_invoice_draft` for a prepared obligation on that card (api_key, no human approval).  
   - Assert: **no** new `xero_invoice_id`; `createDraft` **not** dispatched; response is skip/409 naming **existing invoice number + status + match_method** (`job_id` or `reference` / `reference_substring` as applicable).  
   - Assert: full ACCREC fetch was used (not a 50-row window) — e.g. fixture places the blocking invoice outside any “recent 50” window and it still blocks.

2. **VOIDED/DELETED does not block**  
   - Only void/deleted candidates for the same ref/job → mint **may** proceed (guard ignores `VOID_STATUSES`).

3. **PO-sibling must NOT block**  
   - Other job has live ACCREC ref `MLB-24732PO-55712`.  
   - This card mints under `MLB-24732` (or a different PO under the same base, e.g. `MLB-24732PO-99999`).  
   - Assert: guard does **not** block; `createDraft` may run (subject to other gates).  
   - Control: identical full ref `MLB-24732PO-55712` on another job **does** block; no-PO exact match **does** block.

4. **Unskippable**  
   - No request flag or body field disables the guard; attempt to skip is ignored or refused.

---

### Target post-B sequence (skill + Captain)

```
prepare_ses_invoice_obligation     # local proposal; agent OK
create_ses_invoice_draft           # (1) FULL live-ACCREC dup guard — unskippable
                                   # (2) only if clear: Xero DRAFT via makeSesXeroGateway.createDraft
                                   #     agent/api_key OK; NO human click; NO authorise/send
        → Docs Ready can light (pack + linked DRAFT)
approve_ses_invoice_revision       # Captain JWT UI click; approves EXISTING draft
execute_ses_invoice_revision       # authorise only when includes_authorise (approval required)
approve_ses_release_revision       # Captain SEND IT
execute_ses_release_revision       # send routes only
```

---

### Explicit non-goals (Phase 1 + implementation)

- No fence membership or classification change.  
- No reopening retired free create (`6434–6445`).  
- No agent authority to approve, authorise, email, send, or void.  
- No second Xero create implementation beside `makeSesXeroGateway.createDraft`.  
- No Docs Ready rule relaxation if mint works.  
- No Door 1 / curated-bind / `job_media` edits.

---

### HARD REQUIREMENT — full live-ACCREC duplicate-invoice guard

**Canonical write-up is §0 above** (front of the design so it cannot be missed when skimming create/approve/accept). This section is a pointer only.

- Semantic authority: **`invoice_utils.py`** (skill scripts).  
- Server mint reuses the existing TS port: **`resolveExistingInvoice` + `_fetchAllAccrecInvoices`** — **no third reimplementation**.  
- Call site: **`create_ses_invoice_draft` before any `createDraft`**.  
- Acceptance: **case F** in §3.

---

### Implementation risk notes (for Phase 2, not decided here)

1. **Cockpit enablement** (`!xero_binding` → require DRAFT binding) is load-bearing UI; tests in `ses_review_cockpit_test.ts` must flip with it.  
2. **`begin_ses_invoice_execution_v1`** today conflates “approved to create” with execution reserve — draft mint needs a path that does not use that approval predicate (effect claim alone may suffice for create idempotency).  
3. **`execute_ses_invoice_revision`** must become create-reconcile + authorise-if-approved, not “create only after approve.”  
4. **Auth matrix:** mint = api_key (+ routine if skill shares prepare’s standing key); approve/authorise/send = JWT human only.  
5. If any smallest path appears to require fence weakening → **stop and escalate** (Captain rule constraint 2).  
6. **Dup guard (§0 / case F):** mint must call full `_fetchAllAccrecInvoices` + `resolveExistingInvoice` (**`invoice_utils.py` semantics**) **before** createDraft; must not rely on `resolveSesInvoiceDuplicates` alone; must not reimplement a private third resolver.

---

## Status

- Classification history: **(C)** was correct for the pre-decision system.  
- Product decision: **Option B create-before-approve** (Captain rule B, 2026-08-04).  
- Phase 1 design: **complete** — create/approve/accept A–E **plus blocking §0 dup guard + acceptance F**.  
- Phase 2 implementation: **in progress / shipped on branch** — `create_ses_invoice_draft` with full ACCREC dup guard before gateway mint; cockpit APPROVE on DRAFT binding; fence untouched.  
- Tests: `ses_create_invoice_draft_test.ts` (A/B/F), cockpit + wave0 allow-list updates.  
- Report: firstmate `data/ses-draft-invoice-create-409-v1/report.md`  
