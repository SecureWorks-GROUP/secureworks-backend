// ── Rescue SES remainder item 2: the structural single-writer check ──────────
// Spec: coding/work/campaigns/makesafe-system/SPEC.md item 2, acceptance check
// "A structural test asserts there is exactly one substatus write site in
// ops-api, or that any additional one is on a named allowlist. This is the test
// that makes a ninth site impossible rather than merely unlikely."
//
// WHY THIS FILE EXISTS IN THIS SHAPE. A source-text check is only worth the
// bytes if it can actually go red. This campaign has already produced checks
// that could not fail, one of them a source search whose subject and predicate
// came from the same value — it re-derived the expectation from the file it was
// checking and then agreed with itself.
//
// So the predicate here is EXTERNAL: `EXPECTED_SITES` below is hand-written and
// committed. The subject is the real `index.ts`. A new `makesafe_job_details`
// mutation anywhere in that file — gated, ungated, substatus-carrying or not —
// changes the derived list and fails this test, which forces the author to come
// here and say which of the two doors their write goes through.
//
// It was verified red before it was trusted: a ninth substatus write site was
// added to `index.ts` locally, this test failed on it, and the site was removed.
//
// The payload classifier deliberately OVER-approximates. A spread, a dynamic
// key, or an identifier it cannot resolve is `unknown`, not `absent`. Guessing
// "no substatus here" is the failure this check exists to prevent, so the
// uncertain answer has to be the loud one.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'

const INDEX_PATH = new URL('./index.ts', import.meta.url)
const SOURCE = await Deno.readTextFile(INDEX_PATH)

const TABLE = "from('makesafe_job_details')"
const MUTATIONS = new Set(['update', 'insert', 'upsert', 'delete'])

type SubstatusVerdict = 'present' | 'absent' | 'unknown'

interface WriteSite {
  fn: string
  op: string
  substatus: SubstatusVerdict
}

/** Walk from `open` (index of `(` or `{`) to its matching close. Returns the index of the close. */
function matchDelimiter(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  let i = open
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false
  for (; i < src.length; i++) {
    const c = src[i]
    const prev = src[i - 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (c === '/' && prev === '*') inBlockComment = false
      continue
    }
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '/' && src[i + 1] === '/') { inLineComment = true; continue }
    if (c === '/' && src[i + 1] === '*') { inBlockComment = true; continue }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue }
    if (pairs[c]) { stack.push(pairs[c]); continue }
    if (c === ')' || c === '}' || c === ']') {
      const want = stack.pop()
      if (stack.length === 0) return i
      if (want !== c) return -1
    }
  }
  return -1
}

/** Nearest preceding column-0 function declaration. */
function enclosingFunction(src: string, at: number): string {
  const head = src.slice(0, at)
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm
  let name = '<module>'
  let m: RegExpExecArray | null
  while ((m = re.exec(head)) !== null) name = m[1]
  return name
}

/** present beats unknown beats absent — the loud answer always survives a merge. */
function worst(verdicts: SubstatusVerdict[]): SubstatusVerdict {
  if (verdicts.includes('present')) return 'present'
  if (verdicts.includes('unknown')) return 'unknown'
  return 'absent'
}

/** Object-literal text of `const/let/var <ident> … = { … }`, or null. */
function declaredLiteral(ident: string, fnBody: string): string | null {
  const declRe = new RegExp(`(?:const|let|var)\\s+${ident}\\b[^=]*=\\s*`, 'm')
  const m = declRe.exec(fnBody)
  if (!m) return null
  const start = m.index + m[0].length
  if (fnBody[start] !== '{') return null
  const close = matchDelimiter(fnBody, start)
  return close > 0 ? fnBody.slice(start, close + 1) : null
}

/**
 * Does this expression carry a substatus?
 *
 * Object literal -> its own keys, plus every `...spread` resolved one hop.
 * Identifier     -> its declaration, plus `x.substatus =`, `x['substatus']`,
 *                   dynamic `x[k] =`, and `Object.assign(x, …)` sources.
 * Anything else  -> unknown.
 *
 * Spreads and Object.assign are RESOLVED rather than surrendered to `unknown`,
 * because an allowlist that fills up with false positives stops being read.
 * What cannot be resolved is still `unknown`, never `absent`.
 */
