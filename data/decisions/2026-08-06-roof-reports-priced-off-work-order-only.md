# Captain ruling, 2026-08-06 — roof reports are priced off the work order only

## The ruling

> **ROOF REPORTS ARE PRICED OFF THE WORK ORDER ONLY.** The trade-observation override is a
> MAKE-SAFE rule and does not apply to roof reports.

Three consequences, all stated by the Captain:

1. **White Gum Valley `SWMS-261114` / `INV-1149` stays at $300 ex / $330 inc.** No void, no
   reprice, no storey correction.
2. **The 40-of-63 census is BY DESIGN, not a gap.** Roof cards carrying a work-order-derived
   `storeys` fact with no way to record a trade contradiction is the intended behaviour, not
   an exposure to close.
3. **The storey-correction mechanism is explicitly NOT to be built.** Dropped entirely.

## What this overturns

The premise handed to the investigating worker was that the Captain's standing rule — *the work
order's storey statement is acceptable pricing authority unless the trade observed otherwise on
site* — applied to this roof card. It does not. That rule governs **make-safe** cards. It was
applied to a roof card in error, and the alarming 40-of-63 number was sized off that error.

The Captain's own words on the correction: *"That was my error, not yours: I applied a make-safe
rule to a roof card and had you size an alarming number off it. Your evidence was correct
throughout; the rule I applied to it was wrong."*

## What survives, and why it is still worth having

The evidence stands; only the rule applied to it was wrong. On record in
`data/wgv-storey-single-reprice-v1/`:

- The builder's Prime portal form for `RR-26836`, locked and complete 24 of 24, inspected
  3 August, records **`Number of Storeys: Single Storey`**.
- The work order for the same job instructs a **"two storey roof report"**.
- The two genuinely disagree. Under this ruling **the disagreement does not change the price** —
  the work order governs, and the report fee follows it.

This is worth keeping precisely because the contradiction is real and visible. A future reader who
finds it on the card, or finds the same shape on another roof card, should reach this ruling rather
than re-derive a reprice from it.

Also on record and unaffected by the ruling: `INV-1149`'s $300 is a Captain-authorised
`commercial_rate_override` (`captain-preshutdown-send-batch-v1-wgv-roof300`) off the sealed
double-storey $350, not a raw schedule price. That authorisation stands.

## The two structural walls found on the way

Both were found by investigation and remain true statements about the system. Neither is now a
problem to solve; they are recorded so nobody re-investigates them:

- **There is no surface that writes a trade-observed storey correction.** Every storey writer
  derives from the work order. Under this ruling that is correct by design. Do not build one.
- **A bound SES DRAFT's total cannot be edited in place.** `makeSesXeroGateway` has no update
  verb, so any reprice is void-and-remint. Unchanged by this ruling and still true for every
  other repricing question.

## Status

**Settled.** Nothing pending, nothing to pick up. `INV-1149` remains a DRAFT at $330.00 inc
awaiting the Captain's own approve-and-send, exactly as it stood before the investigation.
