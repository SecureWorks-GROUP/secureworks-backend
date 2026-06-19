// MakeSafe Reporting Autopilot (Wave 3) -- pure, testable building blocks for the
// threaded draft-feedback loop (draft_notes). NO network, NO Supabase, NO Xero.
// The orchestration (index.ts: addDraftNote / listDraftNotes / rerunDraftReport)
// imports these and supplies the live client.
//
// NAMESPACE ISOLATION is the load-bearing invariant here. Two distinct strings
// must never be confusable:
//   AGENT_REPLY_PREFIX      'MAKESAFE_AGENT_REPLY |'  -- a routine's reply NOTE
//   PACK_SENT_MARKER_PREFIX 'MAKESAFE_PACK_SENT'      -- the SEND breadcrumb (business_events)
// A reply note must never look like a send-marker, and a send-marker must never be
// writable as a note body. The two prefixes share no common prefix
// ('MAKESAFE_AGENT...' vs 'MAKESAFE_PACK...'), which the test pins explicitly.

// All agent reply notes begin with this. The trailing ' |' separates the prefix
// from the change description in buildAgentReplyBody.
export const AGENT_REPLY_PREFIX = "MAKESAFE_AGENT_REPLY |";

// The forbidden prefix for ANY note body. A pack-sent marker is the irreversible
// "this pack was emailed" breadcrumb written by makesafe_send_pack; it must never
// be confusable with a draft note. add_draft_note rejects (400) on this prefix.
export const PACK_SENT_MARKER_PREFIX = "MAKESAFE_PACK_SENT";

// True iff the body is an agent reply note (begins with AGENT_REPLY_PREFIX).
export function isAgentReplyNote(body: string): boolean {
  return typeof body === "string" && body.startsWith(AGENT_REPLY_PREFIX);
}

// True iff the body is (or begins with) a pack-sent marker. The forbidden shape.
export function isPackSentMarker(body: string): boolean {
  return typeof body === "string" && body.startsWith(PACK_SENT_MARKER_PREFIX);
}

// Throws if the body is a pack-sent marker. The single enforcement point both the
// add_draft_note action (caller-facing 400) and rerun_draft_report (defensive
// self-check) call. Any non-string is treated as not-a-marker (the insert layer
// validates presence/trim separately).
export function rejectIfPackSentMarker(body: string): void {
  if (isPackSentMarker(body)) {
    throw new Error("note body must not be a pack-sent marker");
  }
}

// Prefix a human-readable change description with AGENT_REPLY_PREFIX so every
// routine reply note is uniformly identifiable in the thread. Always produces a
// string that is an agent reply note and is NEVER a pack-sent marker (the two
// prefixes are disjoint), so it is safe to pass through rejectIfPackSentMarker.
export function buildAgentReplyBody(changeDescription: string): string {
  return `${AGENT_REPLY_PREFIX} ${String(changeDescription ?? "").trim()}`
    .trim();
}

// The filter the routine uses to find the notes it MUST reply to: a human note
// that has not yet been addressed. Agent notes are never addressable; an addressed
// human note is done.
export function noteIsAddressable(
  note: { role: string; addressed: boolean },
): boolean {
  return !!note && note.role === "human" && note.addressed === false;
}

// Test-only aliases (mirror the `_`-prefixed convention in the sibling modules).
export const _isAgentReplyNote = isAgentReplyNote;
export const _isPackSentMarker = isPackSentMarker;
export const _rejectIfPackSentMarker = rejectIfPackSentMarker;
export const _buildAgentReplyBody = buildAgentReplyBody;
export const _noteIsAddressable = noteIsAddressable;
