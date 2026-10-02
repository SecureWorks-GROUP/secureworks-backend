// Handover from the old monitor-inbox path to the email reader (slice EM2).
//
// Once the email reader runs on its schedule (flag email_reader_schedule_v1,
// read through context_email_reader_flags()), it is the one writer of email
// evidence rows (business_events, keyed email:<internet message id>). The old
// path then stops writing its own evidence row for each email and stops its
// group-post reader, so one email is never two evidence rows. It keeps
// writing inbox_events exactly as before: the reply and forward fences, the
// invoice coverage read and the job read's inbox block still read that table
// until the reader-move slice (EM-R1).
//
// Unreadable flags read as "not handed over": the old path keeps writing. A
// duplicate evidence row is recoverable; a lost email is not.

export interface ReaderFlags {
  reader?: unknown;
  schedule?: unknown;
  program?: unknown;
}

/** True when the old path must leave email evidence rows to the reader. */
export function readerOwnsEvidence(
  flags: ReaderFlags | null | undefined,
): boolean {
  return flags?.reader === true && flags?.schedule === true &&
    flags?.program === true;
}

// deno-lint-ignore no-explicit-any
export async function readReaderFlags(sb: any): Promise<ReaderFlags | null> {
  try {
    const { data, error } = await sb.rpc("context_email_reader_flags");
    if (error || !data || typeof data !== "object") return null;
    return data as ReaderFlags;
  } catch {
    return null;
  }
}
