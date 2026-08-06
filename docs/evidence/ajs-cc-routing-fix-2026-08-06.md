# AJS permanent pack CCs + live domain audit (2026-08-06)

Captain E: permanent CC `vanessa@ajs.build` and `mandi@ajs.build` on all future
AJS/AJBR pack emails (with `workorders@`). Typos of interest: `ajsbuild` /
`ajsbuid` → `ajs.build`.

## Part 1 — live values (read-only Management API, before any write)

**Misspelled domains (`ajsbuild` / `ajsbuid`): NOT present in live routing stores.**

| Store | Live AJS-related addresses | Typos |
| --- | --- | --- |
| `makesafe_companies` (slug=`aj`) | `invoice_email=vanessa@ajs.build`, `report_recipient=workorders@ajs.build`, `sender_patterns=["ajs.build"]`, `special_instructions="CC vanessa@ajs.build on all correspondence"` | none |
| `makesafe_job_details.special_instructions` | 121 rows: `CC vanessa@ajs.build on all correspondence` | none |
| `makesafe_release_revision_routes` (recipients ILIKE `%ajs%`) | TO: only `workorders@ajs.build` (n=13); CC: `ses@secureworkswa.com.au` (n=10), `finance@secureworkswa.com.au` (n=1) | none |
| `makesafe_docket_revisions.email_drafts` AJS addresses | only `workorders@ajs.build` | none |
| `emails.from_email` AJS domain | `workorders@`, `vanessa@`, `makesafevic@`, `mandi@`, `franc@`, `adham@`, `joe@` — all `@ajs.build` | none |
| Targeted ILIKE `%ajsbuild%` / `%ajsbuid%` across companies, routes, emails, dockets, outbound_log, intake drafts, job special_instructions | **0 hits** | — |

### What that means for past AJS sends

- Pack **To** used `workorders@ajs.build` (correct domain) — not a silent black-hole TO.
- Pack **CC** on sealed routes was `ses@` only (and one residual `finance@`). Vanessa/mandi were **not** on sealed pack CCs historically, even though company `special_instructions` asked to CC Vanessa — the exact-recipient gate previously **rejected** Vanessa on CC.
- Therefore: past AJS packs were **not** lost to misspelled domains in live config. The defect the Captain named is **not** currently live. The change adds permanent builder CCs going forward; it does not rewrite history.

**Caveat:** tests mock the mail gateway. Green tests prove addresses are **wired**, not that Graph/Exchange delivered. A misspelled domain would also pass every in-repo test.

## Part 2 — change (authoritative store)

| Role | Location |
| --- | --- |
| **Authoritative producer** | `ajsPackCc()` in `ses_release_route_shape.ts` |
| Constants (hard-coded `ajs.build`) | `AJS_VANESSA_CC`, `AJS_MANDI_CC`, `AJS_WORK_ORDERS_MAILBOX`, `SES_RELEASE_CC` in `ses_graph_mail_gateway.ts` |
| Legacy pack + exact gate | `requiredPackCcForReportRecipient` / `checkExactRecipientGate` in `makesafe_send_pack.ts`; `makesafeSendPack` + photo follow-up + draft feed in `index.ts` |
| Execute envelope | AJS branch in `ses_reporting_actions.ts` requires every `ajsPackCc()` address |
| Docs in this repo | `AGENTS.md` (AJS pack CC paragraph) |
| Skill (wiki, outside this worktree) | `secureworks-makesafe-reporting` refs (`email-routing-and-approval.md`, `path-board.md`, `close-out-contract.md`) — **must be updated in wiki separately**; code is what sends |

MLB routing and mailer-ops (`ses@` only CC to Primeeco mailer) are untouched.

No migration required: pack CCs are code constants, not DB rows.

## New permanent AJS pack envelope

- **TO:** `workorders@ajs.build` (+ thread participants on sealed release)
- **CC:** `ses@secureworkswa.com.au`, `vanessa@ajs.build`, `mandi@ajs.build`
