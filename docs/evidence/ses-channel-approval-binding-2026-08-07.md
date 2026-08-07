# Approving from WhatsApp: what the identity binding actually trusts

**Date:** 2026-08-07
**Code:** `supabase/functions/ops-api/ses_channel_approval.ts`
**Tests:** `supabase/functions/ops-api/ses_channel_approval_test.ts` (32 probes)
**Actions:** `submit_ses_channel_approval`, `ses_channel_enrolment`
**Migration:** none. Deliberately — see §6.

## 1. The ask and the gate

The Captain asked to approve over text and WhatsApp as well as through the UI.

`canRecordSesApproval` (`ses_review_cockpit.ts`) refuses every machine caller:

> Human approval requires an identified SES operator session; API keys and
> automation keys cannot approve.

That gate is correct and this work does not touch it. `canRecordSesApproval`,
`record_ses_revision_approval_v1` and `approveSesInvoiceRevisionAction` are
byte-identical to before. What is added is a **second way to genuinely satisfy
it**, and a pinned test asserts the old refusals still fire.

## 2. What the binding trusts — stated, not implied

An approval is accepted only when **three independent things** hold. Each is
necessary; none is sufficient.

| # | Factor | What it proves | Where it lives |
|---|--------|----------------|----------------|
| 1 | **Transport** — the relay presents the ops key | that the caller is the relay | `x-api-key`, existing |
| 2 | **Possession** — the sender fingerprints to an enrolled binding | that the message came from his WhatsApp identity | `SES_CHANNEL_APPROVAL_BINDINGS` function secret |
| 3 | **Knowledge** — the message carries a live RFC 6238 code | that whoever sent it holds his authenticator seed | derived, never stored |

Factor 3 is the one that binds the act to **him** rather than to a channel. The
seed is not stored anywhere: it is derived on demand from
`SES_CHANNEL_APPROVAL_ROOT_SECRET` plus the binding, and the only way to obtain
it is `ses_channel_enrolment`, which requires **his own** authenticated Supabase
session for **that same user id**. An admin cannot read another operator's seed.
The ops key cannot read any seed at all — otherwise the key would become
approval authority by the back door.

### What someone holding each thing could do

| Holds | Can do |
|-------|--------|
| The ops key alone | **Nothing new.** Still refused at the gate, exactly as today. |
| His phone / WhatsApp alone | **Nothing** — unless his authenticator app is on that same phone. See (a) below. |
| His authenticator seed alone | Nothing. The message must also arrive from the enrolled sender. |
| Ops key + enrolled sender + a live code | APPROVE INVOICE on a card **that is already approvable in the cockpit**. Never a card the cockpit would refuse. |
| The root secret, plus the ability to write the binding secret | Mint codes for any operator. This is the strongest single point of failure and is equivalent to holding the Supabase project itself. |

## 3. This is weaker than a cockpit session. Named, not hidden.

The Captain can accept a known weaker binding as a deliberate trade. He cannot
accept one he was not told about. So, plainly:

- **(a) Same-device collapse.** If the authenticator app lives on the phone that
  holds WhatsApp, factors 2 and 3 are one factor, not two, and an attacker with
  the unlocked phone can approve. A cockpit press additionally needs the
  Supabase account credential, which is not on the phone. Putting the
  authenticator on a second device restores the separation. **This code cannot
  enforce or even detect which device holds the authenticator.** It is an
  operator choice, and it is the single biggest difference from a cockpit press.
- **(b) Relay-asserted sender.** We trust the relay's claim about who sent the
  message; WhatsApp gives us no way to verify it cryptographically. A
  compromised relay still cannot approve (it has no code), but it can mislabel
  which enrolled operator acted.
- **(c) No session revocation UX.** Revocation is removing the binding from the
  function secret, not clicking "sign out".

Net: **for an attacker who has physically taken his unlocked phone, this path is
weaker than the cockpit.** For every other attacker — including one holding the
ops key, the service key, or the relay — it is not weaker, because none of them
can produce a code.

If any of that stops being acceptable, delete the binding from the function
secret. The path then refuses everything and the cockpit is unaffected.

## 4. The five non-negotiable properties

- **Idempotent.** The operator act — his message id — is written into the
  approval row's `evidence_refs` and re-read before every approval. The same
  message refuses with `channel_message_already_recorded`. A second, independent
  coordinate (the consumed TOTP time step) refuses a *different* message reusing
  a still-valid code, as `channel_code_already_used`.
- **Auditable.** `sesChannelOperatorActRef` records channel, **message id**,
  sender fingerprint, operator user id, act, card reference, consumed time step
  and message send time, on the approval row itself. "Approved via WhatsApp"
  without a message id is never written. The raw sender id is hashed before
  anything else happens and never lands in a row, a log or a refusal payload.
- **Scoped.** Exactly one card reference must be present and must resolve to
  exactly one job. Zero, two, an unknown reference or an ambiguous one all
  refuse.
- **Refusable.** The path changes *who may approve*, never *what may be
  approved*. The resolved operator is handed to the same
  `approveSesInvoiceRevisionAction` a cockpit press calls, so the mechanical
  clean verdict, the cockpit control gate, the synthetic live-fire fence and the
  `ses_release_operators` allowlist inside the RPC all run unchanged. A pinned
  test proves a downstream refusal passes through untouched.
