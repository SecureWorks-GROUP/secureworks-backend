# `report_sent_at` becomes derived from a recorded send (2026-08-07)

## The defect

`makesafe_job_details.report_sent_at` sat on the ordinary field allow-list of
`update_makesafe_details`. That action is not privileged, the field was not
derived from any send that actually happened, and nothing cross-checked it
against mail evidence. Whatever value arrived was written down and thereafter
believed.

A card claiming a send that never happened is worse than a card claiming
nothing: `report_sent_at` is a term of `sentClosed` (`_deriveMakesafeSurfacing`,
`index.ts`) and a skip predicate in `makesafe_draft_pack.ts`, so a false stamp
drops the card out of every chase, follow-up and readiness sweep silently. Five
cards carried exactly that and were cleared on 2026-08-07
(`docs/evidence/ses-manufactured-blockers-2026-08-07.md`).

## What changed

1. **The generic door closes.** `report_sent_at` comes off the
   `update_makesafe_details` allow-list, and a request naming it is REFUSED with
   a 400 rather than silently ignored — a dropped key would tell a correction
   script its write landed when it had not. The refusal covers `null` as well as
   a timestamp: clearing is a correction and needs proof the card was never sent.

2. **A sealed-release send now stamps the card.** Until now a card sent through
   the sealed release graph got no stamp at all, so the field was wrong in BOTH
   directions. `executeSesReleaseRevisionAction` stamps each release member from
   the earliest confirmed route proof, after the closeout read-back has proved
   the exact route-proof set.

3. **Correction stays where it was.** `correct_makesafe_false_send_stamp` is
   unchanged and remains the only path that clears a stamp, behind its own
   privilege gate and server-side send-truth derivation. **No new privileged
   SET path was built**, deliberately — see "What was NOT built".

New module: `supabase/functions/ops-api/makesafe_report_sent_stamp.ts`.
Tests: `makesafe_report_sent_stamp_test.ts` (12).

## The three producers, and nothing else

| Producer | Trigger | Guard |
|---|---|---|
| `applyMakesafeCloseOut` (`index.ts`, pre-existing) | legacy `makesafe_send_pack` close | both call sites require the `MAKESAFE_PACK_SENT \| main` marker or a durable sent pack row; stamps only when absent |
| `stampMakesafeReportSentFromRouteProofs` (**new**) | sealed release graph, post-closeout | compare-and-set on `report_sent_at IS NULL`; value is the proof's own `proven_at` |
| `correct_makesafe_false_send_stamp` (pre-existing) | hand-adjudicated correction | privileged; re-derives send truth from four surfaces; only ever CLEARS |

None accepts a timestamp from a caller.

## Caller inventory (swept before the change)

| Where | Writes `report_sent_at` via `update_makesafe_details`? |
|---|---|
| `scripts/apply-ses-false-send-stamp-v1.ts` | **YES** — the only one. Posted `{ job_id, report_sent_at: null }`. **Repointed** to `correct_makesafe_false_send_stamp` in this change. |
| `secureworks-ux` `main` (the SERVING Ops Dash / Trade App) | No. Zero occurrences of `report_sent_at` or `update_makesafe_details`. |
| `dashboard/` submodule at the pinned commit | No. Zero occurrences of either. |
| `secureworks-wiki` (skills, incl. `secureworks-makesafe-reporting`) | No. Every hit is prose or a read; `makesafe_outstanding.py` only READS the field off `sw_job_detail`. |
| `secureworks-agent`, `securedash` | No occurrences. |
| Everything under `supabase/functions/` | No. The internal writers are `applyMakesafeCloseOut` and the two reattend/reset paths that null it internally — none goes through the action. |

The repointed script is the item the brief warned about: it went through the
unguarded door, and its `apply` mode would have started 400ing after the change.
Its client-side assessment is kept as a second opinion, so a card it would refuse
is never offered to the action, and the action refuses independently if
production disagrees. Its `dry-run` and `verify` modes were already read-only
and are untouched.

## Blast radius

Re-provable read-only, exits non-zero if any card would lose a stamp:

