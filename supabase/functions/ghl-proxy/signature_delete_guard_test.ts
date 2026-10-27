// ghl-proxy/index.ts calls serve() on import, so its delete_media wiring is
// checked from source, as sms_sender_default_test.ts does. The guard's
// behaviour is tested in _shared/signature_media_guard_test.ts.
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))

Deno.test('ghl-proxy delete_media: imports the shared signature guard', () => {
  assert(/import \{ signatureMediaDeleteRefusal \} from '\.\.\/_shared\/signature_media_guard\.ts'/.test(src))
})

Deno.test('ghl-proxy delete_media: refuses a signed-off signature before storage is touched', () => {
  const start = src.indexOf("action === 'delete_media'")
  assert(start > 0, 'delete_media branch not found')
  const select = src.indexOf("select('id, job_id, storage_url, phase')", start)
  const guard = src.indexOf('signatureMediaDeleteRefusal(sb, records || [])', start)
  const refuse = src.indexOf('signatureRefusal.status)', start)
  const storage = src.indexOf('.storage.from(', start)
  const rowDelete = src.indexOf(".from('job_media').delete()", start)
  assert(select > start, 'media read must select phase')
  assert(guard > select, 'guard must run on the read records')
  assert(refuse > guard, 'a refusal must return its status')
  assert(storage > refuse, 'storage removal must come after the guard')
  assert(rowDelete === -1 || rowDelete > refuse, 'row delete must come after the guard')
  assertEquals(src.split('signatureMediaDeleteRefusal(').length - 1, 1)
})
