// Calendar recurrence: turns the ops dashboard's "Repeat" rule into dates.
// ---------------------------------------------------------------------------
// The Add Event modal (ops.html buildRecurrenceRule) sends a rule like:
//   { freq: 'weekly', interval: 1, endType: 'never' }
//   { freq: 'custom', interval: 2, endType: 'count', endCount: 10, days: [0, 2] }
// freq: daily | weekly | monthly | yearly | weekdays | custom
//   custom = every `interval` weeks on `days` (0 = Mon ... 6 = Sun, the
//   modal's checkbox order, NOT JavaScript's getDay where 0 = Sunday).
// endType: never | count | date
//   never = one year from the start date (the modal promises a 1-year cap).
//
// Every series is also hard-capped at RECURRENCE_MAX_OCCURRENCES rows so a bad
// rule can never flood the calendar. Pure functions, no I/O: dates are plain
// 'YYYY-MM-DD' strings and all maths is done in UTC so no timezone can shift
// a meeting onto the wrong day.

export const RECURRENCE_MAX_OCCURRENCES = 366

const FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly', 'weekdays', 'custom'])
const END_TYPES = new Set(['never', 'count', 'date'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type RecurrenceRule = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays' | 'custom'
  interval: number
  endType: 'never' | 'count' | 'date'
  endCount?: number
  endDate?: string
  days?: number[]
}

export class RecurrenceRuleError extends Error {}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const d = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function toDate(iso: string): Date {
  return new Date(iso + 'T00:00:00Z')
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  const d = toDate(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return toIso(d)
}

export function daysBetween(fromIso: string, toIso_: string): number {
  return Math.round((toDate(toIso_).getTime() - toDate(fromIso).getTime()) / 86400000)
}

// Monday-based weekday: 0 = Mon ... 6 = Sun (matches the modal's day picker).
function mondayIndex(d: Date): number {
  return (d.getUTCDay() + 6) % 7
}

// The date `months` months after `iso` on the same day of the month, or null
// when that month has no such day (31st in a 30-day month, 29 Feb in a common
// year). Skipping, not clamping, matches how calendar apps repeat monthly.
function sameDayMonthsLater(iso: string, months: number): string | null {
  const start = toDate(iso)
  const day = start.getUTCDate()
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1))
  target.setUTCDate(day)
  if (target.getUTCDate() !== day) return null
  return toIso(target)
}

// Validates the raw rule from the request. Returns null when the caller asked
// for no repeat (missing, null, or freq 'none'); throws RecurrenceRuleError on
// anything malformed so the dashboard gets a clear 400 instead of a silent
// single event.
export function normaliseRecurrenceRule(raw: unknown): RecurrenceRule | null {
  if (raw === null || raw === undefined || raw === '') return null
  let input: any = raw
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { throw new RecurrenceRuleError('recurrence_rule is not valid JSON') }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new RecurrenceRuleError('recurrence_rule must be an object')
  }
  const freq = String(input.freq || '').toLowerCase()
  if (freq === 'none' || freq === '') return null
  if (!FREQS.has(freq)) throw new RecurrenceRuleError(`Unknown repeat frequency: ${input.freq}`)

  const interval = input.interval === undefined || input.interval === null ? 1 : Number(input.interval)
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    throw new RecurrenceRuleError('Repeat interval must be a whole number from 1 to 52')
  }

  const endType = String(input.endType || 'never').toLowerCase()
  if (!END_TYPES.has(endType)) throw new RecurrenceRuleError(`Unknown repeat end: ${input.endType}`)

  const rule: RecurrenceRule = { freq: freq as RecurrenceRule['freq'], interval, endType: endType as RecurrenceRule['endType'] }

  if (endType === 'count') {
    const count = Number(input.endCount)
    if (!Number.isInteger(count) || count < 1) {
      throw new RecurrenceRuleError('Number of occurrences must be a whole number of at least 1')
    }
    rule.endCount = Math.min(count, RECURRENCE_MAX_OCCURRENCES)
  } else if (endType === 'date') {
    if (!isIsoDate(input.endDate)) throw new RecurrenceRuleError('Repeat end date is missing or not a date')
    rule.endDate = input.endDate
  }

  if (freq === 'custom') {
    const days = Array.isArray(input.days) ? input.days.map(Number) : []
    if (days.some((d: number) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new RecurrenceRuleError('Repeat days must be 0 (Mon) to 6 (Sun)')
    }
    rule.days = [...new Set<number>(days)].sort((a, b) => a - b)
  }

  return rule
}

// Expands a validated rule from `startDate` into an ordered list of dates.
// The start date is always the first occurrence, except for a custom rule
// whose chosen days do not include the start's weekday (then the series
// starts on the first chosen day on or after it).
export function expandRecurrenceDates(startDate: string, rule: RecurrenceRule): string[] {
  if (!isIsoDate(startDate)) throw new RecurrenceRuleError('Start date is missing or not a date')

  const maxCount = rule.endType === 'count' ? rule.endCount! : RECURRENCE_MAX_OCCURRENCES
  // Last allowed date, inclusive. 'never' = up to (not including) the same
  // date next year: weekly gives 52 meetings, daily gives 365 or 366.
  const lastDate = rule.endType === 'date'
    ? rule.endDate!
    : rule.endType === 'never'
      ? addDays(sameDayMonthsLater(startDate, 12) ?? addDays(startDate, 365), -1)
      : null
  if (lastDate && lastDate < startDate) {
    throw new RecurrenceRuleError('Repeat end date is before the first event')
  }

  const out: string[] = []
  const accept = (iso: string): boolean => {
    if (iso < startDate) return true // before the series starts; keep looking
    if (lastDate && iso > lastDate) return false
    out.push(iso)
    return out.length < maxCount
  }

  // Each loop is bounded by the occurrence cap and, for the skip-prone
  // monthly/yearly rules, by an explicit step limit.
  switch (rule.freq) {
    case 'daily':
      for (let i = 0; accept(addDays(startDate, i * rule.interval)); i++) { /* accept() collects */ }
      break
    case 'weekly':
      for (let i = 0; accept(addDays(startDate, i * 7 * rule.interval)); i++) { /* accept() collects */ }
      break
    case 'weekdays':
      for (let i = 0; i < 7 * RECURRENCE_MAX_OCCURRENCES; i++) {
        const iso = addDays(startDate, i)
        if (mondayIndex(toDate(iso)) >= 5) continue
        if (!accept(iso)) break
      }
      break
    case 'monthly':
    case 'yearly': {
      const stepMonths = rule.freq === 'monthly' ? rule.interval : 12 * rule.interval
      for (let i = 0; i < 4 * RECURRENCE_MAX_OCCURRENCES; i++) {
        const iso = sameDayMonthsLater(startDate, i * stepMonths)
        if (iso === null) continue
        if (!accept(iso)) break
      }
      break
    }
    case 'custom': {
      // Every `interval` weeks, on the chosen weekdays. Weeks are counted
      // from the Monday of the start date's week. No days chosen = the
      // start date's own weekday, so the rule still means something.
      const days = rule.days && rule.days.length ? rule.days : [mondayIndex(toDate(startDate))]
      const weekOneMonday = addDays(startDate, -mondayIndex(toDate(startDate)))
      let done = false
      for (let w = 0; !done && w <= RECURRENCE_MAX_OCCURRENCES; w++) {
        const monday = addDays(weekOneMonday, w * 7 * rule.interval)
        for (const d of days) {
          if (!accept(addDays(monday, d))) { done = true; break }
        }
      }
      break
    }
  }
  return out
}
