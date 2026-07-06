# SOP: Ordering reference discipline (materials)

Mission `profit-materials-actuals-2026-07-03` · U2. Companion to
`po_reference.ts` (the code that enforces this on tool-driven orders).

## Why
Every supplier dollar has to land on a job, or per-job profit is fiction. The
inbound bill-linker can only match a supplier bill to a job when the bill carries
our job number. So the job number has to get onto the order AND onto the
supplier's invoice.

## The one rule
Put the job number on the order, and ask the supplier to quote it on their
invoice.

## The format (exact)
Use the canonical job number verbatim: `SW[division]-#####`, e.g. `SWF-25010`
(fencing), `SWP-25029` (patio), `SWD-25040` (decking). Five digits, with the
hyphen and the division letter.

Do NOT use:
- `SW-25010` (no division letter) — the reconcile linker misses it.
- `SWF25010` (no hyphen) — neither linker catches it.
- `SWMS-#####` on a materials order — that is the make-safe family, not materials.

If one job needs several separate orders, add a suffix: `SWF-25010-01`,
`SWF-25010-02`. The linker still matches on the embedded `SWF-25010`.

## By ordering channel
- **Tool orders (patio / fence scoping tools):** automatic. The draft PO already
  carries the job number as its reference and the quote-back ask in its notes.
  Nothing to do by hand.
- **Phone / counter orders (Bunnings PowerPass, Fencing Warehouse WA, R&R, B&D,
  CMI, Ampelite, etc.):** give the job number as the order reference, and say
  "please put `SWF-#####` on the invoice." For Bunnings PowerPass, type the job
  number into the PowerPass order-reference field.
- **Bookkeeper keying an emailed supplier invoice into a Xero draft bill:** type
  the job number into the Xero bill **Reference** field, exactly `SWF-#####`.
  That single field is what lets the bill auto-link to the job.

## Recovery (if a reference is wrong)
A wrong reference on an order is corrected by a follow-up email to the supplier
(Marnin-approved). The PO record stays editable until a bill arrives, and no money
moves on a PO, so a correction is always safe. The landed materials fact is a
derived row keyed to the source bill and can be reversed without touching the
supplier's invoice.
