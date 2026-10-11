// Synthetic Outlook messages and group posts for the email reader's tests
// (slice EM2). Every name, address, job number and id here is made up: no
// customer data. Shapes are what graph.ts produces from a Graph read.

import type { OutlookMailItem, OutlookSource } from "./outlook_mail.ts";

export const NITHIN: OutlookSource = {
  email: "nithin@secureworkswa.com.au",
  sourceKey: "nithin",
  kind: "user",
  scopeLabel: "sales",
  ownerPrivacy: false,
};
export const MARNIN: OutlookSource = {
  email: "marnin@secureworkswa.com.au",
  sourceKey: "marnin",
  kind: "user",
  scopeLabel: "owner",
  ownerPrivacy: true,
};
export const PATIOS: OutlookSource = {
  email: "patios@secureworkswa.com.au",
  sourceKey: "patios",
  kind: "group",
  scopeLabel: "patios",
  ownerPrivacy: false,
};

/** A customer names the job number in the subject (ladder step 1, direct). */
export const E_DIRECT: OutlookMailItem = {
  graphId: "AAMkAGEm2DirectImmutable01=",
  internetMessageId: "<EM2-Direct-0001@mail.example.com>",
  conversationId: "AAQkAGEm2ConvDirect01=",
  subject: "Re: Patio quote SWP-990001 colour choice",
  from: "Pat Example <pat.example@example.com>",
  to: ["nithin@secureworkswa.com.au"],
  cc: [],
  receivedAt: "2026-10-01T02:00:00Z",
  sentAt: "2026-10-01T01:59:58Z",
  bodyText:
    "Hi Nithin,\r\n\r\nWe would like   Monument for the roof.\r\n\r\n\r\nThanks, Pat",
  bodyIsHtml: false,
  headers: {},
  folderKind: "inbox",
  hasAttachments: true,
  attachments: [
    {
      id: "att-1",
      name: "sketch.pdf",
      contentType: "application/pdf",
      size: 120_000,
      isInline: false,
      kind: "file",
    },
    {
      id: "att-2",
      name: "logo.png",
      contentType: "image/png",
      size: 4_000,
      isInline: true,
      kind: "file",
    },
  ],
};

/** A customer with no reference: placed by the sender's email (the job's client email). */
export const E_IDENTITY: OutlookMailItem = {
  graphId: "AAMkAGEm2IdentityImmutable02=",
  internetMessageId: "<em2-identity-0002@mail.example.com>",
  conversationId: "AAQkAGEm2ConvIdentity02=",
  subject: "When can you come out?",
  from: "sam.sample@example.net",
  to: ["nithin@secureworkswa.com.au"],
  cc: [],
  receivedAt: "2026-10-01T03:00:00Z",
  sentAt: "2026-10-01T02:59:59Z",
  bodyText: "Is Friday morning possible for the measure?",
  folderKind: "inbox",
  hasAttachments: false,
};

/** Our reply from Sent Items to that customer: outbound, staff. */
export const E_SENT: OutlookMailItem = {
  graphId: "AAMkAGEm2SentImmutable03=",
  internetMessageId: "<SY4PR01MB0003@secureworkswa.com.au>",
  conversationId: "AAQkAGEm2ConvIdentity02=",
  subject: "RE: When can you come out?",
  from: "nithin@secureworkswa.com.au",
  to: ["sam.sample@example.net"],
  cc: ["admin@secureworkswa.com.au"],
  receivedAt: "2026-10-01T03:30:05Z",
  sentAt: "2026-10-01T03:30:00Z",
  bodyText: "Friday 9am works, see you then.",
  folderKind: "sent",
  hasAttachments: false,
};

/** A supplier names a PO. */
export const E_SUPPLIER: OutlookMailItem = {
  graphId: "AAMkAGEm2SupplierImmutable04=",
  internetMessageId: "<em2-supplier-0004@orders.steelsupply.example>",
  conversationId: "AAQkAGEm2ConvSupplier04=",
  subject: "Delivery confirmed PO-990001",
  from: "orders@steelsupply.example",
  to: ["admin@secureworkswa.com.au"],
  receivedAt: "2026-10-01T04:00:00Z",
  bodyText: "Your order ships Tuesday.",
  folderKind: "inbox",
};

/** A platform notification: never written. */
export const E_XERO: OutlookMailItem = {
  graphId: "AAMkAGEm2XeroImmutable05=",
  internetMessageId: "<em2-xero-0005@post.xero.com>",
  subject: "Receipt For Invoice INV-90001 from Example Fencing",
  from: "messaging-service@post.xero.com",
  to: ["admin@secureworkswa.com.au"],
  receivedAt: "2026-10-01T05:00:00Z",
  bodyText: "Receipt attached.",
  folderKind: "inbox",
};

