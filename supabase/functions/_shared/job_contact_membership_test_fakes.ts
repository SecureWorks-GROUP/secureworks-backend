// deno-lint-ignore-file no-explicit-any
/**
 * Test fakes for the contact/job text guards. Only eq() filters are applied; the
 * or()/is() liveness filters are deliberately ignored, so tests prove the guards
 * re-check liveness on the rows themselves.
 */
export interface GuardClientOptions {
  /** The jobs row (null: no row). */
  job?: Record<string, unknown> | null;
  jobError?: string;
  jobThrows?: boolean;
  contacts?: Record<string, unknown>[];
  contactsError?: string;
  contactsThrows?: boolean;
}

export function guardClient(opts: GuardClientOptions = {}) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const eqs: [string, unknown][] = [];
      const result = () => {
        if (table === "jobs") {
          if (opts.jobThrows) throw new Error("jobs read threw");
          const row = opts.job ?? null;
          return {
            data: row && eqs.every(([k, v]) =>
                row[k] === undefined || row[k] === v
              )
              ? row
              : null,
            error: opts.jobError ? { message: opts.jobError } : null,
          };
        }
        if (table === "job_contacts") {
          if (opts.contactsThrows) throw new Error("job_contacts read threw");
          if (opts.contactsError) {
            return { data: null, error: { message: opts.contactsError } };
          }
          const rows = opts.contacts ?? [];
          return {
            data: rows.filter((r) => eqs.every(([k, v]) => r[k] === v)),
            error: null,
          };
        }
        return { data: null, error: null };
      };
      const settle = () => {
        try {
          return Promise.resolve(result());
        } catch (e) {
          return Promise.reject(e);
        }
      };
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          eqs.push([k, v]);
          return builder;
        },
        or: () => builder,
        is: () => builder,
        in: () => builder,
        limit: () => builder,
        maybeSingle: () => settle(),
        single: () => settle(),
        then: (resolve: any, reject: any) => settle().then(resolve, reject),
      };
      return builder;
    },
  };
}
