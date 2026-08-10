# The make-safe substatus write gate's fail-open is now audible (2026-08-06)

Spec item 1, `secureworks-wiki`
`coding/work/campaigns/makesafe-system/SPEC.md`; ticket
`coding/work/campaigns/makesafe-system/tickets/rescue-ses-remainder-v1/01-write-gate-explicit-error-handling.md`.
Mission: `missions/rescue-ses-2026-08`.

## The defect

`assertMakesafeSubstatusTransition` wrapped its two pre-reads in `try/catch` and
never inspected `error`. PostgREST **returns** errors rather than throwing, so
the catch was dead code and its `console.warn` never fired. A failed read
instead produced `jobState = ''` (the cancelled/lost guard passes) and
`current = null` (an early return before the transition check). The one
coherence gate in front of every make-safe substatus write opened, and it
opened invisibly.

## What changed, and what deliberately did not

The fail-open **stays open**. The original reason holds: the gate stops
known-incoherent moves and must not add a new outage mode to every evidence
event when a read hiccups. Turning it into a fail-closed is a separate change
with its own outage profile and is not authorised by this spec.

- The decision moved to `supabase/functions/ops-api/makesafe_substatus_gate.ts`.
  `index.ts` keeps only the thin wrapper that throws, because the `serve()`
  error handler matches on `instanceof ApiError`. The module is import-safe for
  tests, so the checks below exercise the real gate rather than a
  reimplemented-pure copy that can drift.
- Both pre-reads destructure `{ data, error }` and branch on `error` explicitly.
- One structured `makesafe_substatus_gate_fail_open` line per gated write that
  stepped aside — never one per failed read, because a marker that fires twice
  for one write cannot be counted. It carries the job id, the attempted
  substatus, the typed write-origin in `source` (`{ class, detail }`), the
  per-read PostgREST `code`/`message`/`details`/`hint`, and a `skipped_checks`
  list naming what the gate could not do.
- The gate returns `outcome: 'checked' | 'fail_open_unreadable'`, so "applied
  the checks to real data" and "stepped aside because it could not read" stop
  looking identical at the call site. Item 2's `writeMakesafeSubstatus` helper
  is where that becomes useful.
- `absent` (clean read, no row) and `unreadable` are now distinct read states.
  The old code conflated them: both produced `current = null`. Only `unreadable`
  is a fail-open.
- The `try/catch` is kept **only** as a genuine last-resort guard under its own
  `makesafe_substatus_gate_read_threw` marker. A throw here is a
  transport/client fault, a different incident, and it must never be counted as
  a PostgREST fail-open. The two markers are mutually exclusive per incident.
- The gate's header comment no longer claims every write passes it. It names
  the two real limits: two paths set `makesafe_job_details.substatus` without
  reaching the assert (the detail-row insert at card creation and the
  historical-backfill repair, which establish a first substatus rather than
  moving one, and `approveIntakeDraft` parking a report-only card in
  `awaiting_portal_completion`), and it fails open. The privileged routes are
  not among them — `makesafe_send_pack` closes through `applyMakesafeCloseOut`
  (`internal:closeout`) and `mark_makesafe_portal_report_done` gates its own
  patch; what those skip is the external evidence guards. The adjacent
  external-guards comment claiming "no external entry point can skip them" is
  corrected the same way. A comment that overstates a guard is how the next
  reader stops checking.

Unchanged on the healthy path: the cancelled/lost 409, its `internal:intake_`
exemption, and the transition table (pinned edge-for-edge by a test).

## Two-tier result

### Tier 1 — ran live tonight

Every acceptance check is either run live below or queued in Tier 2 with its
trigger. Nothing is dropped. One thing is deliberately NOT in this tier: the
new markers' absence from tonight's logs, which is a pre-deploy baseline rather
than a result — see the note under Live check A.

**Live check A: the OLD dead catch never fired in production.**
Production `function_logs`, 24-hour window to 2026-08-06T15:41Z, read-only via
the Management API analytics endpoint:

| | |
|---|---|
| total log lines | 104,577 |
| `[ops-api]` console lines | 21,918 |
| lines mentioning `substatus` | 44 |
| old dead-catch text `substatus transition check skipped` | **0** |
| `makesafe_substatus_gate_fail_open` | 0 — *baseline only, see below* |
| `makesafe_substatus_gate_read_threw` | 0 — *baseline only, see below* |

