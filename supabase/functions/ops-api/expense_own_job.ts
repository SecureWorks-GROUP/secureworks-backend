// A trade files a receipt only against a job they are booked on.
//
// The Trade App's receipt screen already offers a trade only their own jobs:
// office roles (admin, owner, ops_manager) pick any job, everyone else picks a
// job they hold a booking on (their own job_assignments row that is not
// cancelled and is not a watcher row). This is the same rule on the server, so
// submit_expense and update_expense refuse a job the caller is not on, whatever
// the screen sent. It is a correctness check and reads no switch.
//
// A receipt with no job (general business, or a division's stock) is never
// checked here. A failed read refuses; it never counts as booked.
import { ExpenseCaptureError } from "./expense_capture_v2.ts";

// Bounded: a trade holds at most one row per job and date.
const OWN_BOOKING_READ_LIMIT = 100;

export function expenseJobIdOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // No trim: the id checked is exactly the id written.
  const id = String(value);
  return id ? id : null;
}

/**
 * Refuses unless the caller may file a receipt against jobId.
 * `staff` is true for the office (api_key, or a JWT with an office role).
 * Reads job_assignments by (job_id, user_id), the leading columns of
 * job_assignments_job_user_date_key.
 */
export async function assertExpenseJobIsCallers(
  client: any,
  input: { jobId: unknown; userId: string | null | undefined; staff: boolean },
): Promise<void> {
  const jobId = expenseJobIdOf(input.jobId);
  if (!jobId || input.staff) return;
  if (!input.userId) throw notYours();

  let res: { data?: unknown; error?: unknown };
  try {
    res = await client.from("job_assignments")
      .select("id, role, status")
      .eq("job_id", jobId)
      .eq("user_id", input.userId)
      .eq("is_ghost", false)
      .or("status.is.null,status.neq.cancelled")
      .limit(OWN_BOOKING_READ_LIMIT);
  } catch {
    throw unreadable();
  }
  if (res?.error || !Array.isArray(res?.data)) throw unreadable();
  const booked = (res.data as Array<{ role?: unknown; status?: unknown }>).some(
    (a) =>
      String(a?.role ?? "").toLowerCase() !== "observer" &&
      String(a?.status ?? "").toLowerCase() !== "cancelled",
  );
  if (!booked) throw notYours();
}

// The app's general error reader shows userMessage before the code, so the
// refusal carries its words there too (body: error, message, userMessage).
class ExpenseOwnJobError extends ExpenseCaptureError {
  override get body() {
    return { ...super.body, userMessage: this.message };
  }
}

function notYours() {
  return new ExpenseOwnJobError(
    "expense_job_not_yours",
    "You are not booked on that job. Pick one of your jobs, or ask the office.",
    403,
  );
}

function unreadable() {
  return new ExpenseOwnJobError(
    "expense_job_unreadable",
    "Your jobs could not be checked. Try again.",
    503,
  );
}
