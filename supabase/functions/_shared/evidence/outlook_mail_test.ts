// Slice EM2: the email row builder's named rules (email.md §2, §3, §13a).
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BODY_MAX_CHARS,
  buildOutlookMailRow,
  cutQuotedHistory,
  emailProviderKey,
  lineFromRecipients,
  ourReferences,
  type OutlookCaptureContext,
  type OutlookMailItem,
  senderKind,
  toTag,
} from "./outlook_mail.ts";
import {
  E_DIRECT,
  E_GROUP_POST,
  E_IDENTITY,
  E_SENT,
  E_SUPPLIER,
  E_XERO,
  MARNIN,
  NITHIN,
  PATIOS,
} from "./outlook_mail_fixtures.ts";

const CTX: OutlookCaptureContext = {
  source: "outlook-mail-capture",
  captureMode: "live",
  supplierDomains: new Set(["steelsupply.example"]),
  jobClientEmails: new Set(["sam.sample@example.net"]),
};

function row(item: OutlookMailItem, source = NITHIN, ctx = CTX) {
  const b = buildOutlookMailRow(item, source, ctx);
  if (b.kind !== "row") throw new Error(`skipped: ${b.reason}`);
  return b.row as Record<string, unknown> & {
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}

Deno.test("key is the internet message id, lower case, without brackets", () => {
  assertEquals(
    emailProviderKey("<EM2-Direct-0001@mail.example.com>"),
    "email:em2-direct-0001@mail.example.com",
  );
  assertEquals(emailProviderKey("  "), null);
  assertEquals(emailProviderKey("has space@x"), null);
  assertEquals(
    row(E_DIRECT).provider_message_id,
    "email:em2-direct-0001@mail.example.com",
  );
});

Deno.test("the same email in two mailboxes is one key; no internet id falls back to the mailbox copy", () => {
  const admin = {
    ...NITHIN,
    email: "admin@secureworkswa.com.au",
    sourceKey: "admin",
  };
  assertEquals(
    row(E_DIRECT).provider_message_id,
    row({ ...E_DIRECT, graphId: "other-copy" }, admin).provider_message_id,
  );
  const noId = row({ ...E_DIRECT, internetMessageId: null });
  assertEquals(
    noId.provider_message_id,
    "graph:nithin@secureworkswa.com.au:AAMkAGEm2DirectImmutable01=",
  );
  assertEquals(noId.metadata.no_internet_id, true);
});

Deno.test("body starts with the subject; new words tidied; customer inbound", () => {
  const r = row(E_DIRECT);
  assertEquals(r.event_type, "client.email_in");
  assertEquals(r.direction, "inbound");
  assertEquals(r.channel, "email");
  assertEquals(
    r.payload.body,
    "Subject: Re: Patio quote SWP-990001 colour choice\n\nHi Nithin,\n\nWe would like Monument for the roof.\n\nThanks, Pat",
  );
  assertEquals(r.payload.email, "pat.example@example.com");
  assertEquals(r.payload.sender_kind, "customer");
  assertEquals(r.event_at, "2026-10-01T02:00:00Z");
  assertEquals(r.thread_key, "outlook:AAQkAGEm2ConvDirect01=");
  assertEquals(r.metadata.capture_mode, "live");
  assertEquals(r.job_id, null);
  assertEquals(r.match_method, "none");
  assertEquals(r.privacy_classification, "staff_only");
});

Deno.test("attachments: names, types and sizes on the row, never bytes", () => {
  const r = row(E_DIRECT);
  assertEquals(r.payload.attachments, [
    {
      name: "sketch.pdf",
      content_type: "application/pdf",
      size: 120000,
      inline: false,
      kind: "file",
    },
    {
      name: "logo.png",
      content_type: "image/png",
      size: 4000,
      inline: true,
      kind: "file",
    },
  ]);
  assertEquals(r.payload.has_attachments, true);
  assert(!JSON.stringify(r).includes("contentBytes"));
});

Deno.test("our sent reply is outbound with the customer as counterpart; internal mail is internal", () => {
  const r = row(E_SENT);
  assertEquals(r.event_type, "client.email_out");
  assertEquals(r.direction, "outbound");
  assertEquals(r.payload.email, "sam.sample@example.net");
  assertEquals(r.payload.sent_by_kind, "staff_email");
  assertEquals(r.event_at, "2026-10-01T03:30:00Z");
  const internal = row({
    ...E_SENT,
    to: ["admin@secureworkswa.com.au"],
    cc: [],
  });
  assertEquals(internal.event_type, "staff.email_internal");
  assertEquals(internal.direction, "internal");
  assertEquals(internal.payload.email, null);
});

Deno.test("supplier, council, automated and platform senders", () => {
  assertEquals(row(E_SUPPLIER).event_type, "supplier.email_in");
  assertEquals(row(E_SUPPLIER).payload.sender_kind, "supplier");
  assertEquals(
    senderKind("x@sub.steelsupply.example", {}, CTX.supplierDomains),
    "supplier",
  );
  assertEquals(senderKind("noreply@southperth.wa.gov.au", {}), "council");
  assertEquals(senderKind("no-reply@shop.example", {}), "automated");
  assertEquals(
    senderKind("hello@shop.example", { "list-unsubscribe": "<mailto:u@x>" }),
    "automated",
  );
  assertEquals(
    senderKind("hello@shop.example", { "auto-submitted": "auto-generated" }),
    "automated",
  );
  assertEquals(
    senderKind("hello@shop.example", { "auto-submitted": "no" }),
    "customer",
  );
  // A council no-reply is still council mail and is written.
  assertEquals(
    row({ ...E_IDENTITY, from: "noreply@southperth.wa.gov.au" }).event_type,
    "client.email_in",
  );
  // Platform mail is never written, even naming an invoice.
  const xero = buildOutlookMailRow(E_XERO, NITHIN, CTX);
  assertEquals(xero.kind === "skip" && xero.reason, "skipped_noise");
});

Deno.test("automated mail is written only when it names exactly one of our references", () => {
  const auto = { ...E_IDENTITY, from: "notifications@portal.example" };
  const none = buildOutlookMailRow(auto, NITHIN, CTX);
  assertEquals(none.kind === "skip" && none.reason, "skipped_noise");
  assertEquals(
    row({ ...auto, subject: "Booking for SWF 990002" }).event_type,
    "supplier.email_in",
  );
  const two = buildOutlookMailRow(
    { ...auto, subject: "SWF-990002 and SWP-990001" },
    NITHIN,
    CTX,
  );
  assertEquals(two.kind === "skip" && two.reason, "skipped_noise");
  assertEquals(ourReferences("Material Order Ref SWP 26195"), ["SWP-26195"]);
});

Deno.test("owner mailbox: our own human mail needs job evidence; tool mail always kept (D-EM3)", () => {
  const personal = {
    ...E_SENT,
    from: "marnin@secureworkswa.com.au",
    to: ["friend@example.org"],
    cc: [],
    subject: "Lunch?",
  };
  const p = buildOutlookMailRow(personal, MARNIN, CTX);
  assertEquals(p.kind === "skip" && p.reason, "skipped_private");
  // To a job's client: kept.
  assertEquals(
    row({ ...personal, to: ["sam.sample@example.net"] }, MARNIN).event_type,
    "client.email_out",
  );
  // Names our reference: kept.
  assertEquals(
    row({ ...personal, subject: "Re: INV-1477" }, MARNIN).event_type,
    "client.email_out",
  );
  // Tool-marked: kept, sent_by_kind our_tool.
  const tool = row({ ...personal, headers: { "x-sw-job-id": "abc" } }, MARNIN);
  assertEquals(tool.payload.sent_by_kind, "our_tool");
  assertEquals(tool.privacy_classification, "restricted_pii");
  // Inbound to an owner mailbox is never filtered.
  assertEquals(row(E_IDENTITY, MARNIN).event_type, "client.email_in");
});

Deno.test("group post: quoted history cut, To-tag line, line from the group address", () => {
  const r = row(E_GROUP_POST, PATIOS);
  assertEquals(
    r.payload.body,
    "Subject: Council approval 12 Example Street\nTo-tag: SWP-990001\n\nApproval attached.\nRegards, Planning",
  );
  assertEquals(r.payload.body_source, "post_body_cut");
  assertEquals(r.payload.line, "patio");
  assertEquals(r.payload.to_tag, "SWP-990001");
  assertEquals(r.payload.sender_kind, "council");
  assertEquals(r.payload.folder_kind, "group");
});

Deno.test("quoted-history markers: Outlook, Gmail two-line, iPhone, forwarded, quoted lines", () => {
  assertEquals(
    cutQuotedHistory("New\n________________________________\nFrom: A\nSent: B"),
    "New",
  );
  assertEquals(cutQuotedHistory("New\nFrom: A\nSent: B\nTo: C"), "New");
  assertEquals(
    cutQuotedHistory("From: the site we saw\nall good"),
    "From: the site we saw\nall good",
  );
  assertEquals(
    cutQuotedHistory(
      "New\nOn Tue, 1 Oct 2026 at 10:00, X <x@y.z>\nwrote:\n> old",
    ),
    "New",
  );
  assertEquals(
    cutQuotedHistory(
      "Yes\n\nSent from my iPhone\n\nOn 1 Oct 2026, at 9:00 am, X wrote:\nold",
    ),
    "Yes\n\nSent from my iPhone\n",
  );
  assertEquals(
    cutQuotedHistory("New\n---------- Forwarded message ---------\nold"),
    "New",
  );
  assertEquals(cutQuotedHistory("New\n> old\n> older"), "New");
});

Deno.test("line and To-tag come from the whole recipient list", () => {
  assertEquals(
    lineFromRecipients(["fencing@secureworkswa.com.au"]).line,
    "fencing",
  );
  assertEquals(
    lineFromRecipients([
      "fencing@secureworkswa.com.au",
      "patios@secureworkswa.com.au",
    ]).line,
    null,
  );
  assertEquals(lineFromRecipients(["patios@other.example"]).line, null);
  assertEquals(
    toTag(["fencing+swf-990002@secureworkswa.com.au"]),
    "SWF-990002",
  );
  assertEquals(toTag(["fencing+hello@secureworkswa.com.au"]), null);
});

Deno.test("body cut at 20,000 characters and flagged", () => {
  const r = row({ ...E_IDENTITY, bodyText: "x".repeat(25_000) });
  assertEquals((r.payload.body as string).length, BODY_MAX_CHARS);
  assertEquals(r.payload.body_truncated, true);
  assert((r.payload.body_chars_total as number) > BODY_MAX_CHARS);
  assertEquals((r.body_preview as string).length, 500);
});

Deno.test("no sender, no id", () => {
  const a = buildOutlookMailRow({ ...E_IDENTITY, from: null }, NITHIN, CTX);
  assertEquals(a.kind === "skip" && a.reason, "no_sender");
  const b = buildOutlookMailRow({ ...E_IDENTITY, graphId: "" }, NITHIN, CTX);
  assertEquals(b.kind === "skip" && b.reason, "no_id");
});

Deno.test("history rows are backfill", () => {
  assertEquals(
    row(E_DIRECT, NITHIN, { ...CTX, captureMode: "backfill" }).metadata
      .capture_mode,
    "backfill",
  );
});
