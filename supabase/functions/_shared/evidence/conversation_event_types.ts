import { GHL_CAPTURED_MESSAGE_EVENT_TYPES } from "./ghl_message.ts";

export const JOB_CONVERSATION_EVENT_TYPES = [
  ...GHL_CAPTURED_MESSAGE_EVENT_TYPES,
  "client.call_complete",
  "client.message_in",
  "supplier.email_in",
] as const;
