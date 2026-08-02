# Captain ruling — SWMS-261059 is signed off

Date: 2026-08-02
Decision key: `2026-08-02-swms-261059-and-draft-invoice`

## The ruling, verbatim

The captain opened the card himself, read what is attached to it, and ruled:

> "it's already been invoiced ... this was done manually, through the back end,
> and actually the job's completely done. So you can fully sign that job off to
> completion or archived. Yeah, really happy with that."

He also stated that the attached "trade report" is not a raw trade report — it
carries the completion documents only — and that the work was done manually
through the back end rather than through the normal flow.

## What it decides

`SWMS-261059` is finished. It may sit in Completed or in Archive; the captain
named both as acceptable.

## What it does NOT decide

- It is a ruling about ONE job. It is not a rule about manually completed cards
  in general, and nothing was swept.
- It does not touch the money seal. Signing a job off is not an invoice action,
  and the card's `ses_money_sealed_at` is unchanged.
- It does not resolve why the gate could not see the invoice the captain could
  see. That contradiction is filed separately as
  `ses-manual-backend-completion-visibility-v1`; the observations that bear on
  it are in `docs/evidence/ses-261059-captain-signoff-2026-08-02.md`.
- It does not widen the `makesafe_terminal_proofs.kind` vocabulary. No new
  producer or evidence-type term was minted to record it.

## How it was recorded

As evidence, not as a stage. One `makesafe_terminal_proofs` row on the exact
job and its exact attendance-cycle set, with `proven_by` naming this ruling as
the producer and `evidence_refs` naming the four documents and the issued
invoice the captain read. The corrected shadow stage engine then DERIVED the
card's column from that record.

Applied by `scripts/apply-ses-261059-captain-signoff-v1.ts`. Evidence, the
before/after gate run and the linkage observations:
`docs/evidence/ses-261059-captain-signoff-2026-08-02.md`.
