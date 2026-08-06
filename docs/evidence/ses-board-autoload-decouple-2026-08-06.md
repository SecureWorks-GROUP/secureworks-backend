# Viewing the make-safe board must never approve anything (2026-08-06)

Captain ruling, top priority: **decouple clean-intake advancement from the board
render.** Approving an intake draft creates a LIVE make-safe job, and `ops.html`
`loadJobs()` awaited `auto_approve_clean_intake_drafts` before every make-safe
kanban paint, tagged `triggered_by: 'ops_board_autoload'`.

This is not an authorisation hole. The dashboard authenticates with the master ops
key, so the privileged gate on the action was satisfied and the call was permitted.
The defect is that **a read performed a privileged write as a side effect**, with no
moment where a human ticked anything.

---

## 1. What the autoload was doing there originally

Introduced in secureworks-ux `a5426d9`, 2026-06-21, "Fix MakeSafe auto-intake sweep
and board scrolling / **Keep clean intake automatic**". It replaced nothing on the
client — it was added as a new mechanism, with a `?noAutoIntake=1` / `?autoIntake=0`
escape hatch for anyone validating the board without promoting rows.

So the intent was genuine: keep clean drafts moving without a human. The question is
whether the board is the only thing doing that. It is not — three non-render owners
already exist in `ops-api`:

| Owner | Clock | Covers |
|---|---|---|
| `scanSesMakesafes` via `makesafe-ses-poll` | cron `1-59/2 * * * *` (verified active) | advances the drafts of its own run (`advanceDrafts` + `approveIntakeDraft`) — i.e. all new mail |
| `scanFreshMakesafeSource` | on PDF-extraction settle | a source whose work-order PDF arrives/extracts late |
| `makesafe_reporting_intake_pass` | every SES reporting skill run (Amendment 46) | the **backlog re-sweep** (limit 100) — a draft that was not clean when created and became clean later |

The third is the same `autoApproveCleanIntakeDrafts` batch the board was calling.
The board trigger was therefore a **redundant third caller of an existing scheduled
path**, not a unique owner. Removing it leaves no draft without an owner.

## 2. What it has approved so far

Read-only, `makesafe_intake_drafts.approved_by`, full history:

```
ops_board_autoload   n=2   first 2026-06-24 02:39:36Z   last 2026-07-07 07:32:55Z
```

**Two drafts, over the 46 days it has been live.** Nothing has been reversed or
altered — that is the Captain's call and out of scope here.

Worth noting alongside: the intake-health "auto-filed" counter never counted
`ops_board_autoload` at all, so these approvals were invisible to the health metric.

## 3. Why it cost 28.6 seconds

The board API answers in 2.85–3.24s (3 curl runs), but click-to-paint was ~32s
because `loadJobs()` **awaited** the sweep before fetching the board. Measured
read-only on 2026-08-06:

- 51 drafts in `needs_review`/`draft`; a dry-run sweep reports **48 eligible**.
- The sweep's read + pure gate costs **0.69–0.71s** (3 dry-run POSTs, no writes).
- Every one of those 51 drafts already has a live card on the same `external_ref`
  (51/51), and 50/51 refs already have an approved draft.

So each render attempted 48 approvals that `approveIntakeDraft`'s duplicate/identity
guards refuse, at roughly 0.58s each — which is the 28.6s. The mechanism was
spending half a minute of the Captain's time, on every board paint, failing to
approve drafts that were already minted.

That also explains the two-approvals-in-46-days figure: the pile is permanently
stuck, so there was almost never anything for it to succeed at.

## 4. Shape chosen: explicit action, with the existing scheduled path left in place

Attribution first, because it governs how far any of this may be changed later. The
Captain ruled the **outcome**: advancement must be an explicit action or a scheduled
path, never a side effect of rendering, and the two historical approvals are not to
be reversed. Everything below — which of the two directions, the trigger allow-list,
preview-on-refusal, refusal by name — is this change's **mechanism**, chosen here and
argued here. Treat the outcome as settled and the mechanism as ordinary code. Do not
let a later reader promote the mechanism to a ruling; the wording in the code and in
`docs/makesafe-intake-terminal-hook.md` deliberately keeps the two apart.

The ruling named two directions. Both, deliberately, because each alone is wrong
here:

- **Explicit action alone** would move the pile if the board were the only thing
  advancing drafts. It is not (§1), so nothing piles up.
