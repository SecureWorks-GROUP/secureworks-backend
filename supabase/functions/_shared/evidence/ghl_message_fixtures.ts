// Recorded fixtures for the named rows of the context design (sms.md §10) that
// slice C1a's row builder must map. Ids, contacts, conversations, times, lines
// and GHL users are the real values the design recorded; bodies are the
// design's quoted words where it quotes them and neutral placeholder text
// otherwise. Row labels only: no customer names. Items are in the shape the two
// GHL doors deliver: the conversation message list (id, messageType TYPE_SMS)
// and the app webhook (messageId, messageType SMS).

/** R5 (sms.md §10): tool-sent install text on SWF-261335, sent from 771. */
export const R5 = {
  messageId: "mDS89hMzWE2R3VCMqxP2",
  contactId: "1VHBzZX6DsjMZW2WbgQn",
  existingEventId: "689a6745-5554-4e42-b670-8401ec7a843e",
  jobId: "33333333-3333-4333-8333-333333333335", // stands for SWF-261335
  fromNumber: "+61489267771",
  body: "Install text for the R5 fixture.",
  // GHL's POST /conversations/messages answer carries ids, not a time.
  sendResult: {
    conversationId: "r5-conversation-placeholder",
    messageId: "mDS89hMzWE2R3VCMqxP2",
  },
};

/** R5 as GHL's OutboundMessage webhook would deliver the same text (our app sent it). */
export const R5_WEBHOOK = {
  type: "OutboundMessage",
  messageId: R5.messageId,
  contactId: R5.contactId,
  conversationId: "r5-conversation-placeholder",
  messageType: "SMS",
  direction: "outbound",
  source: "app",
  from: R5.fromNumber,
  body: R5.body,
  dateAdded: "2026-09-18T01:10:00.000Z",
  meta: { marketplace: { appId: "69a41803c86f294a620b6499" } },
};

const R1_CONTACT = "lYPee0K2DuQHXH2xHL1P";
const R1_CONVERSATION = "I98nlO8dKPOAaylh7k23";

/** R2: staff reply from the GHL app, user RgDWTnYL6zL3eJA6nLht, from 772. */
export const R2_LIST_ITEM = {
  id: "unJUR0MY5jwawuYXWYgR",
  messageType: "TYPE_SMS",
  direction: "outbound",
  status: "delivered",
  source: "app",
  userId: "RgDWTnYL6zL3eJA6nLht",
  from: "+61489267772",
  to: "+61400000000",
  body: "Staff reply text for the R2 fixture.",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-23T05:19:00.000Z",
};

/** R3: inbound "Thanks." on the same conversation. */
export const R3_LIST_ITEM = {
  id: "EHw3wdBraMS847Q3V380",
  messageType: "TYPE_SMS",
  direction: "inbound",
  status: "delivered",
  from: "+61400000000",
  to: "+61489267772",
  body: "Thanks.",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-23T06:00:00.000Z",
};

/** R4: GHL workflow follow-up at 03:08Z. */
export const R4_LIST_ITEM = {
  id: "OPzxTmGv37UAMzf1hD3Q",
  messageType: "TYPE_SMS",
  direction: "outbound",
  status: "delivered",
  source: "workflow",
  from: "+61489267772",
  body: "Automatic follow-up text for the R4 fixture.",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-23T03:08:00.000Z",
};

/** R7: two internal comments on the SWF-261335 contact, 8 Sep. GHL marks them outbound. */
export const R7_LIST_ITEMS = [
  {
    id: "kRoIUHpu59P3Bpx3FBv5",
    messageType: "TYPE_INTERNAL_COMMENT",
    direction: "outbound",
    userId: "47AptTIxjOPutvcl6RpO",
    body: "Internal comment for the R7 fixture: quote mistake.",
    contactId: R5.contactId,
    conversationId: "r5-conversation-placeholder",
    dateAdded: "2026-09-08T02:00:00.000Z",
  },
  {
    id: "4IupuRIcAf5w6SXa6o9y",
    messageType: "TYPE_INTERNAL_COMMENT",
    direction: "outbound",
    userId: "47AptTIxjOPutvcl6RpO",
    body: "Internal comment for the R7 fixture: plinth price concession.",
    contactId: R5.contactId,
    conversationId: "r5-conversation-placeholder",
    dateAdded: "2026-09-08T02:05:00.000Z",
  },
];

