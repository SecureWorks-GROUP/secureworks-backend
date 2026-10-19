// A client's signature on a sign-off (job_client_signoffs.signature_media_id)
// is evidence. The sign-off's foreign key refuses the job_media row delete,
// but both delete paths (ops-api deleteMedia, ghl-proxy delete_media) remove
// the storage file first, so they ask this before touching storage. Only
// signature-phase media is checked; an unreadable check refuses.

export type SignatureMediaRefusal = {
  status: 409 | 503
  code: 'signature_signed_off' | 'signoff_check_failed'
  message: string
}

export async function signatureMediaDeleteRefusal(
  client: any,
  media: Array<{ id: unknown; phase?: unknown }>,
): Promise<SignatureMediaRefusal | null> {
  const ids = (media || [])
    .filter((m) => m && m.phase === 'signature' && m.id)
    .map((m) => String(m.id))
  if (ids.length === 0) return null
  try {
    const { data, error } = await client.from('job_client_signoffs')
      .select('id').in('signature_media_id', ids).limit(1)
    if (error) throw error
    if (Array.isArray(data) && data.length > 0) {
      return {
        status: 409,
        code: 'signature_signed_off',
        message: 'This signature is a client sign-off and cannot be deleted',
      }
    }
    return null
  } catch (_e) {
    return {
      status: 503,
      code: 'signoff_check_failed',
      message: 'This signature could not be checked against client sign-offs, so it was not deleted',
    }
  }
}
