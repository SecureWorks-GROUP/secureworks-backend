// Group mailbox audience (9 Oct 2026): who our own email went to. A group post
// lists no recipients, so a reply our staff posted in a builder's or a
// customer's thread in a group mailbox was saved as internal. Now its thread
// decides, and with no outside party there the audience is unknown, never
// internal (outlook_mail.ts, groupThreadParty, withGroupThread).
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutlookMailRow,
  groupThreadParty,
  type OutlookCaptureContext,
  type OutlookMailItem,
  type OutlookSource,
  UNKNOWN_AUDIENCE_EVENT,
  withGroupThread,
} from "./outlook_mail.ts";
import {
  ADMIN,
  E_FORWARD_SENT,
  E_OUR_REPLY_SENT,
  FINANCE,
  MARNIN,
  P_BUILDER,
  P_OUR_ALONE,
  P_OUR_REPLY,
  SES,
} from "./outlook_mail_fixtures.ts";

const CTX: OutlookCaptureContext = {
  source: "outlook-mail-capture",
  captureMode: "live",
  supplierDomains: new Set(["steelsupply.example"]),
};

function row(item: OutlookMailItem, source: OutlookSource, ctx = CTX) {
  const b = buildOutlookMailRow(item, source, ctx);
  if (b.kind !== "row") throw new Error(`skipped: ${b.reason}`);
  return b.row as Record<string, unknown> & {
    payload: Record<string, unknown>;
  };
}

/** One post as the reader hands it to the builder: with its whole thread. */
function inThread(post: OutlookMailItem, thread: OutlookMailItem[]) {
  const listed = withGroupThread(thread);
  const found = listed.find((p) => p.graphId === post.graphId);
  if (!found) throw new Error("post not in its thread");
  return found;
}

Deno.test("a reply we post in a builder's thread in a group goes to the builder, outbound, its audience from the thread", () => {
  const r = row(inThread(P_OUR_REPLY, [P_BUILDER, P_OUR_REPLY]), SES);
  assertEquals(r.event_type, "client.email_out");
  assertEquals(r.direction, "outbound");
  assertEquals(r.payload.email, "coordinator@builder.example");
  assertEquals(r.payload.audience_basis, "group_thread");
  // The row still says what Graph gave: no recipients, read from the group.
  assertEquals(r.payload.to, []);
  assertEquals(r.payload.cc, []);
  assertEquals(r.payload.folder_kind, "group");
  assertEquals(r.payload.sender_kind, "ours");
  assertEquals(r.event_at, "2026-10-01T02:00:00Z");
});

Deno.test("our group post with no outside party in its thread is unknown audience, outbound with no counterpart, never internal", () => {
  const alone = row(inThread(P_OUR_ALONE, [P_OUR_ALONE]), FINANCE);
  assertEquals(alone.event_type, UNKNOWN_AUDIENCE_EVENT);
  assertEquals(UNKNOWN_AUDIENCE_EVENT, "staff.email_unknown_audience");
  assertEquals(alone.direction, "outbound");
  assertStrictEquals(alone.payload.email, null);
  assertEquals(alone.payload.audience_basis, "unknown");
  // A thread of only our own posts (a colleague's earlier one) names no outside party either.
  const colleague: OutlookMailItem = {
    ...P_OUR_REPLY,
    graphId: "AAMkAGGmaColleague06=",
    from: "nithin@secureworkswa.com.au",
    receivedAt: "2026-10-01T01:30:00Z",
  };
  const ours = row(inThread(P_OUR_REPLY, [colleague, P_OUR_REPLY]), SES);
  assertEquals(ours.event_type, UNKNOWN_AUDIENCE_EVENT);
  // A post handed over with no thread at all (an older reader) is unknown too.
  const bare = row({ ...P_OUR_REPLY, threadPosts: undefined }, SES);
  assertEquals(bare.event_type, UNKNOWN_AUDIENCE_EVENT);
  assertEquals(bare.payload.audience_basis, "unknown");
  for (const r of [alone, ours, bare]) {
    assert(r.event_type !== "staff.email_internal");
    assert(r.direction !== "internal");
  }
});

