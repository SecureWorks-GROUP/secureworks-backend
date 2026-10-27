# Group work-order repair, 27 October 2026

Owner request: fix the Zoo group screen for Isaac, Henry and Ryan; the client has already signed off, so allow the office to override client signing.

Acceptance: both job responses carry the real feature switch; staff can record a reasoned, attributed office override through the existing staff-only action; latest valid override counts for group sign-off and becomes stale after hours change; revoked sign-off still fails. No fabricated signatures, share freezing, invoice submission or payment as part of this change. Existing shared work order stays intact.

This supersedes the group documentation's earlier no-office-waiver default. Evidence and run log to follow here.

## Run checkpoint
Local implementation and verification complete; see verify/evidence/20261027-group-office-signoff.md. Next: publish reviewed backend and UX changes, verify live response, then record the owner-authorised office waiver on the Zoo job through the existing API. No live override has been recorded yet.
