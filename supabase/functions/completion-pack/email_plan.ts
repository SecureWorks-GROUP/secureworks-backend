// Completion-pack client email. The pack is stored either way. Sending the
// "Project Completion Report" email needs the owner's okay on the exact
// text, so the flag stays off until that yes. Missing or unreadable is off.

export const COMPLETION_PACK_CLIENT_EMAIL_FLAG = "completion_pack_client_email_v1";

export function completionPackEmailPlan(input: {
  sendRequested: boolean;
  flagEnabled: unknown;
  hasContact: boolean;
}): {
  send: boolean;
  result: "email disabled" | "not requested" | "no contact" | "send";
} {
  if (input.flagEnabled !== true) {
    return { send: false, result: "email disabled" };
  }
  if (!input.sendRequested) return { send: false, result: "not requested" };
  if (!input.hasContact) return { send: false, result: "no contact" };
  return { send: true, result: "send" };
}