Deno.test("the thread's party: the newest outside sender at or before our post, else the earliest after it", () => {
  const at = (graphId: string, from: string, receivedAt: string) => ({
    graphId,
    from,
    receivedAt,
  });
  const ours = { ...P_OUR_REPLY }; // 2026-10-01T02:00:00Z
  const party = (threadPosts: ReturnType<typeof at>[]) =>
    groupThreadParty({ ...ours, threadPosts }, CTX.supplierDomains);
  // Two outside senders before ours: the newer one.
  assertEquals(
    party([
      at("a", "first@builder.example", "2026-10-01T00:00:00Z"),
      at("b", "Second Person <second@builder.example>", "2026-10-01T01:30:00Z"),
      at("c", "later@builder.example", "2026-10-01T03:00:00Z"),
    ]),
    "second@builder.example",
  );
  // The same instant as ours counts as before it.
  assertEquals(
    party([at("a", "same@builder.example", "2026-10-01T02:00:00Z")]),
    "same@builder.example",
  );
  // None before: the earliest after (we wrote first; they answered in the thread).
  assertEquals(
    party([
      at("a", "late@builder.example", "2026-10-02T00:00:00Z"),
      at("b", "early@builder.example", "2026-10-01T05:00:00Z"),
    ]),
    "early@builder.example",
  );
  // A tie goes to the address that sorts first, whatever the list order.
  assertEquals(
    party([
      at("a", "zed@builder.example", "2026-10-01T01:00:00Z"),
      at("b", "amy@builder.example", "2026-10-01T01:00:00Z"),
    ]),
    "amy@builder.example",
  );
  // A supplier and a council are outside parties.
  assertEquals(
    party([at("a", "orders@steelsupply.example", "2026-10-01T01:00:00Z")]),
    "orders@steelsupply.example",
  );
  assertEquals(
    party([at("a", "planning@council.wa.gov.au", "2026-10-01T01:00:00Z")]),
    "planning@council.wa.gov.au",
  );
  // Never our own people, automated mail, a platform, an undated post or the post itself.
  assertStrictEquals(
    party([
      at("a", "nithin@secureworkswa.com.au", "2026-10-01T01:00:00Z"),
      at("b", "no-reply@portal.example", "2026-10-01T01:10:00Z"),
      at("c", "messaging-service@post.xero.com", "2026-10-01T01:20:00Z"),
      at("d", "undated@builder.example", ""),
      at("e", "not an address", "2026-10-01T01:30:00Z"),
      at(ours.graphId, "coordinator@builder.example", "2026-10-01T01:40:00Z"),
    ]),
    null,
  );
  // No thread: none.
  assertStrictEquals(groupThreadParty({ ...ours }), null);
});

Deno.test("withGroupThread hands every post of a thread the whole thread, one list, sender and time only", () => {
  const listed = withGroupThread([P_BUILDER, P_OUR_REPLY]);
  assertEquals(listed.length, 2);
  assertEquals(listed[0].threadPosts, [
    {
      graphId: P_BUILDER.graphId,
      from: P_BUILDER.from,
      receivedAt: P_BUILDER.receivedAt,
    },
    {
      graphId: P_OUR_REPLY.graphId,
      from: P_OUR_REPLY.from,
      receivedAt: P_OUR_REPLY.receivedAt,
    },
  ]);
  assertStrictEquals(listed[0].threadPosts, listed[1].threadPosts);
  // Everything else on the post is as listed.
  assertEquals({ ...listed[1], threadPosts: undefined }, {
    ...P_OUR_REPLY,
    threadPosts: undefined,
  });
  assertEquals(withGroupThread([]), []);
});

Deno.test("a mailbox copy's own recipients decide: an outside one is outbound, only ours is internal, none recorded is unknown", () => {
  const sent = row(E_OUR_REPLY_SENT, ADMIN);
  assertEquals(sent.event_type, "client.email_out");
  assertEquals(sent.direction, "outbound");
  assertEquals(sent.payload.email, "coordinator@builder.example");
  assertEquals(sent.payload.to, ["coordinator@builder.example"]);
  assertEquals(sent.payload.cc, ["ses@secureworkswa.com.au"]);
  assert(!("audience_basis" in sent.payload));
  // The same email's group copy and mailbox copy are one key.
  assertEquals(
    sent.provider_message_id,
    row(inThread(P_OUR_REPLY, [P_BUILDER, P_OUR_REPLY]), SES)
      .provider_message_id,
  );
  // Sent to our own group only: internal, as before.
  const forward = row(E_FORWARD_SENT, ADMIN);
  assertEquals(forward.event_type, "staff.email_internal");
  assertEquals(forward.direction, "internal");
  assertStrictEquals(forward.payload.email, null);
  assert(!("audience_basis" in forward.payload));
  // A mailbox copy with no recipients recorded: unknown (no thread is read for a mailbox).
  const none = row({ ...E_FORWARD_SENT, to: [], cc: [] }, ADMIN);
  assertEquals(none.event_type, UNKNOWN_AUDIENCE_EVENT);
  assertEquals(none.direction, "outbound");
  assertEquals(none.payload.audience_basis, "unknown");
  // A thread handed to a mailbox copy is never read: its recipients decide.
  const withThread = row(
    { ...E_FORWARD_SENT, threadPosts: withGroupThread([P_BUILDER])[0].threadPosts },
    ADMIN,
  );
  assertEquals(withThread.event_type, "staff.email_internal");
});

Deno.test("someone else's post in a group keeps its label and carries no audience basis", () => {
  const r = row(inThread(P_BUILDER, [P_BUILDER, P_OUR_REPLY]), SES);
  assertEquals(r.event_type, "client.email_in");
  assertEquals(r.direction, "inbound");
  assertEquals(r.payload.email, "coordinator@builder.example");
  assert(!("audience_basis" in r.payload));
});

Deno.test("an owner mailbox still keeps our own human mail only with job evidence, whatever its audience", () => {
  const none = {
    ...E_FORWARD_SENT,
    from: "marnin@secureworkswa.com.au",
    to: [],
    cc: [],
    subject: "Notes",
    bodyText: "For later.",
  };
  const skipped = buildOutlookMailRow(none, MARNIN, CTX);
  assertEquals(skipped.kind === "skip" && skipped.reason, "skipped_private");
  // Naming our reference keeps it, as unknown audience.
  assertEquals(
    row({ ...none, subject: "Notes SWF-990002" }, MARNIN).event_type,
    UNKNOWN_AUDIENCE_EVENT,
  );
});
