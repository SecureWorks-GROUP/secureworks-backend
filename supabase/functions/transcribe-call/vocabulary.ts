// The word list Whisper is given with every call recording (TP-18, 28 Oct 2026).
//
// Whisper takes a short `prompt` and leans towards the words in it, so our staff
// names, suppliers, trade products and the suburbs we work in are spelled the
// way our records spell them instead of the nearest common word ("Khairo", not
// "Kyle"; "Marnin", not "Marvin"). It is a hint, never a fact: nothing here is
// written into the transcript, and a failed read only shortens the list.
//
// Whisper reads at most the last 224 tokens of a prompt, so the list is capped
// in characters and ordered most important first: staff, then suppliers, then
// products, then suburbs.

/** Words every call may use, in our own spelling. Trade products and the brands crews name on calls. */
export const TRANSCRIPTION_FIXED_TERMS: readonly string[] = [
  'SecureWorks', 'Colorbond', 'Stratco', 'Lysaght', 'Outback', 'Trimdek', 'Spandek', 'Klip-Lok', 'Solarspan',
  'Bondor', 'Fielders', 'Steeline', 'Hardie', 'Modwood', 'Xero', 'make safe', 'patio', 'gable', 'skillion',
  'flyover', 'fascia', 'retaining wall', 'sleeper', 'plinth', 'infill', 'slat fence', 'pool fence', 'neighbour',
]

/** At most this many characters of list, about 200 Whisper tokens with the opening sentence. */
export const TRANSCRIPTION_PROMPT_MAX_CHARS = 800

const clean = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  : ''

/** A staff member's first name and full name, as our records hold them (users.name). */
export function staffTerms(names: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = clean(raw)
    if (!name || name.includes('@') || /\d/.test(name)) continue
    const first = name.split(' ')[0]
    if (first.length >= 2) out.push(first)
    if (name !== first) out.push(name)
  }
  return out
}

/** A supplier's trading name without its legal tail ("Pty Ltd", "Trust", a trailing bracket). */
export function supplierTerm(raw: unknown): string {
  return clean(raw)
    .replace(/\b(?:pty|ltd|limited|proprietary|trust|trustee for|the trustee for|atf)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/[,&\s]+$/, '')
}

/**
 * The prompt: one plain sentence, then each list in order, every term once (case-insensitive), cut at a whole term
 * when the next would pass the cap.
 */
export function transcriptionPrompt(lists: { staff?: readonly unknown[]; suppliers?: readonly unknown[]; suburbs?: readonly unknown[] }): string {
  const opening = 'A phone call for SecureWorks Group, a fencing, patio and make safe business in Perth, Western Australia.'
  const seen = new Set<string>()
  const terms: string[] = []
  const add = (term: string) => {
    const t = clean(term)
    if (t.length < 2 || t.length > 60) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(t)
  }
  for (const t of staffTerms(lists.staff ?? [])) add(t)
  for (const s of lists.suppliers ?? []) add(supplierTerm(s))
  for (const t of TRANSCRIPTION_FIXED_TERMS) add(t)
  for (const s of lists.suburbs ?? []) add(clean(s).replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w/g, c => c.toLowerCase()))
  let out = `${opening} Words used:`
  for (const [i, t] of terms.entries()) {
    const next = `${out}${i === 0 ? ' ' : ', '}${t}`
    if (next.length + 1 > TRANSCRIPTION_PROMPT_MAX_CHARS) break
    out = next
  }
  return `${out}.`
}

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any }

/**
 * The lists from our records: staff names (users.name), the 40 active suppliers, and the 40 suburbs with the most
 * jobs in the last year. Any read that fails is left out, never the transcription.
 */
export async function loadTranscriptionPrompt(sb: Client, orgId: string): Promise<{ prompt: string; failed: string[] }> {
  const failed: string[] = []
  const read = async (label: string, run: () => Promise<{ data: unknown; error: unknown }>): Promise<Record<string, unknown>[]> => {
    try {
      const { data, error } = await run()
      if (error || !Array.isArray(data)) { failed.push(label); return [] }
      return data as Record<string, unknown>[]
    } catch {
      failed.push(label)
      return []
    }
  }
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString()
  const [users, suppliers, jobs] = await Promise.all([
    read('users', () => sb.from('users').select('name').eq('org_id', orgId).limit(100)),
    read('suppliers', () => sb.from('suppliers').select('name').eq('org_id', orgId).eq('is_active', true).order('updated_at', { ascending: false }).limit(40)),
    read('suburbs', () => sb.from('jobs').select('site_suburb').eq('org_id', orgId).gte('created_at', since).not('site_suburb', 'is', null).limit(1000)),
  ])
  const counts = new Map<string, number>()
  for (const row of jobs) {
    const suburb = clean(row.site_suburb)
    if (suburb && !/tbc/i.test(suburb)) counts.set(suburb.toLowerCase(), (counts.get(suburb.toLowerCase()) ?? 0) + 1)
  }
  const suburbs = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 40).map(([s]) => s)
  return { prompt: transcriptionPrompt({ staff: users.map(u => u.name), suppliers: suppliers.map(s => s.name), suburbs }), failed }
}
