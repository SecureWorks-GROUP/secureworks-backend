import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { LEGACY_TOOL_URLS, linkSkipsXero, patioScoperNoteLines, scopeToolUrl } from './scope_engine_links.ts'

Deno.test('scopeToolUrl keeps the old tools until a valid engine address is set', () => {
  assertEquals(scopeToolUrl('patio', {}), LEGACY_TOOL_URLS.patio)
  assertEquals(scopeToolUrl('fencing', { patio: 'https://secureworks-group.github.io/secureworks-ux/scopers/patio/' }), LEGACY_TOOL_URLS.fencing)
  assertEquals(scopeToolUrl('patio', { patio: 'https://secureworks-group.github.io/secureworks-ux/scopers/patio' }), 'https://secureworks-group.github.io/secureworks-ux/scopers/patio/')
})

Deno.test('scopeToolUrl refuses other hosts, http and addresses with a query', () => {
  assertEquals(scopeToolUrl('patio', { patio: 'https://evil.example.com/patio/' }), LEGACY_TOOL_URLS.patio)
  assertEquals(scopeToolUrl('patio', { patio: 'http://secureworks-group.github.io/x/' }), LEGACY_TOOL_URLS.patio)
  assertEquals(scopeToolUrl('patio', { patio: 'https://secureworks-group.github.io/x/?jobId=1' }), LEGACY_TOOL_URLS.patio)
  assertEquals(scopeToolUrl('patio', { patio: 'not a url' }), LEGACY_TOOL_URLS.patio)
})

Deno.test('patioScoperNoteLines reads the engine record and the job row', () => {
  const lines = patioScoperNoteLines(
    { tool: 'patio-scoper', family: 'Skillion, Trimdek', revision: { n: 3 }, earlier: [{}, {}], lines: [{}, {}, {}], supported: true },
    { client_name: 'SE TEST, delete me', site_address: '1 Test St', site_suburb: 'Perth', job_number: 'SWP-1' },
  )
  assertEquals(lines, ['👤 SE TEST, delete me', '📍 1 Test St Perth', '', '🏠 Patio: Skillion, Trimdek', '📄 Sealed revision 3 (2 earlier)', '🧾 Order lines: 3', '', '📝 Job Ref: SWP-1'])
})

Deno.test('linkSkipsXero skips the Xero contact only on an exact true', () => {
  assertEquals(linkSkipsXero({ skip_xero: true }), true)
  for (const body of [{}, { skip_xero: 'true' }, { skip_xero: 1 }, { skip_xero: false }, { skipXero: true }, null, undefined, 'x']) {
    assertEquals(linkSkipsXero(body), false)
  }
})