The matcher is proven discriminating rather than broken: adjacent patterns
return tens of thousands of hits in the same query. So **the zero on the old
dead-catch text is a genuine live proof** — that message belongs to code that
IS deployed and running, and across a full production day it never appeared,
exactly as "PostgREST returns errors, it does not throw" predicts. That is the
defect's premise, confirmed against production rather than argued from the
source.

**The two new-marker zeros in that table prove nothing and are not a passed
check.** They are a **pre-deploy baseline**. This change is not deployed, so
those strings could not appear whatever the new logging does — a zero from code
that is not running is not evidence that the code works. Both the negative
(silent on healthy traffic) and the positive (the marker actually appears when
the gate genuinely fails open) are queued below as FLP-2 and FLP-3. Reading
tonight's zero as a live pass is exactly the silently-skipped check the
Captain's two-tier ruling exists to prevent.

**Live check B, precondition: absent is a real production state.** Read-only
Management API query: of 452 `jobs.type='makesafe'` rows, **451** carry a
`makesafe_job_details` row and exactly **1** does not — `SWMS-26001`
(`status='archived'`). That read returns cleanly with zero rows and no error,
which is precisely the `{ data: null, error: null }` shape the gate must
classify as `absent` and not as a fail-open. The discriminator is therefore
exercised by real production data, not only by a fixture.

**Suite regression.** `makesafe_*_test.ts`, `--no-check`:
baseline at the branch point 2,309 passed / 22 failed; after the change
**2,323 passed / 22 failed** — the same 22, plus the 14 new tests. The 2
`makesafe_lifecycle_test.ts` failures the ticket names are inside that 22 and
are pre-existing. `deno check --config deno.jsonc supabase/functions/ops-api/index.ts`
is clean.

Note on the honest baseline: the ticket cites "280 green with 2 pre-existing
failures". That count is a narrower selection; `makesafe_board_test.ts` +
`makesafe_lifecycle_test.ts` alone runs 31 passed / 2 failed, and those 2 are
the named lifecycle pair. The 2,309/22 figure above is the whole `makesafe_*`
set and is the number this change is measured against.

### Tier 2 — first-live-proof events, with trigger conditions

**FLP-1 — the two injected-fault checks (forced `makesafe_job_details` pre-read
error; forced `jobs` pre-read error).**
*Structurally not live-verifiable, permanently.* A PostgREST read cannot be
forced to fail against production. Both are covered at S1 against the real
`_updateMakesafeSubstatus` with a fake PostgREST client, asserting the write
still lands **and** the marker fires exactly once carrying the job id and the
error code. There is no trigger condition that will ever promote these to live;
they are closed as test-only by the ticket's own live-verification table.

**FLP-2 — the NEGATIVE: healthy production traffic stays silent.**
*Trigger:* the first ops-api deploy carrying this change, plus **20 gated
substatus writes** after it. Re-run the 24-hour log query above and expect
`makesafe_substatus_gate_fail_open` = 0 and `makesafe_substatus_gate_read_threw`
= 0.
*Why a write count and not a wall-clock day:* measured live tonight, this gate
sees very little traffic — `job_events` of type `makesafe_substatus_changed`
number **1 in the last 24 hours, 2 in the last 7 days, 59 in the last 30 days**.
"Zero markers across a board day" would be near-vacuous evidence at that rate.
Twenty writes is roughly ten days of current traffic and is the honest bar.
*Note this is only half the proof.* A marker that is never emitted under any
condition also produces a clean zero here. FLP-3 is the half that tells the two
apart, and until FLP-3 fires, FLP-2 passing means only "not noisy", never
"working".

**FLP-3 — the POSITIVE: the marker actually appears when the gate fails open.**
This is the decisive live proof that the new logging works, and the one a
pre-deploy zero can never stand in for.
*Trigger:* the first genuine production fail-open after deploy — any gated
substatus write whose `makesafe_job_details` or `jobs` pre-read returns a
PostgREST error. In practice that is a schema drift (`42703`), a statement
timeout (`57014`), or a connection fault during a write.
*Expected:* exactly one `makesafe_substatus_gate_fail_open` line for that write,
carrying the job id, the attempted substatus, the write-origin, the PostgREST
error code, and a `skipped_checks` list — and the write itself still landing,
because the fail-open stays open.
*Why it cannot be forced:* a production PostgREST read cannot be made to fail on
demand, which is the same structural reason FLP-1 is test-only. The difference
is that FLP-1 will never become live, whereas this one fires on its own the
first time production has a bad read — it is genuinely queued, not closed.
*Honest expectation on timing:* the old dead-catch census above found zero read
failures across a production day, and this gate takes 1-2 writes a day, so this
event may sit unfired for a long time. **Do not read a long silence as a pass**
— it is an unproved check, and it stays open until a real fail-open is observed
or the gate is retired. If it matters sooner, the sanctioned way to close it is
a deliberate fault drill in a non-production environment, not a manufactured
failure against the Captain's board.