/** A group post carrying its whole thread, plus-addressed to a job. */
export const E_GROUP_POST: OutlookMailItem = {
  graphId: "AAMkAGEm2PostImmutable06=",
  internetMessageId: "<em2-post-0006@mail.example.org>",
  conversationId: "AAQkAGEm2GroupConv06=",
  subject: "Council approval 12 Example Street",
  from: "approvals@council.wa.gov.au",
  to: ["patios+SWP-990001@secureworkswa.com.au"],
  receivedAt: "2026-10-01T06:00:00Z",
  bodyText:
    "<p>Approval attached.</p><p>Regards, Planning</p><div>On Mon, 29 Sep 2026 at 10:00, Nithin &lt;nithin@secureworkswa.com.au&gt;</div><div>wrote:</div><p>Please confirm the permit.</p>",
  bodyIsHtml: true,
  folderKind: "group",
  hasAttachments: true,
};

// Group mailbox audience (9 Oct 2026). A made-up builder's thread in the ses@
// group, our reply posted to it (a group post lists no recipients), the
// sender's own Sent Items copy of that reply (it does), our invoice email's
// copy alone in the finance group, and a forward into the group.

export const SES: OutlookSource = {
  email: "ses@secureworkswa.com.au",
  sourceKey: "ses",
  kind: "group",
  scopeLabel: "ses",
  ownerPrivacy: false,
};
export const FINANCE: OutlookSource = {
  email: "finance@secureworkswa.com.au",
  sourceKey: "finance",
  kind: "group",
  scopeLabel: "finance",
  ownerPrivacy: false,
};
export const ADMIN: OutlookSource = {
  email: "admin@secureworkswa.com.au",
  sourceKey: "admin",
  kind: "user",
  scopeLabel: "admin",
  ownerPrivacy: false,
};

/** The builder's request: the first post of its thread in the ses@ group. */
export const P_BUILDER: OutlookMailItem = {
  graphId: "AAMkAGGmaBuilderPost01=",
  internetMessageId: "<gma-builder-0001@mail.builder.example>",
  subject: "Our Ref: BLD-99001 - 1 Example Street",
  from: "Jo Coordinator <coordinator@builder.example>",
  to: [],
  cc: [],
  receivedAt: "2026-10-01T01:00:00Z",
  sentAt: "2026-10-01T01:00:00Z",
  bodyText: "Hi team, can you confirm the install date?",
  folderKind: "group",
};

/** Our reply in the builder's thread, as the group lists it: no recipients. */
export const P_OUR_REPLY: OutlookMailItem = {
  graphId: "AAMkAGGmaOurReply02=",
  internetMessageId: "<GMA-Reply-0002@secureworkswa.com.au>",
  subject: "Our Ref: BLD-99001 - 1 Example Street",
  from: "admin@secureworkswa.com.au",
  to: [],
  cc: [],
  receivedAt: "2026-10-01T02:00:00Z",
  sentAt: "2026-10-01T02:00:00Z",
  bodyText: "Hi team, booked in for Friday.",
  folderKind: "group",
};

/** Our invoice email's copy in the finance group, alone in its thread. */
export const P_OUR_ALONE: OutlookMailItem = {
  graphId: "AAMkAGGmaOurAlone03=",
  internetMessageId: "<GMA-Alone-0003@secureworkswa.com.au>",
  subject: "BLD-99001 - Xero invoice INV-99001",
  from: "admin@secureworkswa.com.au",
  to: [],
  cc: [],
  receivedAt: "2026-10-01T03:00:00Z",
  sentAt: "2026-10-01T03:00:00Z",
  bodyText: "Please find attached our invoice.",
  folderKind: "group",
};

/** The sender's Sent Items copy of P_OUR_REPLY: the same email, recipients listed. */
export const E_OUR_REPLY_SENT: OutlookMailItem = {
  graphId: "AAMkAGGmaOurReplySent04=",
  internetMessageId: "<GMA-Reply-0002@secureworkswa.com.au>",
  conversationId: "AAQkAGGmaConvReply04=",
  subject: "RE: Our Ref: BLD-99001 - 1 Example Street",
  from: "admin@secureworkswa.com.au",
  to: ["Jo Coordinator <coordinator@builder.example>"],
  cc: ["ses@secureworkswa.com.au"],
  receivedAt: "2026-10-01T02:00:01Z",
  sentAt: "2026-10-01T02:00:00Z",
  bodyText: "Hi team, booked in for Friday.",
  folderKind: "sent",
};

/** A forward into the group from the sender's Sent Items: to the group only. */
export const E_FORWARD_SENT: OutlookMailItem = {
  graphId: "AAMkAGGmaForwardSent05=",
  internetMessageId: "<GMA-Forward-0005@secureworkswa.com.au>",
  conversationId: "AAQkAGGmaConvForward05=",
  subject: "FW: Our Ref: BLD-99001 - 1 Example Street",
  from: "admin@secureworkswa.com.au",
  to: ["ses@secureworkswa.com.au"],
  cc: [],
  receivedAt: "2026-10-01T04:00:01Z",
  sentAt: "2026-10-01T04:00:00Z",
  bodyText: "For the file.",
  folderKind: "sent",
};
