// The reply reader's tag parser, pure so it is tested beside it
// (po_email_tag_test.ts). receive-po-email/index.ts is the only caller.
//
// orders+PO-467989-SWP-25008@secureworksgroup.app → { poNumber: 'PO-467989', jobNumber: 'SWP-25008' }
// orders+PO-1000001-SWR-261499@secureworksgroup.app → { poNumber: 'PO-1000001', jobNumber: 'SWR-261499' }
// orders+PO-467989@secureworksgroup.app → { poNumber: 'PO-467989', jobNumber: null }
// orders+PO001-SWP25019@secureworksgroup.app → { poNumber: 'PO001', jobNumber: 'SWP25019' }
//
// Dispatch slice 5 (docs/dispatch-slice-5-contract.md): the job part is `SW`,
// one to three letters, an optional hyphen and digits, so a repair job number
// (SWR-) parses as one. It used to accept SWP and SWF only, and a repair tag
// was looked up whole and fell through to the sender match.
export function parseEmailTag(toEmail: string): { poNumber: string | null; jobNumber: string | null } {
  const match = String(toEmail || '').match(/orders\+([^@]+)@/i)
  if (!match) return { poNumber: null, jobNumber: null }

  const tag = match[1]

  // Structured: PO-NNNNNN, then an optional job number.
  const structuredMatch = tag.match(/^(PO-?\d+)(?:-(SW[A-Z]{1,3}-?\d+))?$/i)
  if (structuredMatch) {
    return { poNumber: structuredMatch[1], jobNumber: structuredMatch[2] || null }
  }

  // Fallback: split on dash between alpha and alpha (e.g. PO001-SWP25019)
  const fallbackMatch = tag.match(/^([A-Z]+\d+)-([A-Z]+\d+)$/i)
  if (fallbackMatch) {
    return { poNumber: fallbackMatch[1], jobNumber: fallbackMatch[2] }
  }

  // Last resort: treat entire tag as PO number
  return { poNumber: tag, jobNumber: null }
}

// Fallback: the order number in the subject line, with or without its hyphen
// (Dispatch subjects read "Purchase order PO-1000001 for SWF-261525").
export function parseSubjectForPO(subject: string): string | null {
  const match = String(subject || '').match(/\bPO-?\d{3,}\b/i)
  return match ? match[0].toUpperCase() : null
}
