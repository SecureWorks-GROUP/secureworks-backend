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

// ── Calls (slice T1; transcripts.md §10 N1 to N3) ──
// Recorded read only on 24 Sep 2026 02:50Z (SecureSuite sw_list_ghl_messages)
// from the SWP-26941 customer's only GHL conversation, the R9 contact. Every
// field is the provider's own; the customer's number is replaced by the
// placeholder +61400000000 (our 774 line is kept). Call items carry no body.
const SWP_26941_CONTACT = "Oxqi7eCx2rGCsS0BXOH2";
const SWP_26941_CONVERSATION = "3GOBTMJT1qEXkGwcodQK";
const NITHIN_USER = "ERAycY7r6KZ8OA66WQCy";

/** N1: 23 Sep 07:40Z, inbound to 774, answered, 109 s (the §7 trace call). */
export const N1_CALL_ITEM = {
  id: "6kn6WmrtfTMvhEJtmfeJ",
  direction: "inbound",
  status: "completed",
  type: 1,
  locationId: "13yKADzN94BRxX4hByYX",
  contactId: SWP_26941_CONTACT,
  conversationId: SWP_26941_CONVERSATION,
  dateAdded: "2026-09-23T07:40:55.171Z",
  dateUpdated: "2026-09-23T07:43:05.924Z",
  userId: NITHIN_USER,
  meta: { call: { duration: 109, status: "completed" } },
  altId: "CAfcb0bf0b3d5308f16a6087ca116874a8",
  from: "+61400000000",
  to: "+61489267774",
  messageType: "TYPE_CALL",
};

/** N2: 22 Sep 22:59Z, inbound voicemail to 774 (no duration from the provider). */
export const N2_CALL_ITEM = {
  id: "Py9PovOwc4I4vNkn9jXg",
  direction: "inbound",
  status: "voicemail",
  type: 1,
  locationId: "13yKADzN94BRxX4hByYX",
  contactId: SWP_26941_CONTACT,
  conversationId: SWP_26941_CONVERSATION,
  dateAdded: "2026-09-22T22:59:20.907Z",
  dateUpdated: "2026-09-22T23:00:01.982Z",
  userId: NITHIN_USER,
  meta: { call: { duration: null, status: "voicemail" } },
  altId: "CA328d9bf74781d1cb8a8166ae38939924",
  from: "+61400000000",
  to: "+61489267774",
  messageType: "TYPE_CALL",
};

/** N3: 21 Sep 23:16Z, outbound from 774 in the GHL app, 67 s. */
export const N3_CALL_ITEM = {
  id: "0Gct0u0TQNZox8DRAVLo",
  direction: "outbound",
  status: "completed",
  type: 1,
  locationId: "13yKADzN94BRxX4hByYX",
  contactId: SWP_26941_CONTACT,
  conversationId: SWP_26941_CONVERSATION,
  dateAdded: "2026-09-21T23:16:29.130Z",
  dateUpdated: "2026-09-21T23:17:52.879Z",
  userId: NITHIN_USER,
  source: "app",
  meta: { call: { duration: 67, status: "completed" } },
  altId: "CAe7fc92b16f2705949df9fb8bf806d99c",
  from: "+61489267774",
  to: "+61400000000",
  messageType: "TYPE_CALL",
};

/** Same read: a 3 s outbound call on 31 Jul, too short to carry a transcript. */
export const SHORT_CALL_ITEM = {
  id: "heFD0jI7kzEenuByEnRs",
  direction: "outbound",
  status: "completed",
  type: 1,
  locationId: "13yKADzN94BRxX4hByYX",
  contactId: SWP_26941_CONTACT,
  conversationId: SWP_26941_CONVERSATION,
  dateAdded: "2026-07-31T04:19:05.073Z",
  dateUpdated: "2026-07-31T04:19:32.746Z",
  userId: NITHIN_USER,
  source: "app",
  meta: { call: { duration: 3, status: "completed" } },
  altId: "CAbed8de5cc7442f037604aacc3b0bd940",
  from: "+61489267774",
  to: "+61400000000",
  messageType: "TYPE_CALL",
};

/** A call with nothing but its id, type, direction and time (placeholder, not recorded). */
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

// ── Rank 10 (slice C1c): the GHL app's note, task and appointment webhooks ──
// sms.md §10 R25 to R31 name these rows by job and kind but the design's read
// budget recorded no GHL ids for them, so the ids below are placeholders the
// L6 validator replaces with one real delivery each (like R32). Contacts are
// the design's where it names one (R25 and R27 are the SWF-261335 contact),
// placeholders otherwise. Bodies are neutral placeholder text. Shapes follow
// GHL's documented app webhooks: notes and tasks carry the item at the top
// level, appointments nest it under `appointment`.

/** R25: internal note on SWF-261335 (price concession, audit A). */
export const R25_NOTE_CREATE = {
  type: "NoteCreate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r25-note-0001",
  id: "r25NotePlaceholder01",
  contactId: R5.contactId,
  userId: "47AptTIxjOPutvcl6RpO",
  body: "Note text for the R25 fixture: price concession agreed.",
  dateAdded: "2026-09-08T02:10:00.000Z",
};