/** R9: inbound to 774 (patio line). */
export const R9_WEBHOOK = {
  type: "InboundMessage",
  messageId: "1TPog9f79izPytVu8yoo",
  contactId: "Oxqi7eCx2rGCsS0BXOH2",
  conversationId: "r9-conversation-placeholder",
  messageType: "SMS",
  direction: "inbound",
  to: "+61489267774",
  body: "are the guys coming today?",
  dateAdded: "2026-09-22T23:08:00.000Z",
};

/** R10: one conversation across two lines: inbound to 772, and a reply from 771 by user 47AptTIxjOPutvcl6RpO. */
export const R10_INBOUND = {
  id: "e7W3aTJs6myLqx1P5tfC",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267772",
  from: "+61400000000",
  body: "Inbound text for the R10 fixture.",
  contactId: "r10-contact-placeholder",
  conversationId: "r10-conversation-placeholder",
  dateAdded: "2026-09-21T02:00:00.000Z",
};
export const R10_OUTBOUND = {
  id: "af2qQAZ13DzZX9VFZv6n",
  messageType: "TYPE_SMS",
  direction: "outbound",
  source: "app",
  userId: "47AptTIxjOPutvcl6RpO",
  from: "+61489267771",
  body: "Reply text for the R10 fixture, signed by a staff first name.",
  contactId: "r10-contact-placeholder",
  conversationId: "r10-conversation-placeholder",
  dateAdded: "2026-09-21T03:00:00.000Z",
};

/** R11: a 320-character customer question, 21 Sep 03:45Z. The body is kept whole. */
export const R11_BODY =
  ("Question text for the R11 fixture, long enough to test the whole body is kept. "
    .repeat(5)).slice(0, 320);
export const R11_LIST_ITEM = {
  id: "8d7P2o4FuI73GB8xHcZe",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267774",
  body: R11_BODY,
  contactId: "r11-contact-placeholder",
  conversationId: "r11-conversation-placeholder",
  dateAdded: "2026-09-21T03:45:00.000Z",
};

/** R13: "I only see one price of $5,478" (step 1 must not match; placement is P2's). */
export const R13_LIST_ITEM = {
  id: "EofbCakVE65xUwRRuFwz",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267772",
  body: "I only see one price of $5,478",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-21T03:51:00.000Z",
};

/**
 * R32 (to be named by the L6 validator: the design did not record real ids).
 * An MMS photo with no words, and a GHL Email item.
 */
export const R32_MMS = {
  id: "r32MmsPlaceholder01",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267772",
  body: "",
  attachments: [
    "https://storage.example.test/a/b/IMG_0001.JPG?token=x",
    "https://storage.example.test/a/b/IMG_0002.heic",
  ],
  contactId: "r32-contact-placeholder",
  conversationId: "r32-conversation-placeholder",
  dateAdded: "2026-09-20T01:00:00.000Z",
};
export const R32_EMAIL = {
  id: "r32EmailPlaceholder1",
  messageType: "TYPE_EMAIL",
  direction: "inbound",
  body: "Email body for the R32 fixture.",
  contactId: "r32-contact-placeholder",
  conversationId: "r32-conversation-placeholder",
  dateAdded: "2026-09-20T02:00:00.000Z",
  meta: { email: { messageIds: ["r32-email-message-id"] } },
};

/** A call and an activity item on a thread: not written by this path. */
export const CALL_ITEM = {
  id: "callItemFixture01",
  messageType: "TYPE_CALL",
  direction: "inbound",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-22T01:00:00.000Z",
};
export const ACTIVITY_ITEM = {
  id: "activityFixture01",
  messageType: "TYPE_ACTIVITY_OPPORTUNITY",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  dateAdded: "2026-09-22T01:00:00.000Z",
};
