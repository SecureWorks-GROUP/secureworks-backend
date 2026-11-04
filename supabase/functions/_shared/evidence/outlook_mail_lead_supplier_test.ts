// C7 rule proofs (3 Nov 2026): a Stratco lead allocation and a supplier's order
// mail from a supplier whose record carries no email were dropped as noise.
// The row builder now keeps both; other mail from those senders, and look-alikes
// from anyone else, stay noise. Every name, number and id here is made up.
// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOutlookMailRow,
  leadNotice,
  type OutlookCaptureContext,
  type OutlookMailItem,
  type OutlookSource,
} from "./outlook_mail.ts";
import {
  loadTradingPartners,
  type PartnerClient,
  SUPPLIER_SENDER_DOMAINS,
} from "./outlook_partners.ts";
import { MARNIN, NITHIN } from "./outlook_mail_fixtures.ts";

const ADMIN: OutlookSource = {
  email: "admin@secureworkswa.com.au",
  sourceKey: "admin",
  kind: "user",
  scopeLabel: "admin",
  ownerPrivacy: false,
};

const CTX: OutlookCaptureContext = {
  source: "outlook-mail-capture",
  captureMode: "live",
  supplierDomains: new Set(["bunnings.com.au", "stratcowa.com.au"]),
  builderSenders: new Set<string>(),
  jobClientEmails: new Set<string>(),
  builderRefPrefixes: [],
};

function lead(over: Partial<OutlookMailItem> = {}): OutlookMailItem {
  return {
    graphId: "AAMkLeadImmutable01=",
    internetMessageId: "<Lead-Notice-01@geopod-ismtpd-9>",
    conversationId: "AAQkLeadConv01=",
    subject: "Stratco lead allocation - 990402",
    from: "no-reply@stratco.com.au",
    to: ["admin@secureworkswa.com.au"],
    cc: [],
    receivedAt: "2026-10-29T05:30:30Z",
    sentAt: "2026-10-29T05:30:28Z",
    bodyText:
      "Kim you have been allocated a Stratco lead. The lead reference number is 990402. Please click ACCEPT LEAD to confirm.",
    bodyIsHtml: false,
    headers: { "auto-submitted": "auto-generated" },
    folderKind: "inbox",
    ...over,
  };
}

Deno.test("a Stratco lead allocation is a lead: client.email_in from a customer, its lead number on the row, on no job", () => {
  const b = buildOutlookMailRow(lead(), ADMIN, CTX);
  assert(b.kind === "row");
  assertEquals(b.senderKind, "customer");
  const row = b.row as Record<string, unknown>;
  const p = row.payload as Record<string, unknown>;
  assertEquals(row.event_type, "client.email_in");
  assertEquals(row.direction, "inbound");
  assertEquals(row.job_id, null);
  assertEquals(row.match_method, "none");
  assertEquals(row.provider_message_id, "email:lead-notice-01@geopod-ismtpd-9");
  assertEquals(p.lead_source, "stratco");
  assertEquals(p.lead_ref, "990402");
  assertEquals(p.sender_kind, "customer");
  assertEquals(p.email, "no-reply@stratco.com.au");
  // The lead number is Stratco's, not one of ours: the ladder is given no reference.
  assertEquals(p.references, []);
});

Deno.test("a lead allocation that names one of our jobs carries that reference for the ladder", () => {
  const b = buildOutlookMailRow(
    lead({
      subject: "Stratco lead allocation - 990403",
      bodyText:
        "You have been allocated a Stratco lead. The lead reference number is 990403. Previous job SWP-990001.",
    }),
    ADMIN,
    CTX,
  );
  assert(b.kind === "row");
  const p = (b.row as Record<string, unknown>).payload as Record<
    string,
    unknown
  >;
  assertEquals(p.references, ["SWP-990001"]);
  assertEquals(p.lead_ref, "990403");
});

