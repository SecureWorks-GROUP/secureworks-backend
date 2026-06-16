// Wave 3 - makesafe_draft_notes pure-helper tests.
//
// The load-bearing invariant proven here is NAMESPACE ISOLATION: an agent reply
// note (AGENT_REPLY_PREFIX) and a pack-sent send-marker (PACK_SENT_MARKER_PREFIX)
// can NEVER be confused for one another. A note body that is a pack-sent marker is
// rejected; an agent reply note is not a pack-sent marker; and the two prefixes
// share no common prefix.
//
// All tests are pure: NO network, NO Supabase, NO Xero.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_draft_notes_test.ts
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AGENT_REPLY_PREFIX,
  PACK_SENT_MARKER_PREFIX,
  isAgentReplyNote,
  isPackSentMarker,
  rejectIfPackSentMarker,
  buildAgentReplyBody,
  noteIsAddressable,
} from "./makesafe_draft_notes.ts";

// ─────────────────────────────────────────────────────────────────
// 0. Prefix contract — pin the literal strings (other modules + the DB
//    trigger depend on these exact values).
// ─────────────────────────────────────────────────────────────────
Deno.test("prefixes are the pinned literals", () => {
  assertEquals(AGENT_REPLY_PREFIX, "MAKESAFE_AGENT_REPLY |");
  assertEquals(PACK_SENT_MARKER_PREFIX, "MAKESAFE_PACK_SENT");
});

// ─────────────────────────────────────────────────────────────────
// 1. isAgentReplyNote — true for prefixed, false for plain, false for a
//    pack-sent marker.
// ─────────────────────────────────────────────────────────────────
Deno.test("isAgentReplyNote: true for prefixed, false otherwise", () => {
  assert(isAgentReplyNote("MAKESAFE_AGENT_REPLY | re-rendered the report"));
  assert(isAgentReplyNote(AGENT_REPLY_PREFIX));
  assertEquals(isAgentReplyNote("please widen the scope line"), false);
  assertEquals(isAgentReplyNote("MAKESAFE_PACK_SENT | main | INV-1"), false);
  assertEquals(isAgentReplyNote(""), false);
});

// ─────────────────────────────────────────────────────────────────
// 2. isPackSentMarker — true for the marker prefix, false for an agent reply.
// ─────────────────────────────────────────────────────────────────
Deno.test("isPackSentMarker: true for MAKESAFE_PACK_SENT, false for agent reply", () => {
  assert(isPackSentMarker("MAKESAFE_PACK_SENT"));
  assert(isPackSentMarker("MAKESAFE_PACK_SENT | main | INV-1234 | to=builder"));
  assertEquals(isPackSentMarker("MAKESAFE_AGENT_REPLY | done"), false);
  assertEquals(isPackSentMarker("a normal human note"), false);
  assertEquals(isPackSentMarker(""), false);
});

// ─────────────────────────────────────────────────────────────────
// 3. rejectIfPackSentMarker — throws on a pack-sent marker, does NOT throw
//    on an agent reply note (or a plain note).
// ─────────────────────────────────────────────────────────────────
Deno.test("rejectIfPackSentMarker throws on a pack-sent marker", () => {
  assertThrows(
    () => rejectIfPackSentMarker("MAKESAFE_PACK_SENT | main | INV-1"),
    Error,
    "note body must not be a pack-sent marker",
  );
  assertThrows(
    () => rejectIfPackSentMarker("MAKESAFE_PACK_SENT"),
    Error,
    "note body must not be a pack-sent marker",
  );
});

Deno.test("rejectIfPackSentMarker does NOT throw on an agent reply or plain note", () => {
  // Should not throw — no assertion failure means pass.
  rejectIfPackSentMarker("MAKESAFE_AGENT_REPLY | re-rendered in response to your note");
  rejectIfPackSentMarker("please fix the address on the report");
  rejectIfPackSentMarker(buildAgentReplyBody("anything"));
});

// ─────────────────────────────────────────────────────────────────
// 4. buildAgentReplyBody — prefixes correctly and the result is an agent
//    reply note that is NOT a pack-sent marker.
// ─────────────────────────────────────────────────────────────────
Deno.test("buildAgentReplyBody prefixes the change description", () => {
  const body = buildAgentReplyBody("widened the fence-hire line to 6 weeks");
  assertEquals(body, "MAKESAFE_AGENT_REPLY | widened the fence-hire line to 6 weeks");
  assert(isAgentReplyNote(body));
  assertEquals(isPackSentMarker(body), false);
});

Deno.test("buildAgentReplyBody tolerates empty/whitespace descriptions", () => {
  assertEquals(buildAgentReplyBody(""), "MAKESAFE_AGENT_REPLY |");
  assertEquals(buildAgentReplyBody("   "), "MAKESAFE_AGENT_REPLY |");
  // Even an empty description never produces a pack-sent marker.
  assertEquals(isPackSentMarker(buildAgentReplyBody("")), false);
});

// ─────────────────────────────────────────────────────────────────
// 5. noteIsAddressable — true for human+unaddressed, false for agent, false
//    for an addressed human note.
// ─────────────────────────────────────────────────────────────────
Deno.test("noteIsAddressable: only human + unaddressed", () => {
  assert(noteIsAddressable({ role: "human", addressed: false }));
  assertEquals(noteIsAddressable({ role: "agent", addressed: false }), false);
  assertEquals(noteIsAddressable({ role: "human", addressed: true }), false);
  assertEquals(noteIsAddressable({ role: "agent", addressed: true }), false);
});

// ─────────────────────────────────────────────────────────────────
// 6. NAMESPACE ISOLATION — the two prefixes share no common prefix, so a
//    reply note can never be mistaken for a send-marker (and vice versa).
// ─────────────────────────────────────────────────────────────────
Deno.test("AGENT_REPLY_PREFIX and PACK_SENT_MARKER_PREFIX share no common prefix", () => {
  // Neither prefix is a prefix of the other.
  assertEquals(AGENT_REPLY_PREFIX.startsWith(PACK_SENT_MARKER_PREFIX), false);
  assertEquals(PACK_SENT_MARKER_PREFIX.startsWith(AGENT_REPLY_PREFIX), false);

  // They diverge before either ends: find the first differing char index and
  // assert it is strictly less than both lengths (i.e. a real divergence, not
  // one being a truncation of the other).
  let i = 0;
  const min = Math.min(AGENT_REPLY_PREFIX.length, PACK_SENT_MARKER_PREFIX.length);
  while (i < min && AGENT_REPLY_PREFIX[i] === PACK_SENT_MARKER_PREFIX[i]) i++;
  assert(
    i < min,
    `prefixes must diverge within their shared length; matched ${i} chars`,
  );
  // Sanity: the shared run is just the "MAKESAFE_" stem, nothing more.
  assertEquals(AGENT_REPLY_PREFIX.slice(0, i), PACK_SENT_MARKER_PREFIX.slice(0, i));
  assertEquals(AGENT_REPLY_PREFIX.slice(0, i), "MAKESAFE_");

  // And the cross-check holds on real bodies built from each.
  const reply = buildAgentReplyBody("done");
  assertEquals(isPackSentMarker(reply), false);
  assertEquals(isAgentReplyNote("MAKESAFE_PACK_SENT | main"), false);
});