/** R27: the same note edited later (NoteUpdate). A new row; R25's row is kept. */
export const R27_NOTE_UPDATE = {
  type: "NoteUpdate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r27-note-0001",
  id: R25_NOTE_CREATE.id,
  contactId: R5.contactId,
  userId: "47AptTIxjOPutvcl6RpO",
  body: "Note text for the R25 fixture: price concession agreed, edited.",
  dateAdded: R25_NOTE_CREATE.dateAdded,
  dateUpdated: "2026-09-09T01:00:00.000Z",
};

/** R26: scope handoff note on a contact holding SWF-261421 and SWF-261422 (two option quotes). */
export const R26_NOTE_CREATE = {
  type: "NoteCreate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r26-note-0001",
  id: "r26NotePlaceholder01",
  contactId: "r26-contact-placeholder",
  userId: "RgDWTnYL6zL3eJA6nLht",
  body: "Note text for the R26 fixture: scope handoff.",
  dateAdded: "2026-09-16T03:00:00.000Z",
};

/** R28: a task assigned to a staff user (the design: Nithin). */
export const R28_TASK_CREATE = {
  type: "TaskCreate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r28-task-0001",
  id: "r28TaskPlaceholder01",
  contactId: "r28-contact-placeholder",
  assignedTo: "r28-staff-user-placeholder",
  title: "Task title for the R28 fixture",
  body: "Task body for the R28 fixture.",
  dueDate: "2026-09-25T00:00:00.000Z",
  dateAdded: "2026-09-22T01:00:00.000Z",
};

/** R29: that task completed, reopened, then completed again: two completion rows. */
export const R29_TASK_COMPLETE_FIRST = {
  ...R28_TASK_CREATE,
  type: "TaskComplete",
  webhookId: "wh-r29-task-0001",
  completed: true,
  timestamp: "2026-09-23T02:00:00.000Z",
};
export const R29_TASK_COMPLETE_SECOND = {
  ...R28_TASK_CREATE,
  type: "TaskComplete",
  webhookId: "wh-r29-task-0002",
  completed: true,
  timestamp: "2026-09-23T05:30:00.000Z",
};

/** R30: SWF-261424's appointment rescheduled (AppointmentUpdate); the original was never cancelled. */
export const R30_APPOINTMENT_UPDATE = {
  type: "AppointmentUpdate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r30-appt-0001",
  appointment: {
    id: "r30ApptPlaceholder01",
    contactId: "r30-contact-placeholder",
    calendarId: "r30-calendar-placeholder",
    title: "Appointment title for the R30 fixture",
    appointmentStatus: "confirmed",
    assignedUserId: "RgDWTnYL6zL3eJA6nLht",
    startTime: "2026-09-26T01:00:00.000Z",
    endTime: "2026-09-26T02:00:00.000Z",
    dateAdded: "2026-09-19T00:00:00.000Z",
    dateUpdated: "2026-09-22T04:00:00.000Z",
  },
};

/** R31: SWF-261438's appointment created 48 minutes after its job, and a later AppointmentDelete. */
export const R31_APPOINTMENT_CREATE = {
  type: "AppointmentCreate",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r31-appt-0001",
  appointment: {
    id: "r31ApptPlaceholder01",
    contactId: "r31-contact-placeholder",
    calendarId: "r31-calendar-placeholder",
    title: "Appointment title for the R31 fixture",
    appointmentStatus: "confirmed",
    assignedUserId: "RgDWTnYL6zL3eJA6nLht",
    startTime: "2026-09-24T01:00:00.000Z",
    endTime: "2026-09-24T02:00:00.000Z",
    dateAdded: "2026-09-18T00:48:00.000Z",
    dateUpdated: "2026-09-18T00:48:00.000Z",
  },
};
export const R31_APPOINTMENT_DELETE = {
  type: "AppointmentDelete",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r31-appt-0002",
  appointment: {
    ...R31_APPOINTMENT_CREATE.appointment,
    appointmentStatus: "cancelled",
    dateUpdated: "2026-09-20T03:00:00.000Z",
  },
};

// ── Message webhooks as the receiver sees them (slice C1c) ──

/** R1: inbound "I haven't received all three quotes as yet?", two open fencing quotes on the contact. */
export const R1_WEBHOOK = {
  type: "InboundMessage",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r1-0001",
  messageId: "pffXnIL1v2FTaKnz4DHm",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  messageType: "SMS",
  direction: "inbound",
  to: "+61489267772",
  body: "I haven't received all three quotes as yet?",
  dateAdded: "2026-09-23T04:35:00.000Z",
};

/** R1 again, as a webhook that carries no message id: nothing is written from its body. */
export const R1_WEBHOOK_NO_ID = {
  type: "InboundMessage",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r1-noid-0001",
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  messageType: "SMS",
  direction: "inbound",
  body: "I haven't received all three quotes as yet?",
  dateAdded: "2026-09-23T04:35:00.000Z",
};

/** R4 as the OutboundMessage webhook of a GHL workflow send. */
export const R4_WEBHOOK = {
  type: "OutboundMessage",
  locationId: "loc-secureworks-test",
  webhookId: "wh-r4-0001",
  messageId: R4_LIST_ITEM.id,
  contactId: R1_CONTACT,
  conversationId: R1_CONVERSATION,
  messageType: "SMS",
  direction: "outbound",
  source: "workflow",
  from: "+61489267772",
  body: R4_LIST_ITEM.body,
  dateAdded: R4_LIST_ITEM.dateAdded,
};
