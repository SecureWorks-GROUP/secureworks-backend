# Pending debt proposals

`POST ops-api?action=debt_proposal_save` stores one exact pending SMS or email proposal on an open receivable. It never contacts a provider. Fields: `xero_invoice_id`, `kind` (`sms` or `email`), `text`, `to`, optional email `subject`. A subject is persisted as `Subject: ...` at the start of the complete proposal text. No migration or new table.

The route requires authenticated staff or server API access; JWT organisation and actor come from the verified profile. A browser's `operator_email` is ignored. Approval, status, provider receipt and organisation fields are rejected. Saving changed content clears previous approval and receipt fields. An identical pending proposal is a no-op. An invoice or proposal changed during saving returns a conflict. A saved proposal whose separate audit insert fails returns `audit_warning`; it is still pending and safe to read back, not retry as a send.

`debt_proposal_mark` now accepts decline only. Its previous arbitrary `operator_email` could not prove Marnin approval, so approved/sent marks are refused. Individual terminal approval and provider execution remain outside this route. No changes to shared send APIs, scheduled chasers, Xero, or CIO's context pipeline.

Proof: `deno test --allow-read supabase/functions/ops-api/debt_proposal_test.ts` exercises pending-only persistence, repeat-save idempotency, full email text, forbidden fields, tenant/open-receivable checks, executable route authentication/method guards and author spoof refusal. These are fake-database tests; no live send or production write was made.
