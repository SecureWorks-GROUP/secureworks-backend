# Held notes (20261015100000)

Owner ruling D10 (14 Oct 2026) and CTX-03 (15 Oct 2026): a message held on no job, because the
customer has several jobs and the right one is not certain, may open a note on each job it could
belong to, marked "job not certain". A note on one job too many is the cheaper error.

Switch: `feature_flags.context_held_notes_v1`, created off. Missing, unreadable or false reads as
off, and every replaced function then answers byte for byte as before (the contract proves it
against the earlier bodies).

## What the reader gets (switch on)

- `context_ledger_packet` (still `ledger-packet-v1`):
  - `held.citable = "job_not_certain"` on the section.
  - Each held row carries `citable` (true or false). It is false when a copy of the message is
    placed on a job, or when a call transcript's call is placed on another job. The placed copy
    wins: cite it instead.
  - In update mode, an open item that a held message still holds up carries `job_certain: false`
    and `certainty: "job_not_certain"`.
- `context_ledger_write` is unchanged. A held row may be an `opened_by` citation of an `open` item.
  The item check answers the same codes as before, plus three:

  | Code | Meaning |
  | --- | --- |
  | `held_not_open` | A held message may open or support only an open item. |
  | `held_copy_placed` | A copy is placed on a job, or the transcript's call is on another job. The detail names where. |
  | `duplicate_item` | The same held message already opened an item of this type and `about_key` on this job. |

  A held message never closes an item. Closing citations and transitions still refuse it as
  `citation_off_job`.
- An item first opened by a held message is keyed by that message alone:
  `type:about:left(md5('held:' || id), 12)`. So the same message opens one item of a type and
  matter per job, with the same key on every candidate job.

## What every reader of the item gets

The item is marked only while the message is still held for the job
(`context_ledger_held_citable`):

| Reader | Marker |
| --- | --- |
| Store | `context_ledger_items.job_not_certain` (trigger-stamped) |
| Story ledger read and job Overview notes | `job_certain: false`, `certainty: "job_not_certain"`, a held citation marked `held: true`, and the words starting "Job not certain: " |
| Job card (`context_job_story`) | The same two keys on its loops, agreements, events, settled and disputed entries, and `meta.ledger.job_not_certain_items` |

## When the message is placed later

- **Placed on this job:** the note reads as certain. Its citation is now this job's own, and the
  marker and prefix go away.
- **Placed on another job:** the note is dropped here, never closed. Its citation is no longer ok,
  so the story hides it at once and the judge raises `citation_moved`. The next read rebuilds the
  job without it, and the item check refuses the message on this job again (`citation_off_job`).
- **Switch turned off:** the same as placed elsewhere. Notes citing held messages are hidden and
  the jobs are rebuilt without them.

## Unchanged

Held messages are still never evidence rows:

- They never make a job due.
- They never count as unread.
- They never move `evidence_until`.

Placement, the ladder, the citation check itself, the write, finish and carry-forward are not
changed.
