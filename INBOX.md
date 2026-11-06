# Group work-order repair, 27 October 2026

Owner request: fix the Zoo group screen for Isaac, Henry and Ryan; the client has already signed off, so allow the office to override client signing.

Acceptance: both job responses carry the real feature switch; staff can record a reasoned, attributed office override through the existing staff-only action; latest valid override counts for group sign-off and becomes stale after hours change; revoked sign-off still fails. No fabricated signatures, share freezing, invoice submission or payment as part of this change. Existing shared work order stays intact.

This supersedes the group documentation's earlier no-office-waiver default. Evidence and run log to follow here.

## Run checkpoint
Local implementation and verification complete; see verify/evidence/20261027-group-office-signoff.md. Next: publish reviewed backend and UX changes, verify live response, then record the owner-authorised office waiver on the Zoo job through the existing API. No live override has been recorded yet.

## Named installer invoice access, 6 November 2026

Owner-authorised bounded exception: named ordinary installers may select any company job for their OWN trade invoice. Preserve the existing office/pay boundary and ordinary users' allocation restriction. Exact owner words and identity/live-operation receipt are private in Firstmate task trade-app-installer-access-and-granny-type-20261106. Existing Trade App six-part pointer remains unlocated; use docs/trade-all-means-all-v1.md and existing invoice contracts.

Target for this source slice: a default-off protected profile capability allows an invoice-only job picker with minimal fields; ordinary job/detail access and quote/pay visibility stay unchanged. The existing authenticated own-invoice searched-in extra-item submission lane stays in use. No invoice is created to verify this. Root owns frontend work, merge/release and subsequent named capability grants. Job taxonomy and one unresolved account binding remain separately reported, with no guessed enum or identity.

## Worker run checkpoint, 6 November 2026

Partial live profile operation read back privately. Picker source is uncommitted and unverified: Deno compile passed, targeted tests stopped twice on absent cached runtime modules under the no-download rule. Firstmate task trade-app-installer-access-and-granny-type-20261106 retains the exact run record, private receipt and Resume. No PR/push/deploy or invoice action. Firstmate must resolve cached-runtime-dependencies before continuation; no complete invoice journey claimed.
