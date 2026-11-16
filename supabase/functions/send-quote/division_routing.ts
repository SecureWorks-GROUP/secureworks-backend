// Which inbox and which words a quote email and the accept page use, by job type.
// Fencing goes to fencing@, a general job (SWG-) to admin@ (director's ruling, 12 Nov 2026),
// everything else to patios@. A general job's subject and accept page never name its type.

const ADMIN_INBOX = 'admin'

function divisionMailbox(jobType: string | null | undefined): string {
  if (jobType === 'fencing') return 'fencing'
  if (jobType === 'general') return ADMIN_INBOX
  return 'patios'
}

/** Reply-to for a customer email, tagged with the job number so replies thread to the job. */
export function getClientReplyTo(jobType: string | null | undefined, jobNumber?: string | null): string {
  const tag = jobNumber ? `+${jobNumber}` : ''
  return `${divisionMailbox(jobType)}${tag}@secureworkswa.com.au`
}

/** The division inbox that gets a fixed copy of a customer email. */
export function getDivisionInbox(jobType: string | null | undefined): string {
  return `${divisionMailbox(jobType)}@secureworkswa.com.au`
}

/** Default quote email subject (used when the sender gives none). */
export function quoteEmailSubject(jobType: string | null | undefined): string {
  if (jobType === 'general') return 'Your quote from SecureWorks Group'
  return `Your ${jobType || 'project'} quote from SecureWorks Group`
}

/** What the accept page and the deposit invoice email call the work: "Your <this> at <address> is confirmed." */
export function nextStepsProjectLabel(projectType: string | null | undefined): string {
  if (projectType === 'general') return 'project'
  const typeName = projectType === 'fencing' ? 'fencing' : projectType === 'decking' ? 'decking' : 'patio'
  return `${typeName} project`
}

/** The quote email's heading: a general job's never names its type (director, 12 Nov 2026, item 1d). */
export function quoteEmailHeading(projectType: string | null | undefined): string {
  if (projectType === 'general') return 'Your quote is ready'
  return `Your ${projectType || 'project'} quote is ready`
}

/** "...the opportunity to quote on your <this>": a general job's says "project", never "general project". */
export function quoteEmailProjectWords(projectType: string | null | undefined): string {
  if (projectType === 'general') return 'project'
  return `${projectType || 'project'} project`
}

/**
 * The line a customer calls about their quote (director, 16 Nov 2026 21:01, from the wiki's line canon: 774 patios,
 * 772 fencing, 771 admin): the one place send-quote's quote page, its messages (the acceptance and waiting pages, the
 * Accept "checking" box) and the quote email read it, so one trade's customer never sees two numbers. Any other job
 * keeps the admin line. The invoice and council emails keep their own numbers.
 */
export const QUOTE_PHONES = Object.freeze({ patio: '0489 267 774', fencing: '0489 267 772', other: '0489 267 771' })
export function quotePhone(jobType: string | null | undefined): string {
  return jobType === 'fencing' ? QUOTE_PHONES.fencing : jobType === 'patio' ? QUOTE_PHONES.patio : QUOTE_PHONES.other
}
export function quotePhoneHref(jobType: string | null | undefined): string {
  return 'tel:+61' + quotePhone(jobType).replace(/\s+/g, '').slice(1)
}
