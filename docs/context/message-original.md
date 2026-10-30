# Open the original (CTX-T23)

Design AC-M6: each message card on the Matching screen has "Open the
original", a read-only view of the whole message and its attachments; a call
card shows its duration, the words "Call words are not shown here", and where
to listen.

## The door

`GET ops-api?action=context_message_original&event_id=<business_events.id>`

Staff front door only (admin, owner, ops manager, or the server key). A trade,
a lead installer and a division manager are refused 403. GET only. It writes
nothing, places nothing and records no decision. Code:
`supabase/functions/ops-api/context_message_original.ts`.

`event_id` is the card's `subject_id` when `subject_kind` is `event`.

## The answer

Every answer: `event_id`, `kind` (`email`, `text`, `call`, `other`),
`event_type`, `direction`, `at` (the message's own time, else the capture
time, said by `at_source`). Legacy cache imports instead use the retained
original CRM time; absent time is `at: null, at_source: unknown`. A lookup
failure returns500 `message_time_read_failed` and never a load-clock substitute, `read_only: true`.

- **call** (a call row or a call transcript row): `call.duration_seconds`,
  `status`, `line`, `from_line`, `is_transcript_row`, `words_shown: false`,
  `words_note` ("Call words are not shown here."), `where_to_listen` (the
  contact's conversation in GoHighLevel). No field ever carries call words,
  the transcript or the stored preview.
- **text**: `text.body` (the whole text), `body_source` (`message`, or
  `preview_only` on an older row that kept only the preview), `line`,
  `from_line`, `sent_by_kind`.
- **email**: `email.subject`, `from`, `to[]`, `cc[]`, `mailbox`, `body` (the
  words the reader kept: the "Subject:" line, then the new words, cut at
  20,000 characters with `body_truncated` and `body_chars_total`),
  `forwarded_correspondence`, `forwarded_truncated`; and `attachments`:
  - `read: 'ok'`: `items[]` from the reader's ledger
    (`context_email_attachments`, keyed by the email's provider id), each with
    `file_name`, `content_type`, `size_bytes`, `saved`, `status`,
    `status_words` (why it was or was not saved, in plain words) and
    `error_code` on a failed read. A copy of a file already listed
    (`skipped_duplicate`) is counted in `copies_not_listed`, not listed.
    `more_not_listed` is true when the email holds more than 200 ledger rows.
  - `read: 'failed'`: the ledger could not be read; `items` is null, never an
    empty list.
  - `read: 'none'`: the email was not read by the email reader, so it has no
    file list.
  - Always `on_message` (the file count on the row), `files: 'not_available'`
    and `files_note`.
- **other**: `other.body`, `body_source`.

Errors: 400 `invalid_request` (not a message id), 404 `message_not_found`, 500
`message_read_failed`.

## What it does not do

It serves no file bytes and makes no link to a file. Saved files sit in the
PRIVATE bucket `context-email-attachments` (service role only). Opening one
from a staff screen is a new access to that bucket and waits on the owner's
word; until then the answer lists each file and says it cannot be opened yet.

## Candidate release boundary (31 October 2026)

This recovered1130 composition is separate from the financial release candidate.
Q27 still requires an owner decision about original personal-mailbox access;
the broad office-role route in this candidate is not authorized to deploy.
P5/R2-5 file access remains held. No file bytes or signed links are served.
Tests use synthetic messages, not personal mail. Historical isolated review
of1130 does not cover this composition or its source-time correction.
