// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Fakes for the post-board "new job" staff text, shared by the tests that
// drive it from the notifier, the approval settlement and the scan. Every
// phone here is invented (+61000000xxx): no test carries a real number.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { HugoNotificationRecipient } from "./makesafe_hugo_notification.ts";

/** The make-safe list as it resolves today: one configured manager. */
export const MAKESAFE_TEXT_RECIPIENT: HugoNotificationRecipient = {
  userId: "33333333-3333-3333-3333-333333333333",
  name: "Configured make-safe manager",
  phone: "+61000000001",
};

/** The user named in `makesafe_notify_settings.repair_new_job_user_ids`. */
export const REPAIR_TEXT_RECIPIENT: HugoNotificationRecipient = {
  userId: "55555555-5555-5555-5555-555555555555",
  name: "Configured repair recipient",
  phone: "+61000000005",
};

/** `makesafe_intake_hugo_notifications`, one row a job, as the unique index keeps it. */
export function auditClient(options: {
  duplicateAfterFirst?: boolean;
  insertError?: any;
  updateError?: any;
} = {}) {
  const inserts: any[] = [];
  const updates: any[] = [];
  let row: any = null;
  return {
    inserts,
    updates,
    client: {
      from(table: string) {
        assertEquals(table, "makesafe_intake_hugo_notifications");
        const selectQuery = () => {
          const filters: Array<[string, unknown]> = [];
          const query: any = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            maybeSingle: () => {
              const matches = row &&
                filters.every(([column, value]) => row[column] === value);
              return Promise.resolve({
                data: matches ? row : null,
                error: null,
              });
            },
          };
          return query;
        };
        return {
          select: selectQuery,
          insert(payload: any) {
            inserts.push(payload);
            return {
              select() {
                return {
                  single: () => {
                    const duplicate = options.duplicateAfterFirst &&
                      inserts.length > 1;
                    const error = duplicate
                      ? { code: "23505", message: "unique violation" }
                      : options.insertError || null;
                    if (!error) {
                      const id = `audit-${inserts.length}`;
                      row = { id, ...inserts[inserts.length - 1] };
                      return Promise.resolve({ data: { id }, error: null });
                    }
                    return Promise.resolve({ data: null, error });
                  },
                };
              },
            };
          },
          update(patch: any) {
            updates.push(patch);
            const filters: Array<[string, unknown]> = [];
            const query: any = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return query;
              },
              select() {
                return query;
              },
              maybeSingle: () => {
                if (options.updateError) {
                  return Promise.resolve({
                    data: null,
                    error: options.updateError,
                  });
                }
                const matches = row &&
                  filters.every(([column, value]) => row[column] === value);
                if (!matches) {
                  return Promise.resolve({ data: null, error: null });
                }
                row = { ...row, ...patch };
                return Promise.resolve({ data: { id: row.id }, error: null });
              },
            };
            return query;
          },
        };
      },
    },
  };
}
