// Recorded fixtures for slice M4 (the GHL history load and its link action),
// on the rows the design names (sms.md section 10, read 23 Sep 2026). Ids,
// contacts, conversations and times are the recorded values; where the design
// recorded none (R6's staff user and line, R12's message id, conversation ids)
// the value is a labelled placeholder. Bodies are neutral placeholder text. No
// customer names: row labels only.

import {
  R2_LIST_ITEM,
  R3_LIST_ITEM,
  R4_LIST_ITEM,
  R5,
  R7_LIST_ITEMS,
} from "../_shared/evidence/ghl_message_fixtures.ts";

export const SHERIDAN_CONTACT = R5.contactId; // SWF-261335
export const SHERIDAN_CONVERSATION = "r5-conversation-placeholder";

/** R6: three staff app texts on 4 Sep, in the GHL cache only today. */
export const R6_ITEMS = [
  "foM3hD1SggjmCoNexihJ",
  "BIuigfV2iHxTTeFN8YG5",
  "XPtcG3KZv34WWXdIOdKy",
].map((id, i) => ({
  id,
  messageType: "TYPE_SMS",
  direction: "outbound",
  source: "app",
  userId: "r6-staff-user-placeholder",
  from: "+61489267772", // stand-in: the design records no line for R6
  body: `Staff app text ${i + 1} for the R6 fixture.`,
  contactId: SHERIDAN_CONTACT,
  conversationId: SHERIDAN_CONVERSATION,
  dateAdded: `2026-09-04T01:${String(i * 5).padStart(2, "0")}:00.000Z`,
}));

/** R5 as it appears in the conversation list (already saved by the tool send). */
export const R5_LIST_ITEM = {
  id: R5.messageId,
  messageType: "TYPE_SMS",
  direction: "outbound",
  source: "app",
  from: R5.fromNumber,
  body: R5.body,
  contactId: SHERIDAN_CONTACT,
  conversationId: SHERIDAN_CONVERSATION,
  dateAdded: "2026-09-18T01:10:00.000Z",
  meta: { marketplace: { appId: "69a41803c86f294a620b6499" } },
};

/** The SWF-261335 conversation, as GHL holds it: R6, R7, R5. */
export const SHERIDAN_MESSAGES = [...R6_ITEMS, ...R7_LIST_ITEMS, R5_LIST_ITEM];

export const GAUCI_CONTACT = R2_LIST_ITEM.contactId; // SWF-261431, SWF-261448
export const GAUCI_CONVERSATION = R2_LIST_ITEM.conversationId;
/** R1: the inbound "three quotes" text. */
export const R1_ITEM = {
  id: "pffXnIL1v2FTaKnz4DHm",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267772",
  body: "I haven't received all three quotes as yet?",
  contactId: GAUCI_CONTACT,
  conversationId: GAUCI_CONVERSATION,
  dateAdded: "2026-09-23T04:35:00.000Z",
};
/** A call on the same thread: counted skipped until the call writer exists. */
export const GAUCI_CALL = {
  id: "gauciCallPlaceholder1",
  messageType: "TYPE_CALL",
  direction: "inbound",
  contactId: GAUCI_CONTACT,
  conversationId: GAUCI_CONVERSATION,
  dateAdded: "2026-09-16T02:00:00.000Z",
};
export const GAUCI_MESSAGES = [
  R4_LIST_ITEM,
  R1_ITEM,
  R2_LIST_ITEM,
  R3_LIST_ITEM,
  GAUCI_CALL,
];

/** R12: SWP-26376's conversation, no text since 10 Jun. */
export const R12_CONTACT = "r12-contact-placeholder";
export const R12_CONVERSATION = "mxoELFbGvp1SLEycQU23";
export const R12_ITEM = {
  id: "r12LastTextPlaceholder",
  messageType: "TYPE_SMS",
  direction: "inbound",
  to: "+61489267774",
  body: "Last text for the R12 fixture.",
  contactId: R12_CONTACT,
  conversationId: R12_CONVERSATION,
  dateAdded: "2026-06-10T03:00:00.000Z",
};

// ── Link action (captain 24 Sep 2026: "yes link all live jobs to their contacts") ──

/** R21: SWF-26168 has no contact; its customer's contact is TZ8YSOsYK6et7nCbviSs. */
export const R21_CONTACT = "TZ8YSOsYK6et7nCbviSs";
export const R21_JOB = {
  job_id: "44444444-4444-4444-8444-444444426168",
  job_number: "SWF-26168",
  tier: 3,
  phone_key: "412345678", // placeholder key: the design records no number
  email_key: "r21.placeholder@example.com",
  own_contact_id: null,
  own_contacts: 0,
};
