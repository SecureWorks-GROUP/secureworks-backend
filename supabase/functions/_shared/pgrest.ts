// ── PostgREST result guards ──────────────────────────────────────────────────
// Schema drift (a renamed or dropped column) makes PostgREST return a 400 with
// `error` set and `data` null. Callers that destructure `{ data }` only will
// silently degrade to zero rows — a $0 pipeline figure reads exactly like a
// quiet week. These helpers make that failure mode loud.

export type PgrestResult<T = any> = { data: T[] | null; error: any };

/** Log any failures across a labelled batch of results (e.g. from Promise.all). */
export function logQueryErrors(
  entries: Array<[string, PgrestResult | null | undefined]>,
): void {
  for (const [context, result] of entries) {
    if (result?.error) {
      console.error(
        `[pgrest] ${context} query failed — returning no rows:`,
        result.error.message || result.error,
      );
    }
  }
}
