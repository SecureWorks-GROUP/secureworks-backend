# Group office sign-off verification

Owner authorised office override instead of a repeated client drawing, plus repair of hidden group cards. The existing staff-only waiver action records reason and actor. No automatic split freeze, invoice, payment or customer message is introduced.

Checks run by builder:
- Existing group API suite: 31 passed, zero failed, including fresh office override and later-hours invalidation.
- Disposable PostgreSQL with the actual new function: seven outcomes passed (missing record, fresh office approval, missing actor, missing reason, changed hours, reapproval, later revoke).
- Executed changed screen handlers with simulated DOM/API: enablement, hours display, escaped reason, participant privacy, frozen hours, stale navigation read/write rejection, and exact office action all passed.
- Independent static database review: no further database/TS parity or privacy blocker. Stale-navigation finding fixed with current-job checks.
- JavaScript syntax and whitespace checks passed. Impeccable mechanical scan returned no findings.

Limits: browser rendering and signed-in crew interaction were not tested. Only everyday Chrome is installed and no approved computer-use tool is available. Full backend entrypoint type-check awaits network dependencies; group module itself was type-checked with its tests. Public client-link reader still uses cached status; this change is for office and trade screens and sends no client link.
