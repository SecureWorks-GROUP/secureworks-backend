// ════════════════════════════════════════════════════════════
// monitor-inbox email triage: rules only (context slice EM0)
// ════════════════════════════════════════════════════════════
//
// Both monitor-inbox paths (the user-mailbox poll and the M365 group
// reader) classify through `classifyEmail` below, and it returns the rules
// result. There is no model call and no network call: the paid Haiku
// classifier that used to run first on every email was removed so capture
// never depends on (or pays for) a model. The rules were already the
// fallback whenever the model was missing, slow or returned "other"; they
// are copied here unchanged.
//
// Pure and synchronous on purpose: a Promise-returning classifier is the
// shape that let a network call hide inside it.

export type EmailClassification = {
  classification: string
  priority: string
  action_needed: string | null
  job_ref: string | null
}

/** First job, legacy job or PO reference in the subject or preview, else null. */
export function extractJobRef(subject: string, bodyPreview: string): string | null {
  const haystack = `${subject}\n${bodyPreview}`
  const legacy = haystack.match(/\bSW\d{4,}\b/i)
  if (legacy) return legacy[0]
  const prefixed = haystack.match(/\bSW[PFD]-\d+\b/i)
  if (prefixed) return prefixed[0]
  const po = haystack.match(/\bPO-?\d{6}\b/i)
  if (po) return po[0].toUpperCase().startsWith('PO-') ? po[0].toUpperCase() : `PO-${po[0].replace(/PO/i, '')}`
  return null
}

/** Rules triage. Context must not depend on a paid classifier being funded. */
export function classifyEmail(
  from: string,
  subject: string,
  bodyPreview: string,
): EmailClassification {
  const fromLower = (from || '').toLowerCase()
  const hay = `${subject}\n${bodyPreview}`.toLowerCase()
  const job_ref = extractJobRef(subject, bodyPreview)

  if (
    /noreply|no-reply|mailer-daemon|notifications?@|newsletter|unsubscribe/.test(fromLower) ||
    /\bunsubscribe\b|\bview in browser\b|\bemail preferences\b/.test(hay)
  ) {
    return { classification: 'newsletter', priority: 'low', action_needed: null, job_ref }
  }
  if (/\burgent\b|\basap\b|\bcomplaint\b|\bunhappy\b|\bangry\b/.test(hay)) {
    return { classification: 'complaint', priority: 'high', action_needed: 'review', job_ref }
  }
  if (/\binvoice\b|\binv-\d+/i.test(hay)) {
    return { classification: 'invoice', priority: 'normal', action_needed: null, job_ref }
  }
  if (/\bquote\b|\bquotation\b|\bestimate\b/.test(hay)) {
    return { classification: 'supplier_quote', priority: 'normal', action_needed: null, job_ref }
  }
  if (/\bcouncil\b|\bpermit\b|\bba\b|\bbuilding approval\b/.test(hay)) {
    return { classification: 'council', priority: 'high', action_needed: 'review', job_ref }
  }
  // Default: treat as client reply so Context gets the words. Attribution
  // ladder + Luna decide the job; empty/automated rows stay out of extraction.
  return { classification: 'client_reply', priority: 'normal', action_needed: null, job_ref }
}