- **A new schedule** would be redundant and worse: the natural host,
  `makesafe-ses-poll`, runs every 2 minutes under a 5-second `pg_net` deadline, so
  hanging a 48-attempt batch off it would multiply the failing work 24× per hour and
  push it into the one path that must stay fast.

So: the render trigger is removed, the existing clocks are untouched, and the
deliberate "do it now" path becomes a button on the INTAKE column — where the drafts
it would approve are already on screen, so pressing it is a decision taken in front
of the evidence.

### The durable half lives on the server

`makesafe_intake_advance_trigger.ts` adds an **intent gate**, separate from and
additional to the privileged auth gate, which is unchanged:

- A live sweep must name a trigger on a closed allow-list — `ses-reporting-skill`
  (scheduled) or `ops_intake_review_sweep` (explicit).
- A render-path, unnamed or unrecognised trigger still gets the **full preview**
  (same counts, same eligibility reasons, same clean evidence) and approves nothing.
- `ops_board_autoload` is refused **by name** (`render_path_trigger`) rather than as
  a generic unknown, so a stale client is diagnosable at a glance.

Fail-safe by construction: this batch mints live jobs, so "I could not tell who
asked" resolves to a preview, never to a run. It also means a stale cached
`ops.html` cannot resurrect the defect after the dashboard ships — the refusal lives
where every client meets it.

Deploy order is safe either way. Backend first: a stale board's call becomes a 0.7s
preview, so the board gets fast and stops approving. UX first: the render call is
gone and the button works against the old backend too.

## 5. Click-to-paint, before and after

**After** — patched `ops.html` served locally against production `ops-api`, five
measured tab-switches into the make-safe board (`chrome-devtools-axi`):

| run | click-to-paint | privileged POSTs |
|---|---|---|
| 1 | 2909 ms | 0 |
| 2 | 2763 ms | 0 |
| 3 | 2942 ms | 0 |
| 4 | 2730 ms | 0 |
| 5 | 2953 ms | 0 |

Spread **2.73–2.95s**, median 2.91s. Every request in the trace is a GET
(`makesafe_board`, `list_intake_drafts`, `makesafe_audit`) — the render path issues
no POST at all. Board painted 6 columns / 119 cards.

**Before** — ~32s click-to-paint, autoload 28.6s (field measurement, same day).
**This was deliberately not re-run.** Reproducing it means letting the live autoload
fire against production, which today would attempt 48 live approvals — the exact
boundary this work exists to close. What was re-measured instead, read-only, is its
decomposition, and it reconciles: board API 2.85–3.24s + 48 refused approve attempts
at ~0.58s each.

Click-to-paint therefore goes from **~32s to 2.73–2.95s**, and the board's floor is
now the board API itself.

## 6. Boundaries honoured

- No production writes. Every production call was a GET, a Management API
  `read_only: true` query, or an explicit `dry_run: true` sweep (which skips
  `approveIntakeDraft` entirely). Nothing was approved, minted, voided, sent,
  authorised or re-priced, and the 2 historical `ops_board_autoload` approvals were
  left exactly as found.
- The privileged gate on `auto_approve_clean_intake_drafts`, `approve_intake_draft`
  and `recapture_intake_draft` is byte-unchanged. The intent gate is additive.
- No migration.
- Koondoola SWMS-261025, Clarkson SWMS-26931 and West Perth SWMS-261018 untouched.
- No client names, phone numbers, emails or street addresses in this document, the
  fixtures, or the PRs.

## 7. Tests

- `makesafe_intake_advance_trigger_test.ts` — 8 tests: allow-list membership pin, the
  board autoload refused by name, unnamed/unknown refusals, both sanctioned triggers,
  and a REGRESSION/CONTROL pair driven through the **real** sweep proving a
  render-path trigger reaches `approveIntakeDraft` zero times while an authorised one
  reaches it once.
- `deno check supabase/functions/ops-api/index.ts` clean.
- `deno test supabase/functions/ops-api/` — 3552 passed / 23 failed, against a
  baseline of 3544 passed / 23 failed on the untouched tree: the same 23 pre-existing
  failures, plus the 8 new tests. Two pre-existing `TS2345` type errors in
  `cp1_drag_reschedule_test.ts` (a file this change does not touch) were confirmed
  present at base commit `7ee0597`.
- secureworks-ux: `scripts/test-makesafe-intake-sweep-explicit.js` (10 checks,
  asserted against the shipped `ops.html`; verified to exit non-zero when the render
  call is reintroduced), plus the full node + Playwright suite green
  (138 passed, 2 skipped, 0 failed).
