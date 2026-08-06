# The `dashboard` Gitlink Is Not The Serving Path (2026-08-06)

Read-only investigation. No production write, no pin bump, no submodule edit.

## Why this exists

A task was raised on the premise that the Captain's make-safe board was slow
because this repo's `dashboard` gitlink was 29 commits behind
`secureworks-ux` `main`, and that bumping the pin would ship him the
click-to-paint fix (`52c2143`, #248).

**Both halves of that premise are false.** The gitlink does not serve his
cockpit, and the fix was already live before he loaded the board. This document
exists so the theory is not re-derived and re-run next week: the gitlink being
stale is real, but it is a hygiene fact, not a production one.

## Finding 1 — Pages serves `secureworks-ux` `main` directly

The Ops Dash is served by GitHub Pages **from the UX repo**, not from anything
this repo pins or deploys.

| Check | Result |
|---|---|
| `gh api repos/SecureWorks-GROUP/secureworks-ux/pages` | `status: built`, `source: {branch: main, path: /}` |
| `gh api repos/SecureWorks-GROUP/secureworks-backend/pages` | **404 — no Pages site** |
| Backend workflows referencing `dashboard` | none (`deploy-edge-functions`, `makesafe-intake-watchdog`, `pr-check`) |

Served URL: `https://secureworks-group.github.io/secureworks-ux/ops.html`.

Chrome history confirms that is the URL actually opened: 125 visits, most recent
2026-08-06 15:53 local. A `file:///…/secureworks-ux/ops.html` local clone appears
with a single visit per hash route and is not the working path.

## Finding 2 — the served bytes are UX `main`, not the pin

Fetched the live file and compared against both trees:

| Source | sha256 (16) | bytes |
|---|---|---|
| Served `ops.html` | `fc2d68262c70cc63` | 1,368,788 |
| `secureworks-ux` `origin/main` | `fc2d68262c70cc63` | 1,368,788 |
| Backend gitlink `ef8e0173` | `6465dcb8cd94f368` | 1,225,828 |

Byte-identical to `main`. The pin is a different file and is not served anywhere.

`52c2143`'s own markers are present in the served bytes and absent from the pin:
`_makesafeIntakeSweepInFlight` (4/0), `btnMakesafeIntakeSweep` (2/0),
`ops_intake_review_sweep` (1/0).

## Finding 3 — the fix was live three minutes after merge, before he loaded

This is the part that closes the theory.

| Event | Time (UTC) |
|---|---|
| `52c2143` #248 merged to ux `main` | 07:45:19 |
| GitHub Pages built commit `52c2143` | 07:48:35 |
| Captain loaded the board | 07:53 |

Pages auto-deploys from `main`, so UI work reaches him within minutes of merge
with no action in this repo. There is no deploy step here to be behind on.

## Finding 4 — measured click-to-paint is ~3.5s, not ~30s

Jobs tab -> "Make Safes" (`setPipelineTab('makesafes')`), instrumented in the
browser against the live served page, 119 make-safe cards painted, fresh tab per
run:

| Run | First paint | Settled |
|---|---|---|
| 1 | 4.20s | 4.71s |
| 2 | 3.96s | 4.47s |
| 3 | 3.34s | 3.85s |
| 4 | 3.53s | 4.05s |

Board API alone (`ops-api?action=makesafe_board`): 2.64 / 2.70 / 2.89s TTFB,
595 kB. So ~2.7s backend + ~0.8s render. Consistent with #248 having landed.

**The gap between this and the ~30s described is the remaining open question.**
Most likely the report predates the 07:45Z merge. If ~30s is still observed
after that, the cause is unfound and is not the pin — do not re-open the pin
theory to explain it.

## Hygiene finding (NOT fixed, deliberately)

`origin/main` pins `dashboard` at `ef8e01732684eeeebdb6f23ff7d7b4e6667e0cfc`,
which is **the HEAD of an unmerged UX branch**,
`origin/fm/ses-f5-portal-link-hygiene-v1` — not a commit on ux `main`.

So the pin is a **divergence**, not merely a lag:

- diverged from `main` at `ae29676` (#219)
- `main` carries 29 commits the pin lacks
- the pin carries **5 commits `main` lacks**

Those 5 are superseded, not lost:

| Pin commit | Superseded by |
|---|---|
| `ef8e017` F5 portal-link hygiene | #227 + #231 |
| `dee1848` / `52d39ed` / `b2018fb` / `f5d803c` reattendance | #220 |

Main is strictly stronger on both. For F5 it hoists the predicate into the
shared `collectMakesafeExternalLinks` consumed by the job-detail panel and the
board card, **removes** the pin's permissive untyped-share fallback, and pins
that removal with an assertion (`trade portalUrl rejects untyped share`) the pin
does not have. Reattendance parity: `reattend` 25/25, `attendance_cycle`
main 6 vs pin 4.

**The trap:** anyone who later reads this gitlink as "the dashboard revision"
will conclude the cockpit is missing merged work, or that the pin holds work
`main` lost. Neither is true, and neither is visible without a `merge-base`
check.

**Not bumped, on the Captain's call (2026-08-06):** a bump is a divergence, not
a fast-forward, it would discard the 5 superseded commits, and it delivers
nothing to production because the gitlink is not the serving path. Shipping a
change with zero user-facing effect was declined. If it is ever bumped, do it as
a declared pointer chore and say plainly in the PR that it changes no deployed
artifact.

## Re-proving this

All read-only:

```bash
gh api repos/SecureWorks-GROUP/secureworks-ux/pages          # source branch
gh api repos/SecureWorks-GROUP/secureworks-backend/pages     # expect 404
curl -s https://secureworks-group.github.io/secureworks-ux/ops.html | shasum -a 256
git -C dashboard merge-base --is-ancestor <pin> origin/main  # expect NON-zero
```
