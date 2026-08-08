# Echo-code text approvals v1

## Scope and call-site inventory

This slice replaces the deployed route's former TOTP approval mechanism with
server-issued echo codes. The cockpit approval action is unchanged, and SEND IT
remains a separate act.

Behavioural call sites that must honour the contract:

1. `issue_ses_channel_approval` — authenticated captain session; server mints
   and persists the request and returns the sole code-bearing transport
   envelope.
2. `submit_ses_channel_approval` — privileged relay transport; it never mints,
   chooses, validates, or approves a code.
3. `submitSesEchoCodeApprovalAction` — verifies request identity, enrolled
   sender, exact message hash, expiry, single-use state, and sender lockout.
4. `approveSesInvoiceRevisionAction` — the unchanged downstream approval gate
   called after echo-code verification.
5. The cockpit approval route — unchanged control path and unchanged money
   fence; it is not coupled to text approval.
6. SEND IT. The **cockpit** SEND IT route (`approve_ses_release_revision` /
   `execute_ses_release_revision`) is unchanged. The **text** SEND IT route
   shipped as Harden SES ticket 07 is REMOVED: `submit_ses_channel_approval`
   no longer binds `executeSesChannelSendIt`, refuses `send_it` with
   `channel_send_not_supported` (409), and the echo-code verifier refuses any
   non-`approve_invoice` message before that point. `ses_channel_send_it.ts`
   therefore has no production call site and is covered only by its own unit
   tests; the dead `index.ts` import is removed. Re-wiring text SEND IT behind
   its own echo-code request is a NAMED FOLLOW-UP and requires the Captain's
   word — do not restore it as a side effect of another slice.
7. `ses_channel_enrolment` — unchanged and deliberately last; it is not called
   by issuance or verification and no identity is enrolled by this slice.

The old TOTP submit implementation remains only as legacy module code for its
pure helper tests; no production route imports or dispatches it. The production
text route dispatches only `submitSesEchoCodeApprovalAction`, so TOTP is not a
second approval door.

## Storage and limits

The only schema change is the authorised
`ses_channel_approval_attempts` attempt-limit table. Request rows contain the
server-generated request identity, enrolled sender fingerprint, exact message
hash, HMAC-protected code hash, expiry, and consumed timestamp. Lockout rows
contain sender-scoped failure state, so a fresh request cannot reset it.

The table IS the single-use and lockout invariant, so it carries RLS, a
service-role-only `FOR ALL` policy, and a table-level revoke from `PUBLIC`,
`anon` and `authenticated`. Without those, an anon PostgREST `UPDATE` clearing
`consumed_at` would make an observed approval message replayable and deleting a
lockout row would restore unlimited guessing. Both SECURITY DEFINER doors raise
rather than proceed if the sender's lockout row is absent, so a deleted counter
fails closed instead of silently no-opping the increment. The manifest entries
in `scripts/edge-function-schema-requirements.txt` make the deploy lane refuse
an `ops-api` deploy that lands ahead of the migration.

Codes are six digits from `crypto.getRandomValues`, independent of all request
inputs. They expire after **10 minutes**, which is short enough to limit a
transport leak while allowing ordinary message delay. A sender is locked after
**3 failed requests** for **15 minutes**. The window is bounded so a captain
can recover without intervention; after it expires, a new request may be
issued. A successful verification clears the sender's failure counter.

The code appears only in the issuance transport envelope's generated message.
It is not returned by read paths, persisted in plaintext, logged, or included
in refusal facts.

Verification consumes the request before returning a pass or fail on the
message or code, so a wrong guess always spends its own request. A **sender
mismatch is the deliberate exception** (Captain ruling, 2026-08-08): a sender
that is not the enrolled sender the request was issued to is refused as a
security event, consumes nothing, and increments no failure counter for either
party. Otherwise a caller holding only the relay key could spend the captain's
pending requests and lock him out of both doors for 15 minutes. Identity is
therefore settled first at both layers: an unenrolled sender refuses
`channel_sender_not_bound` before the database is touched at all, and a
different *enrolled* sender refuses `echo_code_sender_mismatch` from the
consume function before it consumes or counts.

Issuance additionally refuses `echo_code_card_reference_unusable` when the
card's number cannot be composed into one unambiguous approval message the
verifier can read back, so no request is persisted and no code is transported
that could never verify.

## Adversarial proof — watched failures

The hostile suite is
`supabase/functions/ops-api/ses_echo_code_approval_test.ts`. I watched each
attack fail:

- A valid code from an **unenrolled sender** failed with
  `channel_sender_not_bound`, and the pending request was not consumed.
- **Repeated mismatched-sender attempts** — six unenrolled and six
  different-enrolled-operator attempts against one pending request — failed
  with `channel_sender_not_bound` and `echo_code_sender_mismatch`, left the
  failure counter at zero, left the lockout unset, left the request unconsumed,
  and the captain's own correct verification then still succeeded.
- A valid code against a **different request** failed with
  `echo_code_invalid`, and the target request was consumed.
- A **reused code** failed with `echo_code_already_used` after the first
  verification succeeded.
- **Wrong guesses** failed three times and the third failure produced
  `echo_code_sender_locked`.
- **Fresh-code lockout bypass** failed: after the third failed request, issuing
  another request produced `echo_code_sender_locked` rather than a new code.
- A changed message failed with `echo_code_invalid`, and replaying the issued
  request then failed with `echo_code_already_used`.
- A wrong first verification spent the request; a later correct retry failed
  with `echo_code_already_used`.

## Captain experience while locked out

After three failed requests, new approval requests and verification attempts
are refused for 15 minutes. The captain waits for that cooling-off window, then
requests a fresh code and uses its exact generated message. A successful
verification clears the failure counter. No enrolment or approval was executed
by this work.

## Verification run

Fresh local evidence:

- `deno check supabase/functions/ops-api/ses_echo_code_approval.ts`
- `deno check supabase/functions/ops-api/index.ts`
- `deno test --no-check supabase/functions/ops-api/ses_echo_code_approval_test.ts`
  — 11 passed, including all six watched attack failures, the relay-authority
  refusal, and the unusable-card-reference issuance refusal.

Deployment confirmation, production secret configuration, captain enrolment,
and a live approval remain Tier 2 until the merged PR is deployed and the
Captain explicitly performs the enrolment procedure. No client names, phone
numbers, emails, or street addresses are included here.
