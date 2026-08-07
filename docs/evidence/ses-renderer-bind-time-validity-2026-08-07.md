# A renderer re-pin must not un-trust the binds made under the old pin

**2026-08-07.** Read-only measurement plus a two-call-site fix. No re-bind, no
migration, no mint, approve, authorise, send or void.

## The defect

`bind_current_cycle_curated_makesafe_report` stamps a document with the renderer
identity that is authoritative **at the moment of the bind** — `index.ts` writes
`report_renderer_version` / `_source_revision` / `_script_sha256` straight from
the `makesafe_report_render.ts` constants, without asking what produced the
artifact.

Two readers then compared that stamp against those same constants **as they
stand now**:

- `ses_supporting_report_trust.ts` — `inspectSesSupportingReportProof`, check 8's
  `active_renderer_input_binding_missing` term (served pack, cockpit, Docs Ready
  signoff, send-time signoff wall).
- `ses_assembler_input_adapter.ts` — `durableCuratedDocumentForCycle`, the filter
  that decides whether a bound document is a selectable curated source.

Both therefore asked "was this produced by the renderer authorised **today**".
The honest question is "was this produced by the renderer authorised **when it
was bound**". At the instant the 2026-08-07 re-pin went live, every bind made
under the previous pin became untrusted at once — while not one bind record
changed. The validator became wrong about the past; the binds stayed true. That
is why the repair is the validator, not a re-bind, and why the same thing would
recur on **every** future renderer change.

## What was actually affected

Not three cards. Measured read-only 2026-08-07 over the whole estate
(`scripts/ses-renderer-bind-time-validity-verify.ts --mode=derive`):

| | |
|---|---|
| curated report binds carrying a renderer stamp | 36 |
| stamped with the current pin (unaffected) | 2 (SWMS-261156, SWMS-261017) |
| stamped `fda63bcf…` and silently un-trusted | **34 documents across 33 cards** |
| cards with no recovering bind | 0 |
| newly refused by the fix | 0 |

The three cards in the report (SWMS-261157, SWMS-261140, SWMS-261161) are simply
the ones somebody looked at. 30 more were in the same state, including
SWMS-26845 and SWMS-261025, which are on the do-not-touch list — nothing here
writes to them; they are restored to correct validation by the same code path as
everything else. SWMS-261025's bind is on a **non-current** cycle, so it stays
out of current-cycle selection regardless.

One row does not recover and is named rather than papered over: SWMS-261015 has
a **second** `makesafe_report` document (`cf9b11c7`) carrying the old renderer
stamp but **no `curated_source_identity` and no bind event**. It was never a
curated bind, it was refused before the re-pin for its own reason, and it stays
refused. That card's real curated bind (`9a0cda88`) recovers.

## The fix

`supabase/functions/ops-api/makesafe_report_renderer_authority.ts` — an
append-only register of authorised renderer identities, each with its wiki source
revision, its script SHA-256, a validity window, and the provenance of both
window instants. `makesafeRendererStampAuthorisedAtBind(stamp, boundAt)` is the
one predicate; **both call sites consume it**, so they cannot disagree (a
`both call sites answer the same way` test pins that directly).

| source revision | script sha256 | window |
|---|---|---|
| `8348325b…` | `b4fb6350…` | 2026-08-03T14:18:07Z → 2026-08-03T16:13:04Z |
| `915e9b42…` | `fda63bcf…` | 2026-08-03T16:13:04Z → 2026-08-07T08:36:29Z |
| `2cb60bf0…` | `c3e48d4f…` | 2026-08-07T08:36:29Z → open |

Window instants are **deploy** instants, not merge instants, taken from the
completion of the "Deploy changed edge functions" step of the corresponding
`Deploy Edge Functions` run (16cc2dc9/run 30821985145, 9e733e12/run 30830398249,
0caad8fe/run 31162359402). The deployed build is what stamps a bind, so between a
pin merging and that build going live production still stamps the OLD identity
and those binds are legitimate. Every live `fda63bcf…` bind falls inside its
window (earliest 2026-08-04T04:38:11Z, latest 2026-08-07T08:00:25Z) and every
`c3e48d4f…` bind after it (earliest 2026-08-07T08:53:04Z) — the data brackets the
boundary from both sides.

`b4fb6350…` has **zero** live binds. It is recorded anyway: the register is the
history, not just the load-bearing part of it.

### The bind instant

There is no bind timestamp on `job_documents` (no `updated_at`; `created_at` is
document creation, which precedes the bind). The instant comes from the
append-only `job_events` row of type `ses_curated_report_source_bind_validated`,
written server-side immediately **before** the snapshot it describes. It is never
caller-supplied and never rewritten. The **newest** event per document wins, so a
document re-bound under a newer renderer cannot be vouched for by its own older
bind.

The adapter reaches it through its own `job_events` read in the existing
concurrent wave, deliberately NOT a widened `.in(['note', <bind event>])` beside
the bundle-candidate notes: one read would put both classes under a single
PostgREST row ceiling, so a chatty job could truncate the notes, and this trail
is the sole authority for when a renderer identity was stamped. Each class gets
its own bound and its own snapshot field. `ses_reporting_actions.ts` already read
exactly these rows for supersessions; that loader now returns both facts
(`loadSesCuratedBindAudit`).

