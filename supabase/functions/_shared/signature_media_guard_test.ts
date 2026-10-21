import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { signatureMediaDeleteRefusal } from './signature_media_guard.ts'

function fakeClient(result: { data?: unknown; error?: unknown; throws?: boolean }) {
  const reads: Array<{ table: string; ids: string[] }> = []
  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: string[]) {
              reads.push({ table, ids })
              return {
                limit(_n: number) {
                  if (result.throws) return Promise.reject(new Error('network'))
                  return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
                },
              }
            },
          }
        },
      }
    },
  }
  return { client, reads }
}

Deno.test('signature guard: a signature on a sign-off is refused 409', async () => {
  const { client, reads } = fakeClient({ data: [{ id: 's1' }] })
  const refusal = await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'signature' }])
  assertEquals(refusal?.status, 409)
  assertEquals(refusal?.code, 'signature_signed_off')
  assertEquals(reads, [{ table: 'job_client_signoffs', ids: ['m1'] }])
})

Deno.test('signature guard: a signature on no sign-off may be deleted', async () => {
  const { client } = fakeClient({ data: [] })
  assertEquals(await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'signature' }]), null)
})

Deno.test('signature guard: photos are not checked', async () => {
  const { client, reads } = fakeClient({ data: [{ id: 's1' }] })
  assertEquals(await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'after' }, { id: 'm2' }]), null)
  assertEquals(reads.length, 0)
})

Deno.test('signature guard: only signature ids are read', async () => {
  const { client, reads } = fakeClient({ data: [] })
  await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'after' }, { id: 'm2', phase: 'signature' }])
  assertEquals(reads[0].ids, ['m2'])
})

Deno.test('signature guard: a read error refuses 503', async () => {
  const { client } = fakeClient({ error: { message: 'boom' } })
  const refusal = await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'signature' }])
  assertEquals(refusal?.status, 503)
  assertEquals(refusal?.code, 'signoff_check_failed')
})

Deno.test('signature guard: a thrown read refuses 503', async () => {
  const { client } = fakeClient({ throws: true })
  const refusal = await signatureMediaDeleteRefusal(client, [{ id: 'm1', phase: 'signature' }])
  assertEquals(refusal?.status, 503)
})
