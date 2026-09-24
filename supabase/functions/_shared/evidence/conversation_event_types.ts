import { GHL_CAPTURED_MESSAGE_EVENT_TYPES } from "./ghl_message.ts";

export const GHL_RECORD_EVENT_TYPES_EXCLUDED_FROM_DEBT_TIMELINE = {
  "ghl.task_created": "Internal task state is not debtor communication.",
  "ghl.task_completed": "Internal task state is not debtor communication.",
  "ghl.task_deleted": "Internal task state is not debtor communication.",
  "ghl.appointment_created": "Appointment state is not debtor communication.",
  "ghl.appointment_updated": "Appointment state is not debtor communication.",
  "ghl.appointment_deleted": "Appointment state is not debtor communication.",
} as const;

export const JOB_CONVERSATION_EVENT_TYPES = [
  ...GHL_CAPTURED_MESSAGE_EVENT_TYPES,
  "client.call_complete",
  "client.message_in",
  "supplier.email_in",
] as const;
