import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { invoiceDivisionTag } from './invoice_division_tag.ts'

const option = 'SW - FENCING'
const loaded = { optionsLoaded: true, activeOptions: new Set([option]) }

Deno.test('a known active division sets the line tag', () => {
  assertEquals(invoiceDivisionTag(option, loaded), {
    tracking: [{ Name: 'Business Unit', Option: option }],
    problem: null,
  })
})

Deno.test('an unknown job division takes precedence over an unread option list', () => {
  assertEquals(invoiceDivisionTag('', { ...loaded, optionsLoaded: false }), {
    tracking: [], problem: 'division_not_known',
  })
})

Deno.test('an unread list cannot approve a division', () => {
  assertEquals(invoiceDivisionTag(option, { ...loaded, optionsLoaded: false }), {
    tracking: [], problem: 'options_not_loaded',
  })
})

Deno.test('a known job division missing from the active list is reported', () => {
  assertEquals(invoiceDivisionTag('SW - PATIOS', loaded), {
    tracking: [], problem: 'division_option_not_active',
  })
})

Deno.test('the stored-option path has no silent catch or Xero category lookup', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  const create = source.slice(source.indexOf('async function createInvoice('))
  const switchedOn = create.slice(create.indexOf('if (useStoredOptions)'))
  const branch = switchedOn.slice(0, switchedOn.indexOf('} else {'))
  assertStringIncludes(branch, 'invoiceDivisionTag(option, standard)')
  assertEquals(/catch\s*(?:\([^)]*\))?\s*\{(?:\s|\/\*[\s\S]*?\*\/)*\}/.test(branch), false)
  assertEquals(branch.includes('/TrackingCategories'), false)
})
