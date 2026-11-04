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

/** Patio sales stage "Quote Sent / Follow up". Fencing sales stage "Following up Quote Sent (Site visit)". */
export const QUOTE_SENT_STAGE_ID = {
  patio: "d2fb3af7-91e5-4317-b778-2be117341f07",
  fencing: "02476ea1-6ef4-4b73-80fa-7d685c016bf7",
} as const;

/** The stage a sent quote moves to. Null for a trade that has no sales pipeline here. */
export function quoteSentStageId(jobType: string | null | undefined): string | null {
  const t = (jobType || "").toLowerCase();
  if (t === "patio" || t === "decking" || t === "combo") return QUOTE_SENT_STAGE_ID.patio;
  if (t === "fencing" || t === "fence") return QUOTE_SENT_STAGE_ID.fencing;
  return null;
}

/** Rev N from a sealed scope or its pricing, when the engine stored a revision number. No prices. */
export function revisionLabelFromSealed(scope: unknown, pricing: unknown): string | null {
  const nOf = (o: unknown, depth = 0): number | null => {
    if (!o || typeof o !== "object" || depth > 4) return null;
    const rec = o as Record<string, unknown>;
    const rev = rec.revision;
    if (rev && typeof rev === "object" && typeof (rev as Record<string, unknown>).n === "number") {
      return (rev as Record<string, unknown>).n as number;
    }
    return nOf(rec.identity, depth + 1);
  };
  const n = nOf(scope) ?? nOf(pricing);
  return n == null ? null : `Rev ${n}`;
}

/** Note text for a sent quote. Names the quote and the revision. Carries no price and no address. */
export function quoteSentNoteBody(o: { quoteNumber?: string | null; revisionLabel?: string | null }): string {
  const quote = (o.quoteNumber || "").trim();
  const rev = (o.revisionLabel || "").trim();
  const head = quote ? `Quote ${quote}` : "Quote";
  return rev ? `${head} ${rev} sent.` : `${head} sent.`;
}

export type QuoteSentStageMove = { opportunityId: string; stageId: string; jobId?: string };

/** What a successful quote send tells GHL. No contact: no note. No opportunity or no stage: no move. */
export function quoteSentGhl(o: {
  contactId: string | null | undefined;
  jobId?: string | null;
  opportunityId?: string | null;
  jobType?: string | null;
  quoteNumber?: string | null;
  revisionLabel?: string | null;
}): { note: GhlEmailNoteRequest | null; stage: QuoteSentStageMove | null } {
  const note = o.contactId
    ? {
      contactId: o.contactId,
      ...(o.jobId ? { jobId: o.jobId } : {}),
      body: quoteSentNoteBody({ quoteNumber: o.quoteNumber, revisionLabel: o.revisionLabel }),
    }
    : null;
  const stageId = quoteSentStageId(o.jobType);
  const stage = o.opportunityId && stageId
    ? { opportunityId: o.opportunityId, stageId, ...(o.jobId ? { jobId: o.jobId } : {}) }
    : null;
  return { note, stage };
}