function classifyExpression(expr: string, fnBody: string, depth = 0): SubstatusVerdict {
  const trimmed = expr.trim()
  if (depth > 3) return 'unknown'

  if (trimmed.startsWith('{')) {
    if (/\bsubstatus\b/.test(trimmed)) return 'present'
    const verdicts: SubstatusVerdict[] = ['absent']
    const spreadRe = /\.\.\.\s*([A-Za-z_$][\w$]*)?/g
    let m: RegExpExecArray | null
    while ((m = spreadRe.exec(trimmed)) !== null) {
      // `...someCall()` / `...(cond ? a : b)` — nothing to resolve.
      if (!m[1]) return 'unknown'
      const lit = declaredLiteral(m[1], fnBody)
      verdicts.push(lit === null ? 'unknown' : classifyExpression(lit, fnBody, depth + 1))
    }
    return worst(verdicts)
  }

  const ident = /^[A-Za-z_$][\w$]*$/.test(trimmed) ? trimmed : null
  if (!ident) return 'unknown'
  if (new RegExp(`\\b${ident}\\s*\\.\\s*substatus\\s*=`).test(fnBody)) return 'present'
  if (new RegExp(`\\b${ident}\\s*\\[\\s*['"]substatus['"]\\s*\\]`).test(fnBody)) return 'present'
  // Dynamic-key assignment: `updates[key] = …`. Cannot be ruled out.
  if (new RegExp(`\\b${ident}\\s*\\[\\s*[A-Za-z_$][\\w$]*\\s*\\]\\s*=`).test(fnBody)) return 'unknown'

  const verdicts: SubstatusVerdict[] = []
  // `Object.assign(ident, X)` merges X's keys in. Resolve X the same way.
  const assignRe = new RegExp(`Object\\.assign\\(\\s*${ident}\\s*,([^)]*)\\)`, 'g')
  let a: RegExpExecArray | null
  while ((a = assignRe.exec(fnBody)) !== null) {
    verdicts.push(classifyExpression(a[1].trim(), fnBody, depth + 1))
  }

  const lit = declaredLiteral(ident, fnBody)
  // A parameter (no literal declaration in this body) is a pass-through.
  verdicts.push(lit === null ? 'unknown' : classifyExpression(lit, fnBody, depth + 1))
  return worst(verdicts)
}

const classifyPayload = (payload: string, fnBody: string) => classifyExpression(payload, fnBody)

/** Body of the enclosing column-0 function containing `at`. */
function enclosingFunctionBody(src: string, at: number): string {
  const head = src.slice(0, at)
  const re = /^(?:export\s+)?(?:async\s+)?function\s+\w+/gm
  let start = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(head)) !== null) start = m.index
  if (start < 0) return src
  const brace = src.indexOf('{', src.indexOf('(', start))
  if (brace < 0) return src
  const close = matchDelimiter(src, brace)
  return close > 0 ? src.slice(brace, close + 1) : src.slice(brace)
}

function collectWriteSites(src: string): WriteSite[] {
  const sites: WriteSite[] = []
  let from = src.indexOf(TABLE)
  while (from !== -1) {
    const cursor = from + TABLE.length
    // Walk the chain to the first method call after `from(...)`.
    const chain = /^[\s\r\n]*\.\s*(\w+)\s*\(/
    const rest = src.slice(cursor, cursor + 400)
    const m = chain.exec(rest)
    if (m && MUTATIONS.has(m[1])) {
      const openParen = cursor + m.index + m[0].length - 1
      const closeParen = matchDelimiter(src, openParen)
      const payload = closeParen > 0 ? src.slice(openParen + 1, closeParen) : ''
      sites.push({
        fn: enclosingFunction(src, from),
        op: m[1],
        substatus: classifyPayload(payload, enclosingFunctionBody(src, from)),
      })
    }
    from = src.indexOf(TABLE, cursor)
  }
  return sites
}

// ─────────────────────────────────────────────────────────────────────────────
// THE MANIFEST. Hand-written. Every `makesafe_job_details` mutation in
// index.ts, in source order, with the reason it is where it is.
//
// To change this list you must have changed a production write site. That is
// the point: the edit is cheap, but it cannot happen by accident.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED_SITES: WriteSite[] = [
  // Card creation. INSERT establishes a card's FIRST substatus; there is no
  // transition to gate and no prior row to read. Named escape.
  { fn: 'createMakesafeJob', op: 'insert', substatus: 'present' },
  // The details editor's NON-substatus branch. Dynamic-key patch (`updates[key]`),
  // so the classifier cannot prove substatus is absent — and it is right not to
  // try: the substatus-carrying branch returns above through
  // writeMakesafeSubstatus, and this statement is only reached when it did not.
  { fn: 'updateMakesafeDetails', op: 'update', substatus: 'unknown' },
  // Family reconciliation: report_type kept in sync, no stage/substatus change.
  { fn: 'updateMakesafeJobFamily', op: 'update', substatus: 'absent' },
  // ── THE ONE GATED WRITER ──────────────────────────────────────────────────
  // Every one of the eight origins, and both named ungated escapes, reach the
  // table through this single query builder.
  { fn: '_makesafeDetailUpdateQuery', op: 'update', substatus: 'unknown' },
  // portal_report_done's IDEMPOTENT branch: external_links merge + verification
  // stamp. Explicitly does not move substatus (the advance returned above).
  { fn: 'markMakesafePortalReportDone', op: 'update', substatus: 'absent' },
  // Recheck-queue markers. No substatus.
  { fn: 'makesafePortalRecheckEnqueue', op: 'update', substatus: 'absent' },
  { fn: 'makesafeStoryRecompute', op: 'update', substatus: 'absent' },
  // Attendance-cycle pointer bind on photo upload. No substatus.
  { fn: 'bindMakesafeMediaToCurrentCycle', op: 'update', substatus: 'absent' },
  // Combined-work-order SECONDARY card: report_type only. The comment at that
  // site records that it deliberately does NOT advance substatus. (The primary
  // report-only park in the same function is the named ungated escape and now
  // reaches the table through _makesafeDetailUpdateQuery.)
  { fn: 'approveIntakeDraft', op: 'update', substatus: 'absent' },
  // external_links patch on an existing card.
  { fn: '_patchExistingJobExternalLinks', op: 'update', substatus: 'absent' },
  // Historical-backfill repair INSERT. Same reason as createMakesafeJob.
  { fn: 'ensureHistoricalBackfillJobCard', op: 'insert', substatus: 'present' },
  // Roof submit's ALREADY-ADVANCED branch: verification stamp only, and the
  // comment there says it must NEVER regress the substatus.
  { fn: 'advanceRoofReportChecklist', op: 'update', substatus: 'absent' },
  // Cancel attribution columns. No substatus (the cancel lives on jobs.status).
  { fn: 'cancelMakesafe', op: 'update', substatus: 'absent' },
]

