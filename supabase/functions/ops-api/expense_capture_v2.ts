type CaptureFields = {
  job_id?: string | null;
  stock_division?: string | null;
  business_category?: string | null;
  capture_version?: number;
  payment_method?: string | null;
};

export class ExpenseCaptureError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
  }
  get body() {
    return { error: this.code, message: this.message };
  }
}

export function expenseCaptureFields(body: CaptureFields): CaptureFields {
  const fields: CaptureFields = {};
  if (body.capture_version !== undefined) {
    if (!Number.isSafeInteger(body.capture_version)) {
      throw new ExpenseCaptureError(
        "invalid_capture_version",
        "Use an integer capture version.",
        400,
      );
    }
    fields.capture_version = body.capture_version;
  }
  if (body.stock_division != null) {
    if (!["patios", "fencing", "insurance"].includes(body.stock_division)) {
      throw new ExpenseCaptureError(
        "invalid_stock_division",
        "Pick a listed stock division.",
        400,
      );
    }
    fields.stock_division = body.stock_division;
    fields.job_id = null;
    fields.business_category = "general_stock";
  } else if (body.stock_division === null || body.job_id) {
    fields.stock_division = null;
  }
  return fields;
}

export function expenseNextStep(row: CaptureFields) {
  switch (row.payment_method) {
    case "personal_card":
      return "reimbursed_on_next_invoice";
    case "supplier_invoice":
      return "evidence_for_supplier_bill";
    case "cash":
      return "draft_bill";
    case "company_card":
      if (row.job_id) return "saved_against_job";
      if (row.stock_division || row.business_category === "general_stock") {
        return "saved_to_stock";
      }
  }
  return null;
}

export function refuseBilledReimbursement(
  xeroBillId: unknown,
  request: { flow?: string; payment_method?: string | null },
) {
  if (
    xeroBillId &&
    (request.flow === "reimbursement" ||
      request.payment_method === "personal_card")
  ) {
    throw new ExpenseCaptureError(
      "expense_already_billed",
      "This receipt already has a bill in Xero.",
    );
  }
}
