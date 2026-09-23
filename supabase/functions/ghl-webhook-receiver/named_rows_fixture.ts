// Fixtures for the named rows of the context design (sms.md §10), used by the
// slice C1b receiver tests. Ids are the real GHL ids the design names; bodies
// follow GHL's documented app-webhook shape (InboundMessage / OutboundMessage)
// and this receiver's workflow-post shape (CallCompleted, ContactCreate).
// Row labels only: no customer names. Phone numbers are our own lines or
// placeholders (+61400000000).

export const TEST_LOCATION_ID = "loc-secureworks-test";
export const TEST_WEBHOOK_SECRET = "workflow-secret-for-tests";

/** Two jobs the R1 contact holds (design: two open fencing quotes). */
export const R1_JOB_A = "11111111-1111-4111-8111-111111111111";
export const R1_JOB_B = "22222222-2222-4222-8222-222222222222";
/** A job id nobody owns, used as a forged body.job_id. */
export const FORGED_JOB_ID = "99999999-9999-4999-8999-999999999999";

/** R1: inbound customer text, two candidate jobs on the contact. */
export const R1_INBOUND = {
  type: "InboundMessage",
  locationId: TEST_LOCATION_ID,
  webhookId: "wh-r1-0001",
  messageId: "pffXnIL1v2FTaKnz4DHm",
  contactId: "lYPee0K2DuQHXH2xHL1P",
  conversationId: "I98nlO8dKPOAaylh7k23",
  messageType: "SMS",
  direction: "inbound",
  phone: "+61400000000",
  body: "I haven't received all three quotes as yet?",
  dateAdded: "2026-09-23T04:35:00.000Z",
};
export const R1_TEXT = R1_INBOUND.body;

/** R2: staff reply from the GHL app on the same conversation. */
export const R2_OUTBOUND = {
  type: "OutboundMessage",
  locationId: TEST_LOCATION_ID,
  webhookId: "wh-r2-0001",
  messageId: "unJUR0MY5jwawuYXWYgR",
  contactId: "lYPee0K2DuQHXH2xHL1P",
  conversationId: "I98nlO8dKPOAaylh7k23",
  messageType: "SMS",
  direction: "outbound",
  userId: "RgDWTnYL6zL3eJA6nLht",
  phone: "+61400000000",
  body: "Staff reply text for the R2 fixture.",
  dateAdded: "2026-09-23T05:19:00.000Z",
};

/** R10: inbound to the fencing line (772). */
export const R10_INBOUND = {
  type: "InboundMessage",
  locationId: TEST_LOCATION_ID,
  webhookId: "wh-r10-0001",
  messageId: "e7W3aTJs6myLqx1P5tfC",
  contactId: "r10-contact-placeholder",
  conversationId: "r10-conversation-placeholder",
  messageType: "SMS",
  direction: "inbound",
  phone: "+61400000000",
  to: "+61489267772",
  body: "Inbound text for the R10 fixture.",
  dateAdded: "2026-09-21T02:00:00.000Z",
};

/** A workflow call post (the remaining workflow webhook, sms.md §13 P2). */
export const CALL_COMPLETED = {
  type: "CallCompleted",
  contactId: "lYPee0K2DuQHXH2xHL1P",
  callId: "call-fixture-0001",
  direction: "inbound",
  to: "+61489267772",
  from: "+61400000000",
  duration: 95,
  callStatus: "completed",
  recordingUrl: "https://recordings.example.test/call-fixture-0001.mp3",
  workflowId: "wf-call-completed",
};

/** A ContactCreate post carrying ad attribution. */
export const CONTACT_CREATE = {
  type: "ContactCreate",
  locationId: TEST_LOCATION_ID,
  webhookId: "wh-contact-0001",
  contactId: "contact-create-fixture",
  phone: "+61400000000",
  email: "placeholder@example.test",
  customFields: { gclid: "gclid-fixture-value", utm_source: "google" },
};
