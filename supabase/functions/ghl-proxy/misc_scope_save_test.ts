// deno-lint-ignore-file no-import-prefix
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { miscScopeSaveRefusal } from './misc_scope_save.ts'
import { scopeJsonHash } from './hardening_helpers.ts'

const incoming = { tool: 'misc-scoper', draft: { description: 'Custom work' } }
const target = { type: 'general', status: 'draft', scope_json: {}, pricing_json: {} }
const paired = { tool: 'misc-scoper', source: 'quick_quote' }
const cursors = async () => ({ base_scope_hash: await scopeJsonHash({}), base_pricing_hash: await scopeJsonHash({}), pricing_json: paired })

Deno.test('Misc cursor guard accepts an exact owned or empty draft and preserves legacy tool paths', async () => {
  assertEquals(await miscScopeSaveRefusal(target, incoming, await cursors()), null)
  for (const tool of ['patio-scoper', 'fence-designer', undefined]) {
    assertEquals(await miscScopeSaveRefusal({ type: 'fencing', status: 'accepted' }, { tool }), null)
  }
})

Deno.test('Misc cursor guard requires both scope and pricing snapshots even for an empty draft', async () => {
  const meta = await cursors()
  assertEquals((await miscScopeSaveRefusal(target, incoming, { pricing_json: paired }))?.code, 'misc_scope_cursor_required')
  assertEquals((await miscScopeSaveRefusal(target, incoming, { pricing_json: paired, base_scope_hash: meta.base_scope_hash }))?.code, 'misc_pricing_cursor_required')
})

Deno.test('Misc cursor guard keeps malformed or another tool snapshots instead of replacing them', async () => {
  for (const value of [[], 'legacy', { tool: 'patio-scoper' }]) {
    assertEquals((await miscScopeSaveRefusal({ ...target, scope_json: value }, incoming, await cursors()))?.code, 'misc_foreign_scope')
    assertEquals((await miscScopeSaveRefusal({ ...target, pricing_json: value }, incoming, await cursors()))?.code, 'misc_foreign_pricing')
  }
})