**FLP-4 — absent card proves silent on the live path.**
*Trigger:* the first gated substatus write against a card with no
`makesafe_job_details` row, post-deploy. Expect the write's outcome to be
`checked` with `detail_read: 'absent'` and **no** marker line.
*Why not tonight:* it needs deployed code and a production write, and the only
such card today (`SWMS-26001`) is archived and does not need one. Per the
dispatch boundary, a production write is not manufactured to satisfy a check.
The data-layer half of this proof did run live — see Live check B.

## Handover to item 2 — WRITTEN, not assumed

The spec says item 1 "should be done by whoever does item 2, or handed over
cleanly". **It is not the same worker**: item 2 runs in a later wave with a
different agent, so this section is the handover and there is no shared context
to fall back on. Read it before writing the helper.

Item 1 is complete and item 2 (`writeMakesafeSubstatus`, a single helper) is
unblocked. What item 2 inherits:

- `assertMakesafeSubstatusTransition` now **returns**
  `MakesafeSubstatusGateResult` instead of `void`. The helper should thread
  `outcome` outward rather than discarding it — that value is the whole point
  of spec item 1 point 4, and no caller consumes it yet.
- The gate's error contract is settled, so the helper can be written around it
  without a second pass. Refusals still throw `ApiError(409)` from
  `index.ts`; the module returns a typed `refusal` and never throws for a
  business reason.
- The two ungated substatus writes (the detail-row insert at card creation /
  historical-backfill repair, and `approveIntakeDraft`'s report-only park) are
  named in the gate header comment. They are preserved, and item 2 must not
  fold them into the helper.
- Item 3 replaced the `source` string with the typed write-origin while
  retaining the `source` payload key. External requests may optionally send
  `caller: { class: 'agent' | 'ops_ui', detail? }`; a missing, malformed, or
  unsupported signal becomes `unidentified` so existing callers stay loose.
  The separate `makesafe_agent_money_stage_fence` observation records a money
  stage (`ready_to_invoice` or `complete`), caller class/detail, auth mode, and
  whether strict mode would refuse. Strict mode ships off; only an explicitly
  signalled `agent` would be refused after the one-line flip. The existing
  routine-key refusal remains independent and unchanged.
- **Do not re-open the fail-open decision.** Making it fail-closed has its own
  outage profile and is not authorised by this spec. If the helper looks like a
  natural place to "finally refuse on an unreadable read", that is a separate
  change needing its own Captain decision.
- **Two acceptance checks on item 1 are still open** (FLP-2 and FLP-3 above).
  Item 2 does not inherit responsibility for closing them, but it must not
  break them: if the helper changes how the gate is called, the marker must
  still be one line per gated write and the payload keys asserted in
  `makesafe_substatus_gate_test.ts` must survive, or FLP-2/FLP-3 stop being
  answerable against the queries recorded here.
- Regression surface to keep green: `makesafe_substatus_gate_test.ts` (14
  tests, all against the real gate — there is no reimplemented-pure copy to
  update). Honest suite baseline for the whole `makesafe_*` set is
  **2,323 passed / 22 failed**, the 22 being pre-existing.

## Re-proving this read-only

```bash
set -a; . ~/.config/secureworks/env; set +a
# marker census, 24h window
curl -s -G "https://api.supabase.com/v1/projects/kevgrhcjxspbxgovpmfl/analytics/endpoints/logs.all" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  --data-urlencode "sql=select count(*) as total, countif(event_message like '%makesafe_substatus_gate_fail_open%') as fail_open, countif(event_message like '%makesafe_substatus_gate_read_threw%') as threw, countif(event_message like '%[ops-api]%') as ops_api_lines from function_logs" \
  --data-urlencode "iso_timestamp_start=<ISO>" --data-urlencode "iso_timestamp_end=<ISO>"
```

A window wider than about a day is sampled by the log backend (a 7-day query
returned fewer rows than the 24-hour one), so keep the window at 24 hours and
repeat it rather than widening it.
