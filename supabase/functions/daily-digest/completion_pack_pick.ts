// Which completed jobs get their completion pack now (P0-14.5, 17 Nov 2026).
//
// The same rules as the per-job loop it replaces (daily-digest/index.ts before
// P0-14), read in bulk instead of one or two reads per completed job:
//   - the job is complete and finished 2+ days ago (the caller's jobs read,
//     unchanged);
//   - exactly one PAID invoice with a paid date whose reference matches the
//     old `.ilike('reference', '%<number>%')` (contains the job number,
//     ignoring case; `_` and `%` in the number stay wildcards, as in ILIKE,
//     and PostgREST reads `*` as `%`), plus `.maybeSingle()`, which yields
//     nothing for none or several;
//   - paid at least 2 whole days ago (Math.floor of the day difference);
//   - no `job.completion_pack_sent` event for the job yet.
// The completion-pack function can email the client while its switch is on,
// so these rules must stay exactly the old loop's. Nothing here sends.

export interface PackJob {
  id: string;
  job_number: string | null;
}

export interface PaidInvoice {
  reference: string | null;
  fully_paid_on: string | null;
}

export function pickCompletionPackJobs(
  jobs: PackJob[],
  paidInvoices: PaidInvoice[],
  sentJobIds: Set<string>,
  nowMs: number,
): PackJob[] {
  const paid = paidInvoices
    // A NULL reference never matches ILIKE.
    .filter((inv) => inv.fully_paid_on != null && inv.reference != null)
    .map((inv) => ({
      ref: inv.reference as string,
      paidOn: inv.fully_paid_on as string,
    }));
  const picked: PackJob[] = [];
  for (const job of jobs) {
    // The old filter interpolated the job number as text, `${job.job_number}`.
    const pattern = ilikeContains(`${job.job_number}`);
    const matches = paid.filter((inv) => pattern.test(inv.ref));
    if (matches.length !== 1) continue;
    const daysSincePaid = Math.floor(
      (nowMs - new Date(matches[0].paidOn).getTime()) / 86400000,
    );
    if (daysSincePaid < 2) continue;
    if (sentJobIds.has(job.id)) continue;
    picked.push(job);
  }
  return picked;
}

/** `ILIKE '%<text>%'` as a regular expression: `_` is one character, `%` (and
 * PostgREST's `*`) any run, everything else literal, case ignored. */
export function ilikeContains(text: string): RegExp {
  let body = "";
  for (const ch of text) {
    if (ch === "_") body += "[\\s\\S]";
    else if (ch === "%" || ch === "*") body += "[\\s\\S]*";
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(body, "i");
}