/**
 * The closed set of functions permitted to mutate substatus on this table.
 * Everything else must route through `_makesafeDetailUpdateQuery`.
 */
const SUBSTATUS_WRITERS_ALLOWED = new Set([
  '_makesafeDetailUpdateQuery', // writeMakesafeSubstatus + the two named escapes
  'createMakesafeJob', // first-substatus INSERT
  'ensureHistoricalBackfillJobCard', // first-substatus INSERT (historical repair)
  'updateMakesafeDetails', // dynamic-key patch; substatus branch returns above
])

Deno.test('structural: every makesafe_job_details mutation is accounted for', () => {
  const found = collectWriteSites(SOURCE)
  // Deep equality against the committed manifest. A NEW write site anywhere —
  // including a ninth substatus write — changes this list and fails here.
  assertEquals(found, EXPECTED_SITES)
})

Deno.test('structural: no substatus write outside the one writer or a named escape', () => {
  const offenders = collectWriteSites(SOURCE)
    .filter((s) => s.substatus !== 'absent')
    .filter((s) => !SUBSTATUS_WRITERS_ALLOWED.has(s.fn))
    .map((s) => `${s.fn} (.${s.op}, substatus=${s.substatus})`)
  assertEquals(
    offenders,
    [],
    'a makesafe_job_details write that can carry substatus lives outside ' +
      'writeMakesafeSubstatus and outside the named escapes. Route it through ' +
      'writeMakesafeSubstatus, or add a MakesafeSubstatusUngatedEscape and say why.',
  )
})

Deno.test('structural: the parser can actually see a substatus payload', () => {
  // Guards the guard. If `collectWriteSites` silently stopped matching — a
  // renamed table string, a chain shape it cannot walk — both tests above would
  // pass on an EMPTY list and prove nothing. This is the tripwire for that.
  const sites = collectWriteSites(SOURCE)
  assertEquals(sites.length > 0, true, 'parser found no write sites at all')
  assertEquals(
    sites.some((s) => s.substatus === 'present'),
    true,
    'parser classified nothing as carrying substatus; it has gone blind',
  )
  assertEquals(
    sites.filter((s) => s.fn === '_makesafeDetailUpdateQuery').length,
    1,
    'the single gated writer is missing or duplicated',
  )
})

Deno.test('structural: the classifier flags a raw substatus write', () => {
  // The classifier proved against synthetic sources, so its verdicts are not
  // taken on trust from the one file it happens to read.
  const raw = `
async function someNewAction(client: any, jobId: string) {
  await client.from('makesafe_job_details')
    .update({ substatus: 'complete', updated_at: new Date().toISOString() })
    .eq('job_id', jobId)
}
`
  assertEquals(collectWriteSites(raw), [
    { fn: 'someNewAction', op: 'update', substatus: 'present' },
  ])

  const viaVariable = `
async function anotherNewAction(client: any, jobId: string) {
  const patch: Record<string, any> = { updated_at: 'now' }
  patch.substatus = 'complete'
  await client.from('makesafe_job_details').update(patch).eq('job_id', jobId)
}
`
  assertEquals(collectWriteSites(viaVariable), [
    { fn: 'anotherNewAction', op: 'update', substatus: 'present' },
  ])

  const innocent = `
async function harmlessAction(client: any, jobId: string) {
  await client.from('makesafe_job_details').update({ invoice_notes: null }).eq('job_id', jobId)
}
`
  assertEquals(collectWriteSites(innocent), [
    { fn: 'harmlessAction', op: 'update', substatus: 'absent' },
  ])
})