Ordering across the two readers of that trail is deliberately ASYMMETRIC and must
not be harmonised: an unparseable `created_at` sorts newest for supersession
(suppressing more) and is discarded for bind-instant lookup (leaving the current
pin the only acceptable stamp). The reasoning is on
`sesCuratedSourceSupersessionsFromEvents` / `sesCuratedBindInstantsByDocument` in
`ses_supporting_report_trust.ts`.

## What did not weaken

- **A new bind must still match the current pin exactly.** The register accepts
  the open entry with no instant at all — byte-for-byte the previous behaviour.
  An older identity is admissible only for an instant inside its own closed
  window.
- **No instant is not a licence.** A superseded stamp with no bind event, an
  unparseable instant, or an unreadable audit trail all refuse, exactly as
  before.
- **A stamp whose version and revision disagree** matches no entry and is
  refused, rather than resolved in favour of either half.
- Nothing was rewritten. No bind record was migrated to claim the new renderer
  produced it — that would be false for every card it touched, and the provenance
  stamp already overstates itself once.
- The sealed money fence, the eight curated-bind evidence gates, supersession
  suppression and send gating are untouched. A real bind instant does not rescue
  an artifact failing any other check (pinned by
  `bind-time validity opens nothing else`).

### Sibling bundles

A bundled supporting report is persisted with `source_kind:
"durable_curated_revision"` and its `source_document_id` naming the **sibling**
job's document, so the docket job's audit trail can never carry its bind
instant. `verifyStoredSupportingReport` therefore reads the sibling job's own
trail — the same access shape the adapter already uses, since sibling snapshots
load through `loadSesAssemblerLiveSnapshot` and carry `curated_bind_events`.
Without it the two call sites would disagree for exactly this class, which is
the partial-fix shape rather than the cure, and 34 of the 36 live binds carry
the superseded identity, so bundles built on one are the dominant case.

The read is deliberately narrow and no more permissive than a same-job bind. It
fires only when the own-job lookup found nothing AND the artifact declares
`evidence_source: "explicit_sibling_bundle"` AND names a `sibling_job_id`, and
each of these refuses (each pinned by a test that was watched to fail against a
deliberately broken guard):

- a sibling bind made **after** the identity's window closed — the forward
  fence, unchanged across a job boundary;
- a sibling bind made **before** the window opened;
- an in-window sibling bind **superseded by a later one** past the window, since
  the newest bind decides and the friendliest event never wins;
- **no sibling bind event at all**, leaving the current pin the only acceptable
  stamp;
- an **unreadable** sibling trail, which reports the read fault
  (`curated_source_supersession_unreadable`) rather than a renderer-provenance
  failure — calling it the latter sends an operator to re-bind a card whose bind
  is fine, which is this defect's own lie one seam over. It fails closed.

Isolating that last case needs the sibling trail to fault while the docket job's
own trail reads cleanly; faulting both stops at the own-job audit and never
reaches the sibling branch at all.

## Proofs

1. **The cards recover with no re-bind.** `--mode=served` (a `dry_run: true`
   prepare, which guards `deps.persist` and writes nothing) against the deployed
   backend. The BEFORE state is captured against the deployed unfixed backend and
   reproduces the symptom exactly (SWMS-261157 / SWMS-261140 / SWMS-261161
   refuse, SWMS-261156 does not). The AFTER read-back is **still outstanding at
   commit time** — it needs this fix merged and deployed. Trigger: re-run
   `--mode=served` once `ops-api?action=ops_api_version` reports a `commit_sha`
   that has this fix as an ancestor
   (`git merge-base --is-ancestor <fix> <commit_sha>`).
2. **The fence holds forward.** `the fence holds forward: a superseded identity
   with a current instant is refused`, at the register and at both call sites,
   plus `the newest bind decides` and a live check that no recovered card's
   instant falls outside its window (`fence breaches: 0`).
3. **SWMS-261156 unaffected**, in both modes.
4. **The wider population** is the table above; `--mode=derive` re-runs it.

Both modes are re-provable read-only at any time:

```
SUPABASE_ACCESS_TOKEN=… SW_SUPABASE_URL=… SW_API_KEY=… \
  deno run -A scripts/ses-renderer-bind-time-validity-verify.ts [--mode=served]
```

`--mode=derive` reimplements nothing: it feeds real stored stamps and real bind
instants to the shipped predicate. A second, cruder copy of "was this renderer
authorised" is precisely the defect being removed.

## The next re-pin

A re-pin is now a three-part change in one commit: move both constants, close the
outgoing register entry at the **measured deploy instant**, append the new entry
with `authorised_until: null`.
`assertMakesafeRendererRegisterMatchesPin()` fails the suite if the register
falls behind the pin, if two windows are open at once, if a window gap opens, or
if a past entry is edited to repeat an identity instead of a new one being
appended. Each failure mode is tested against a deliberately broken register, not
just asserted on the good one.

The measured deploy instant is the honest boundary and the only awkward part of
the procedure: it is read off the GitHub Actions deploy job, not off the commit.
If a future re-pin cannot measure it, closing the window slightly LATE is the
safe rounding — no bind carrying the old identity can exist after the new build
is live, because the server stamps its own constants.