- **Fail-closed.** Every branch refuses on doubt: unconfigured, unsupported
  channel, unbound sender, missing message id, missing or unreadable timestamp,
  a message outside the ±15 minute freshness window, two command words, no
  recognised command word, an act that is recognised but not wired, zero or two
  cards, two candidate codes, a missing or invalid code, a spent message, a
  spent code, a binding naming a missing account, and an **unreadable replay
  guard** (503 rather than "probably not a repeat").

Two parsing traps are pinned by name because both would have been silent:

- A card number ends in six digits (`SWMS-261081` → `261081`), so card
  references are stripped **before** the code is scanned for. Otherwise a
  message with no code at all would have carried its own card number as one.
- An email-shaped sender containing digits must not normalise as a phone number.

## 5. The one residual gap

`SES_CHANNEL_APPROVAL_REPLAY_RACE`: the replay guard is a read-then-write over
`evidence_refs`, not a database uniqueness constraint, so two byte-identical
messages delivered concurrently could both pass it. The blast radius is bounded
to a **duplicate approval row, never duplicate money** —
`execute_ses_invoice_revision` and every release send are exact-once through
`ses_external_effects`. Closing it properly needs a uniquely-indexed message
ledger, which is a migration, which this slice deliberately did not take.

## 6. Why there is no migration

The brief required naming any migration before taking one. None was needed:

- the binding lives in an Edge Function secret (a project-owner write),
- the authenticator seed is **derived**, not stored,
- the act ledger is the existing append-only
  `makesafe_revision_approvals.evidence_refs` column, queried by jsonb
  containment.

## 7. Scope actually delivered

`APPROVE INVOICE` only. `SEND` is **recognised and refused by name**
(`channel_act_not_enabled`) rather than silently ignored or half-executed, so a
SEND message gets a clear answer instead of nothing. Wiring SEND is the natural
next slice and needs no change to the identity model.

**The relay is not built here.** This is the ops-api half: one authenticated
POST of `{channel, sender_id, message_id, message_text, message_sent_at}`.
Whatever already receives his messages (the GHL inbound webhook, or the JARVIS
agent) can call it. That split is deliberate and safe *because* the relay holds
no authority — it is the whole point of factor 3 — so the relay can be added
later without revisiting the security model.

## 8. First proof: his two real approvals were NOT executed

His approval for Mindarie `SWMS-261081` / `INV-1150` and White Gum Valley
`SWMS-261114` / `INV-1149` is on record in his own chat. This path did **not**
execute them, and that is the correct outcome, not a shortfall.

**Why, precisely — four independent reasons, any one of which is sufficient:**

1. **No binding is enrolled.** `SES_CHANNEL_APPROVAL_BINDINGS` is unset in
   production, so every call refuses `channel_binding_not_configured`.
   Enrolling it requires a project owner to write the secret *and* the Captain
   to authenticate as himself and load the seed into an authenticator. Neither
   has happened.
2. **Forcing it would have meant fabricating his identity proof.** Writing the
   binding and minting a code from the root secret myself is exactly the
   "fabricate the binding to get there" the brief forbids — it would be me
   producing factor 3 on his behalf, which makes the whole binding a fiction.
3. **His actual message refuses on its own merits**, three times over: it names
   two cards (`channel_card_reference_ambiguous`), carries no code
   (`channel_code_missing`), and is far outside the freshness window
   (`channel_message_stale`). A test pins this against his real wording.
4. **This branch is not deployed.** ops-api is live at v1070; deploying is a
   separate gated act under the production edge deploy rule.

**So both cards wait for his cockpit press — and that press is genuinely two
seconds.** Measured read-only on 2026-08-07, both cards are:

| Card | Invoice | Cockpit status | `approve_invoice` | Verdict |
|------|---------|----------------|-------------------|---------|
| `SWMS-261081` | `INV-1150` DRAFT $330 inc | `INVOICE_CREATE_READY` | **enabled**, no disabled reason | clean, band `shaun_clean`, zero blockers |
| `SWMS-261114` | `INV-1149` DRAFT $330 inc | `INVOICE_CREATE_READY` | **enabled**, no disabled reason | clean, band `shaun_clean`, zero blockers |

`send_it` is correctly disabled on both with "The bound Xero invoice is DRAFT,
not AUTHORISED" — that clears once the approved revision is executed.

This is also the sharpest available proof that the path changes *who*, not
*what*: an enrolled channel message would have reached exactly the same
already-enabled control on exactly these two cards.

A rushed authority path is worse than two manual clicks.

## 9. Enrolling it (when he wants it live)

1. A project owner computes his sender fingerprint with
   `sesChannelSenderFingerprint(channel, sender_id)` — the raw number is used
   once, locally, and never committed or stored.
2. Set the two Edge Function secrets:
   - `SES_CHANNEL_APPROVAL_BINDINGS` =
     `[{"channel":"whatsapp","sender_fingerprint":"<64 hex>","operator_user_id":"<his users.id>","label":"captain"}]`
   - `SES_CHANNEL_APPROVAL_ROOT_SECRET` = a fresh high-entropy value.
3. **He** signs into the cockpit and calls `ses_channel_enrolment`, which
   returns an `otpauth://` URI for his own binding only. He scans it into an
   authenticator app — **ideally not the phone that holds WhatsApp** (§3a).
4. He then messages, from that WhatsApp identity:
   `APPROVE SWMS-261081 123456`

Rotating `SES_CHANNEL_APPROVAL_ROOT_SECRET` invalidates every seed at once.
Removing his entry from the bindings secret revokes the path entirely.
