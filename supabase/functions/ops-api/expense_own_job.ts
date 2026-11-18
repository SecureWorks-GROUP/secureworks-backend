// A receipt saved on a job its submitter is not booked on is marked for the
// office (director 18 Nov 2026: flag, not refuse; a manager or runner buying
// for another crew must not be pushed onto the wrong job).
//
// The booking rule is the Trade App receipt screen's: office roles (admin,
// owner, ops_manager) and the server key may use any job and are never marked;
// any other signed-in caller is booked when they hold their own job_assignments
// row on that job that is not cancelled and is not a ghost or watcher row.
//
// The mark is expense_receipts.unbooked_job_id: the job the receipt was saved
// on without a confirmed booking. A failed booking read never counts as
// booked, so it marks too. The receipt always saves. Approving a marked
// receipt needs a deliberate confirm (approveExpense). Reads no switch.
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
 * The mark to store for a receipt saved on jobId: jobId when the caller is not
 * confirmed booked there, null when booked, office, or no job. Never throws.
 * Reads job_assignments by (job_id, user_id), the leading columns of
 * job_assignments_job_user_date_key.
 */
export async function expenseUnbookedJobMark(
  client: any,
  input: { jobId: unknown; userId: string | null | undefined; staff: boolean },
): Promise<string | null> {
  const jobId = expenseJobIdOf(input.jobId);
  if (!jobId || input.staff) return null;
  if (!input.userId) return jobId;
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
    console.warn("[ops-api] expense_booking_read_failed", { job_id: jobId });
    return jobId;
  }
  if (res?.error || !Array.isArray(res?.data)) {
    console.warn("[ops-api] expense_booking_read_failed", { job_id: jobId });
    return jobId;
  }
  const booked = (res.data as Array<{ role?: unknown; status?: unknown }>).some(
    (a) =>
      String(a?.role ?? "").toLowerCase() !== "observer" &&
      String(a?.status ?? "").toLowerCase() !== "cancelled",
  );
  return booked ? null : jobId;
}

/**
 * Approving a marked receipt needs body.confirm_unbooked === true, from any
 * caller (server key included). Query and reject never need it.
 */
export function assertUnbookedApprovalConfirmed(
  status: string,
  unbookedJobId: unknown,
  confirm: unknown,
): void {
  if (status !== "approved" || !expenseJobIdOf(unbookedJobId)) return;
  if (confirm === true) return;
  throw new ExpenseOwnJobError(
    "expense_unbooked_confirm_needed",
    "The person who sent this receipt is not booked on its job. Check the job, then confirm to approve.",
    409,
  );
}

/**
 * An approved receipt moved onto a job its submitter is not booked on would
 * carry the mark without the office ever confirming it. That one move is left
 * to the office (409); every other move, and every move by the office, saves.
 */
export function assertUnbookedMoveAllowed(status: string, mark: string | null): void {
  if (status !== "approved" || !mark) return;
  throw new ExpenseOwnJobError(
    "expense_approved_move_needs_office",
    "This receipt is already approved. Ask the office to move it to that job.",
    409,
  );
}

// The app's general error reader shows userMessage before the code, so the
// refusal carries its words there too (body: error, message, userMessage).
class ExpenseOwnJobError extends ExpenseCaptureError {
  override get body() {
    return { ...super.body, userMessage: this.message };
  }
}
