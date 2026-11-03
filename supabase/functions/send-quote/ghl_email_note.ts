// The request send-quote posts to ghl-proxy add_note to log an outbound email on the customer's GHL contact.
// Naming the job (jobId) makes ghl-proxy record the note on the job too (job_events ghl_note_added), which is
// how the job system knows GHL was updated (Scope Engine finish line B1).
export type GhlEmailNoteRequest = { contactId: string; jobId?: string; body: string };

export function ghlEmailNoteRequest(o: {
  contactId: string | null | undefined;
  jobId?: string | null;
  subject: string;
  recipient: string;
}): GhlEmailNoteRequest | null {
  if (!o.contactId) return null;
  return {
    contactId: o.contactId,
    ...(o.jobId ? { jobId: o.jobId } : {}),
    body: `Email sent: "${o.subject}" to ${o.recipient}`,
  };
}
