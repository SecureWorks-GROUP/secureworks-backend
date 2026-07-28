# SES U7 sibling-evidence seed guard correction

## Outcome

The U7 sibling-evidence migration remains fail-closed, but it no longer claims
that production contains a photo artifact which does not exist.

The migration installs the append-only sibling binding and evidence-claim
surfaces, records the reviewed reciprocal relationship between `SWMS-26832` and
`SWMS-26837`, and deliberately leaves the evidence claim absent when the exact
hashed photo is absent. U4 therefore reports the positive-scope evidence gap
instead of accepting invented evidence.

## Production diagnosis

Read-only production checks on 2026-07-28 found:

- both reviewed jobs exist;
- authorised invoice `INV-0835` contains the exact Hardie-panel stacking line;
- the reviewed delivery email identity and scope phrase match;
- the reviewed make-safe report and SWMS documents exist;
- neither job has any `job_media` row;
- the delivery email has four persisted PDF attachments and no standalone
  immutable photo attachment.

That agrees with the earlier board truth sweep, which recorded zero completion
photos for `SWMS-26837`. The original migration guard incorrectly treated one
hashed `job_media` photo as an established production fact and aborted when its
count was zero.

## Corrected guard

- Zero complete production footprint still skips the reviewed seed for empty
  or non-production databases.
- Missing or drifted jobs, invoice, delivery, report, or SWMS still aborts the
  migration.
- More than one matching photo still aborts as ambiguous.
- Exactly one matching immutable photo seeds the reciprocal binding and the
  positive evidence claim.
- Zero matching photos seeds only the reviewed reciprocal binding, records
  `withheld_missing_photo_artifact` in its durable provenance, and creates no
  evidence claim or media row.

No job, status, invoice, document, email, event, or media row is created or
modified by this correction.

## Required post-deploy proof

After the migration-first workflow succeeds:

1. migration `20260728730000` is applied and ledgered;
2. exactly two reviewed binding rows exist for the pair;
3. no sibling evidence claim exists for the reviewed claiming binding;
4. the deployment continues to the later board-state migration and edge
   function deployment.