Deno.test("a lead allocation is a lead whatever the sender list says, with HTML words or the number in the words only", () => {
  // stratco.com.au on the supplier list would make the sender a supplier; the notice is still a lead.
  const listed = { ...CTX, supplierDomains: new Set(["stratco.com.au"]) };
  const b1 = buildOutlookMailRow(lead(), ADMIN, listed);
  assert(b1.kind === "row");
  assertEquals(
    (b1.row as Record<string, unknown>).event_type,
    "client.email_in",
  );
  const b2 = buildOutlookMailRow(
    lead({
      subject: "New lead",
      bodyText:
        "<p>Kim you have been <b>allocated a Stratco lead</b>.</p><p>The lead reference number is 990404.</p>",
      bodyIsHtml: true,
    }),
    ADMIN,
    CTX,
  );
  assert(b2.kind === "row");
  assertEquals(
    ((b2.row as Record<string, unknown>).payload as Record<string, unknown>)
      .lead_ref,
    "990404",
  );
});

Deno.test("an inbound lead allocation in an owner mailbox is kept (the privacy rule reads only our own mail)", () => {
  const b = buildOutlookMailRow(
    lead({ to: ["marnin@secureworkswa.com.au"] }),
    MARNIN,
    CTX,
  );
  assert(b.kind === "row");
  assertEquals(
    (b.row as Record<string, unknown>).privacy_classification,
    "restricted_pii",
  );
});

Deno.test("other mail from the lead source's no-reply address, and a look-alike from anyone else, stay noise", () => {
  const news = buildOutlookMailRow(
    lead({
      subject: "Our summer range is here",
      bodyText: "New colours for 2027.",
      headers: { "list-unsubscribe": "<x>" },
    }),
    ADMIN,
    CTX,
  );
  assertEquals(news, {
    kind: "skip",
    reason: "skipped_noise",
    senderKind: "automated",
  });
  const lookalike = buildOutlookMailRow(
    lead({ from: "no-reply@stratco-leads.example" }),
    ADMIN,
    CTX,
  );
  assertEquals(lookalike, {
    kind: "skip",
    reason: "skipped_noise",
    senderKind: "automated",
  });
  assertEquals(
    leadNotice(
      "noreply@stratco.com.au",
      "Stratco lead allocation - 990402",
      "",
    ),
    null,
  );
  assertEquals(
    leadNotice(
      "No Reply <NO-REPLY@STRATCO.COM.AU>",
      "Stratco lead allocation - 990402",
      "",
    ),
    {
      source: "stratco",
      ref: "990402",
    },
  );
  assertEquals(
    leadNotice(
      "no-reply@stratco.com.au",
      "Stratco lead allocation",
      "Please log in.",
    ),
    {
      source: "stratco",
      ref: null,
    },
  );
});

function partnerClient(suppliers: string[]): PartnerClient {
  return {
    rpc: async () => ({ data: suppliers, error: null }),
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
    }),
  };
}

Deno.test("a supplier whose record carries no email (Fans Online) is a supplier on the reader's list", async () => {
  assert(SUPPLIER_SENDER_DOMAINS.has("fansonline.com.au"));
  const p = await loadTradingPartners(partnerClient([]));
  assert(p.supplierDomains.has("fansonline.com.au"));
  const p2 = await loadTradingPartners(partnerClient(["bunnings.com.au"]));
  assert(
    p2.supplierDomains.has("fansonline.com.au") &&
      p2.supplierDomains.has("bunnings.com.au"),
  );
});

Deno.test("a no-email supplier's order mail from its no-reply address is supplier mail, not noise", async () => {
  const partners = await loadTradingPartners(partnerClient([]));
  const ctx = { ...CTX, supplierDomains: partners.supplierDomains };
  const item: OutlookMailItem = {
    graphId: "AAMkFansImmutable01=",
    internetMessageId: "<fans-order-01@smtp-relay.example>",
    subject: "Your order has been shipped",
    from: "donotreply@fansonline.com.au",
    to: ["nithin@secureworkswa.com.au"],
    receivedAt: "2026-10-28T02:27:21Z",
    bodyText: "Your order has left our warehouse. Order #990001.",
    headers: { "reply-to": "donotreply@fansonline.com.au" },
    folderKind: "inbox",
  };
  const b = buildOutlookMailRow(item, NITHIN, ctx);
  assert(b.kind === "row");
  assertEquals(b.senderKind, "supplier");
  assertEquals(
    (b.row as Record<string, unknown>).event_type,
    "supplier.email_in",
  );
  // Without the entry it was noise (the deployed rule of 3 Nov 2026).
  assertEquals(buildOutlookMailRow(item, NITHIN, CTX), {
    kind: "skip",
    reason: "skipped_noise",
    senderKind: "automated",
  });
});