```
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net \
  scripts/ses-report-sent-at-blast-radius.ts
```

Measured 2026-08-07 across 461 SES cards:

| | cards |
|---|---|
| stamped | 31 |
| — corroborated by at least one send surface | 28 |
| — no surface at all (false stamps) | 3 |
| unstamped | 430 |
| — but a surface records a send (historical gap) | 229 |
| **stamps that CHANGE under the derivation** | **0** |

Zero is structural, not a coincidence of today's data: the derived producer
writes only where `report_sent_at IS NULL`, and no branch in it writes null.
The 28 true stamps are untouched. The 3 false ones stay exactly as they are —
clearing them belongs to `correct_makesafe_false_send_stamp` and is a separate
adjudication, not a side effect of closing a door.

The 3 stamped cards with no evidence on any surface, unchanged by this work:

| card | stamp | proof | effect | pack | marker |
|---|---|---|---|---|---|
| SWMS-26716 | 2026-06-29 05:40:01 | 0 | 0 | 0 | 0 |
| SWMS-26856 | 2026-06-30 00:46:36 | 0 | 0 | 0 | 0 |
| SWMS-26859 | 2026-06-30 00:46:38 | 0 | 0 | 0 | 0 |

## The card the evidence and the brief disagree about: SWMS-26845

The brief states Queens Park **SWMS-26845 was never sent** and must not acquire
a stamp under any circumstance. Production disagrees with that on one surface:

```
SWMS-26845  report_sent_at=NULL  proof=0 effect=0 pack=0 marker=1
  job_events note 2026-07-02T09:49:07Z:
  "MAKESAFE_PACK_SENT | main | INV-0868 | to=<redacted> | 2026-07-02T09:49:06Z | msgid=-"
```

Naming it rather than picking a side, as instructed. Two readings are open and
this work does not resolve either: the marker is a real pre-pack-table send
whose stamp was simply never written, or the marker is itself false (note
`msgid=-`: no message id was recorded). **It does not matter for this change**,
because nothing here backfills a stamp onto a historical card — the derived
producer fires only on a fresh sealed-release send, which this card will not
retroactively receive. Its stamp stays NULL. Any future decision to act on the
229-card gap must adjudicate this card explicitly first.

Koondoola SWMS-261025, Clarkson SWMS-26931 and West Perth SWMS-261018 all carry
`report_sent_at = NULL` and zero evidence on all four surfaces; all three are
untouched.

## What was NOT built, and why

A privileged path that SETS a stamp on demand. The brief allows one "if closing
the door needs a legitimate privileged path for a genuine correction" — it does
not. Both directions are already covered by derivation:

- forward, by the two producers above;
- backward, by the existing guarded clear.

A set-on-demand action would be the same hole under a new name, and its first
use would be the 229-card historical gap — which changes `sentClosed` surfacing
on 229 live cards and is a Captain decision, not an implementation detail. That
gap is reported here and applied nowhere. **Named for the Captain:** whether the
229 unstamped-but-evidenced cards should be backfilled from their own send
records, and what to do about SWMS-26845's disputed marker.

## Migration

**None.** No schema change was needed. The derivation is entirely in edge
function code and stands alone.

## Live proof

`update_makesafe_details` before deploy, probed with an all-zeros UUID so no real
card was touched:

```
POST ops-api?action=update_makesafe_details
  {"job_id":"00000000-...","report_sent_at":null}
→ {"error":"Cannot coerce the result to a single JSON object"}
```

The field got past the allow-list and reached the database — the door was open.
After deploy the same probe must return the refusal naming
`correct_makesafe_false_send_stamp` instead. `correct_makesafe_false_send_stamp`
was confirmed already deployed in the same pass (it returned its own
`job_ids (non-empty array) required` 400), so the repointed script has a live
target.

## Test posture

`deno task test:ops-api` carries 25 pre-existing failures and 2 pre-existing
type errors in `cp1_drag_reschedule_test.ts` on the base commit. The failing set
was captured before and after this change and is **byte-identical**; this work
adds 12 passing tests and no new failures.
`deno check --config deno.jsonc supabase/functions/ops-api/index.ts` is clean.
