// Posted-record line coding door: Business Unit tracking and/or a line's
// account code on one AUTHORISED/PAID invoice or credit note, or one
// AUTHORISED spend/receive bank transaction. Amounts, tax, dates, contact,
// payments, allocations and reconciliation must read back unchanged.
// Same limits as the bill tracking door: fresh reads detect, not prevent,
// concurrent edits, and the lock is isolate-local.
import {
  type GetTokenFn,
  SupplierBillError,
  type XeroGetFn,
  type XeroPostFn,
} from "./xero_accpay_books.ts";
import {
  canonical,
  trackingIdentity,
} from "./xero_bill_tracking_corrections.ts";

type Row = Record<string, any>;
export type LineCorrectionDeps = {
  getToken: GetTokenFn;
  xeroGet: XeroGetFn;
  xeroPost: XeroPostFn;
  authorized: boolean;
  nowMs?: () => number;
};
type Kind = {
  path: string;
  collection: string;
  idField: string;
  types: string[];
  statuses: string[];
};
export const LINE_CORRECTION_KINDS: Record<string, Kind> = {
  invoice: {
    path: "/Invoices",
    collection: "Invoices",
    idField: "InvoiceID",
    types: ["ACCPAY", "ACCREC"],
    statuses: ["AUTHORISED", "PAID"],
  },
  credit_note: {
    path: "/CreditNotes",
    collection: "CreditNotes",
    idField: "CreditNoteID",
    types: ["ACCPAYCREDIT", "ACCRECCREDIT"],
    statuses: ["AUTHORISED", "PAID"],
  },
  bank_transaction: {
    path: "/BankTransactions",
    collection: "BankTransactions",
    idField: "BankTransactionID",
    types: ["SPEND", "RECEIVE"],
    statuses: ["AUTHORISED"],
  },
};
export const LINE_CORRECTION_WORK_BUDGET_MS = 80_000;
const runningTenants = new Set<string>(); // Isolate-local only, not a distributed lock.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accountCode = /^[A-Za-z0-9._-]{1,10}$/;
const CHANGE_KEYS = [
  "line_item_id",
  "tracking_category_id",
  "tracking_option_id",
  "account_code",
];
const METADATA = [
  "UpdatedDateUTC",
  "UpdatedDateUTCString",
  "HasErrors",
  "StatusAttributeString",
  "ValidationErrors",
  "Warnings",
];
const LINE_FIELDS = [
  "LineItemID",
  "Description",
  "Quantity",
  "UnitAmount",
  "LineAmount",
  "AccountCode",
  "ItemCode",
  "TaxType",
  "TaxAmount",
  "DiscountRate",
  "DiscountAmount",
  "Tracking",
];
// A 4xx answer from Xero is a finished refusal. Timeouts and 5xx are not.
const DEFINITIVE_REFUSAL = /^Xero validation error:|^Xero API \S+ failed \(4\d\d\)/;

function requireValue(
  ok: unknown,
  message: string,
  code = "LINE_CORRECTION_INVALID",
): asserts ok {
  if (!ok) throw new SupplierBillError(message, 409, code);
}

// Drop response metadata. With omitCoding, also drop what this request may
// change: tracking on every line, and the account on recoded lines.
function snapshot(record: Row, omitCoding = false, recoded = new Set<string>()): Row {
  const copy = structuredClone(record);
  for (const key of METADATA) delete copy[key];
  if (omitCoding) {
    for (const line of copy.LineItems || []) {
      delete line.Tracking;
      if (recoded.has(line.LineItemID)) {
        delete line.AccountCode;
        delete line.AccountID;
      }
    }
  }
  return copy;
}

export async function lineCorrectionHash(
  record: Row,
  tenantId: string,
  kind: string,
  changes: Row[],
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonical({
      tenantId,
      kind,
      record: snapshot(record),
      changes: [...changes].sort((a, b) =>
        canonical(a).localeCompare(canonical(b))
      ),
    }),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function validateRecord(rec: Row, kind: string, id: string) {
  const k = LINE_CORRECTION_KINDS[kind];
  requireValue(
    rec?.[k.idField] === id && k.types.includes(rec.Type),
    `Exact ${k.types.join(" or ")} record required`,
  );
  requireValue(
    k.statuses.includes(rec.Status),
    `Only ${k.statuses.join(" or ")} records are supported`,
  );
  requireValue(
    ["Inclusive", "Exclusive", "NoTax"].includes(rec.LineAmountTypes),
    "Explicit tax basis required",
  );
  requireValue(
    Array.isArray(rec.LineItems) && rec.LineItems.length > 0,
    "Raw Xero lines required",
  );
  // Resending lines recalculates totals and drops invoice address snapshots
  // (INV-1697, 30 Oct 2026). Refuse both rather than lose data.
  requireValue(
    rec.RoundingAmount == null || rec.RoundingAmount === 0,
    "Records with nonzero rounding adjustments require manual review",
    "ROUNDING_UNSUPPORTED",
  );
  requireValue(
    !Array.isArray(rec.InvoiceAddresses) || rec.InvoiceAddresses.length === 0,
    "Records with an invoice-level address block require manual review",
    "INVOICE_ADDRESS_UNSUPPORTED",
  );
  if (kind === "bank_transaction") {
    requireValue(
      typeof rec.BankAccount?.AccountID === "string" &&
        uuid.test(rec.BankAccount.AccountID),
      "Bank account ID required",
    );
    // Readback must be able to prove reconciliation survived.
    requireValue(
      typeof rec.IsReconciled === "boolean",
      "Reconciliation state required",
    );
  }
  const ids = rec.LineItems.map((l: Row) => l.LineItemID);
  requireValue(
    ids.every((v: any) => typeof v === "string" && uuid.test(v)) &&
      new Set(ids).size === ids.length,
    "Every line requires a unique immutable LineItemID",
  );
}

function validateChange(change: Row) {
  requireValue(
    change && typeof change === "object" &&
      Object.keys(change).every((k) => CHANGE_KEYS.includes(k)),
    "Only tracking and account code changes are permitted",
  );
  requireValue(
    typeof change.line_item_id === "string" && uuid.test(change.line_item_id),
    "Line UUID required",
  );
  const tracking = change.tracking_category_id !== undefined ||
    change.tracking_option_id !== undefined;
  if (tracking) {
    requireValue(
      [change.tracking_category_id, change.tracking_option_id].every((v) =>
        typeof v === "string" && uuid.test(v)
      ),
      "Tracking category and option UUIDs are required together",
    );
  }
  if (change.account_code !== undefined) {
    requireValue(
      typeof change.account_code === "string" &&
        accountCode.test(change.account_code),
      "Account code must be 1-10 letters, digits, dots, dashes or underscores",
    );
  }
  requireValue(
    tracking || change.account_code !== undefined,
    "Each change needs a tracking pair or an account code",
  );
}

function planRecord(
  rec: Row,
  changes: Row[],
  categories: Row[],
  accounts: Row[],
): { planned: Row; recoded: Set<string> } {
  const planned = structuredClone(rec);
  const recoded = new Set<string>();
  for (const change of changes) {
    const line = planned.LineItems.find((l: Row) =>
      l.LineItemID === change.line_item_id
    );
    requireValue(line, "LineItemID not on this record");
    if (change.tracking_category_id) {
      const category = categories.find((c) =>
        c.TrackingCategoryID === change.tracking_category_id &&
        c.Status === "ACTIVE" && c.Name === "Business Unit"
      );
      const option = category?.Options?.find((o: Row) =>
        o.TrackingOptionID === change.tracking_option_id &&
        o.Status === "ACTIVE"
      );
      requireValue(
        category && option,
        "Target must be an active Business Unit category and option in this tenant",
      );
      requireValue(
        !line.Tracking || Array.isArray(line.Tracking),
        "Invalid existing tracking",
      );
      const tracking = line.Tracking || [];
      requireValue(
        tracking.every((t: Row) => t.TrackingCategoryID && t.TrackingOptionID),
        "Existing tracking requires immutable IDs",
      );
      const replacement = {
        TrackingCategoryID: category.TrackingCategoryID,
        TrackingOptionID: option.TrackingOptionID,
        Name: category.Name,
        Option: option.Name,
      };
      const index = tracking.findIndex((t: Row) =>
        t.TrackingCategoryID === category.TrackingCategoryID
      );
      if (index < 0) tracking.push(replacement);
      else tracking[index] = replacement;
      requireValue(
        tracking.length <= 2,
        "At most two tracking categories per line",
      );
      line.Tracking = tracking;
    }
    if (change.account_code !== undefined) {
      const current = accounts.find((a) => a.Code === line.AccountCode);
      const target = accounts.find((a) => a.Code === change.account_code);
      requireValue(
        typeof line.AccountCode === "string" && current,
        "Line has no current account in this tenant",
        "ACCOUNT_RECODE_INVALID",
      );
      requireValue(
        target?.Status === "ACTIVE" && !target.SystemAccount &&
          target.Type !== "BANK",
        "Target must be an active, non-system, non-bank account in this tenant",
        "ACCOUNT_RECODE_INVALID",
      );
      // Expense stays expense and revenue stays revenue: a recode never moves
      // money onto the balance sheet or across the profit and loss.
      requireValue(
        ["EXPENSE", "REVENUE"].includes(target.Class) &&
          target.Class === current.Class,
        "A recode may only move a line between profit and loss accounts of the same class",
        "ACCOUNT_RECODE_INVALID",
      );
      if (target.Code !== line.AccountCode) {
        line.AccountCode = target.Code;
        if (Object.hasOwn(line, "AccountID")) line.AccountID = target.AccountID;
        recoded.add(line.LineItemID);
      }
    }
  }
  return { planned, recoded };
}

function writePayload(kind: string, planned: Row): Row {
  const k = LINE_CORRECTION_KINDS[kind];
  const payload: Row = {
    [k.idField]: planned[k.idField],
    Type: planned.Type,
    LineAmountTypes: planned.LineAmountTypes,
    LineItems: planned.LineItems.map((line: Row) =>
      Object.fromEntries(
        LINE_FIELDS.filter((f) => Object.hasOwn(line, f)).map((f) => [
          f,
          line[f],
        ]),
      )
    ),
  };
  if (kind === "bank_transaction") {
    payload.BankAccount = { AccountID: planned.BankAccount.AccountID };
    if (planned.Contact?.ContactID) {
      payload.Contact = { ContactID: planned.Contact.ContactID };
    }
  }
  return payload;
}

function businessUnit(line: Row): string | null {
  return (line?.Tracking || []).find((t: Row) => t.Name === "Business Unit")
    ?.Option ?? null;
}

// One row per requested line, for the approval card and the receipt.
function summarise(before: Row, planned: Row, changes: Row[]): Row[] {
  return changes.map((change) => {
    const from = before.LineItems.find((l: Row) =>
      l.LineItemID === change.line_item_id
    );
    const to = planned.LineItems.find((l: Row) =>
      l.LineItemID === change.line_item_id
    );
    return {
      line_item_id: change.line_item_id,
      description: from?.Description ?? null,
      line_amount: from?.LineAmount ?? null,
      from: {
        account_code: from?.AccountCode ?? null,
        business_unit: businessUnit(from),
      },
      to: {
        account_code: to?.AccountCode ?? null,
        business_unit: businessUnit(to),
      },
    };
  });
}

export async function correctXeroLineCoding(
  client: any,
  body: Row,
  deps: LineCorrectionDeps,
) {
  // The budget starts before token acquisition and limits starting new work,
  // not an in-flight provider call.
  const nowMs = deps.nowMs ?? (() => performance.now());
  const startedAt = nowMs();
  const exhausted = () =>
    nowMs() - startedAt >= LINE_CORRECTION_WORK_BUDGET_MS;
  requireValue(
    deps.authorized === true,
    "Owner/admin or dedicated server authorization required",
    "FORBIDDEN",
  );
  requireValue(
    body?.mode === "preview" || body?.mode === "apply",
    "mode must be preview or apply",
  );
  const apply = body.mode === "apply";
  requireValue(
    Object.keys(body).every((k) =>
      ["action", "mode", "confirm", "tenant_id", "record"].includes(k)
    ),
    "Unsupported correction request field",
  );
  requireValue(
    typeof body.tenant_id === "string" && uuid.test(body.tenant_id),
    "Expected tenant_id required",
  );
  const record = body.record;
  requireValue(
    record && typeof record === "object" && !Array.isArray(record) &&
      Object.keys(record).every((k) =>
        ["kind", "id", "expected_snapshot_hash", "changes"].includes(k)
      ),
    "Exactly one record with kind, id and changes is required",
  );
  requireValue(
    Object.hasOwn(LINE_CORRECTION_KINDS, record.kind),
    "kind must be invoice, credit_note or bank_transaction",
  );
  requireValue(
    typeof record.id === "string" && uuid.test(record.id),
    "Record UUID required",
  );
  requireValue(
    Array.isArray(record.changes) &&
      record.changes.length >= (apply ? 1 : 0) &&
      record.changes.length <= 100,
    "Require 0-100 preview changes or 1-100 apply changes",
  );
  record.changes.forEach(validateChange);
  requireValue(
    new Set(record.changes.map((c: Row) => c.line_item_id)).size ===
      record.changes.length,
    "One change per line: put tracking and account code in the same change",
  );
  if (apply) {
    requireValue(body.confirm === true, "Explicit confirm:true required");
    requireValue(
      /^[a-f0-9]{64}$/.test(record.expected_snapshot_hash || ""),
      "Preview snapshot hash required",
    );
  } else {
    requireValue(
      body.confirm === undefined &&
        record.expected_snapshot_hash === undefined,
      "Preview takes no confirm or snapshot hash",
    );
  }
  const kind = record.kind as string;
  const k = LINE_CORRECTION_KINDS[kind];
  const { accessToken, tenantId } = await deps.getToken(client);
  requireValue(
    tenantId === body.tenant_id,
    "Connected tenant differs from expected tenant",
  );
  requireValue(
    !runningTenants.has(tenantId),
    "Correction already running for tenant",
  );
  runningTenants.add(tenantId);
  const done = (result: Row, stoppedReason?: string) => ({
    ok: [
      "preview",
      "verified",
      "verified_with_provider_warning",
      "unchanged",
    ].includes(result.state),
    mode: body.mode,
    tenant_id: tenantId,
    kind,
    result,
    stopped_reason: stoppedReason,
    work_budget_ms: LINE_CORRECTION_WORK_BUDGET_MS,
    limitation:
      "Fresh checks are not transactional Xero CAS; lock is isolate-local. A timeout can leave this record unknown; read it before another attempt. Readback covers the record's API fields, not bank statement lines or project links.",
  });
  const recordPath = `${k.path}/${encodeURIComponent(record.id)}`;
  const read = async () => {
    const response = await deps.xeroGet(recordPath, accessToken, tenantId, {
      unitdp: "4",
    });
    requireValue(
      response?.[k.collection]?.length === 1,
      "Exact single record response required",
    );
    const rec = response[k.collection][0];
    validateRecord(rec, kind, record.id);
    return rec;
  };
  let submitted = false;
  let operationKey: string | undefined;
  let before: Row | undefined;
  try {
    const original = await read();
    before = original;
    const hash = await lineCorrectionHash(
      original,
      tenantId,
      kind,
      record.changes,
    );
    if (apply) {
      requireValue(
        hash === record.expected_snapshot_hash,
        "Record or requested changes differ from preview",
        "SNAPSHOT_CONFLICT",
      );
    }
    let categories: Row[] = [];
    if (record.changes.some((c: Row) => c.tracking_category_id)) {
      const response = await deps.xeroGet(
        "/TrackingCategories",
        accessToken,
        tenantId,
        { includeArchived: "false" },
      );
      requireValue(
        Array.isArray(response?.TrackingCategories),
        "Tracking categories unavailable",
      );
      categories = response.TrackingCategories;
    }
    let accounts: Row[] = [];
    if (record.changes.some((c: Row) => c.account_code !== undefined)) {
      const response = await deps.xeroGet("/Accounts", accessToken, tenantId);
      requireValue(Array.isArray(response?.Accounts), "Accounts unavailable");
      accounts = response.Accounts;
    }
    const { planned, recoded } = planRecord(
      original,
      record.changes,
      categories,
      accounts,
    );
    const summary = summarise(original, planned, record.changes);
    if (!apply) {
      return done({
        id: record.id,
        state: "preview",
        expected_snapshot_hash: hash,
        summary,
        recoded_line_ids: [...recoded],
        before: original,
        planned,
      });
    }
    // Close the reference-data read gap. This still is not provider-side CAS.
    requireValue(
      await lineCorrectionHash(await read(), tenantId, kind, record.changes) ===
        hash,
      "Record changed during preflight",
      "SNAPSHOT_CONFLICT",
    );
    if (canonical(snapshot(original)) === canonical(snapshot(planned))) {
      return done({
        id: record.id,
        state: "unchanged",
        expected_snapshot_hash: hash,
        summary,
      });
    }
    if (exhausted()) {
      return done({ id: record.id, state: "not_attempted" }, "WORK_BUDGET_EXHAUSTED");
    }
    const key = crypto.randomUUID();
    operationKey = key;
    submitted = true;
    const response = await deps.xeroPost(
      `${k.path}/${encodeURIComponent(record.id)}?summarizeErrors=false&unitdp=4`,
      accessToken,
      tenantId,
      { [k.collection]: [writePayload(kind, planned)] },
      "POST",
      key,
    );
    const returned = response?.[k.collection]?.[0];
    const reasons: string[] = [];
    if (!returned) reasons.push("POST_RECORD_MISSING");
    if (
      !Array.isArray(response?.[k.collection]) ||
      response[k.collection].length !== 1
    ) reasons.push("POST_RECORD_COUNT_INVALID");
    if (returned && returned[k.idField] !== record.id) {
      reasons.push("POST_RECORD_ID_MISMATCH");
    }
    if (returned?.HasErrors === true) reasons.push("POST_HAS_ERRORS");
    if (returned?.StatusAttributeString === "ERROR") {
      reasons.push("POST_ERROR_STATUS");
    }
    if (returned?.ValidationErrors?.length) {
      reasons.push("POST_VALIDATION_ERRORS");
    }
    if (returned?.Warnings?.length) reasons.push("POST_WARNINGS");
    if (returned?.StatusAttributeString === "WARNING") {
      reasons.push("POST_WARNING_STATUS");
    }
    const providerResponse = {
      record_count: Array.isArray(response?.[k.collection])
        ? response[k.collection].length
        : null,
      record_id: returned?.[k.idField] ?? null,
      has_errors: returned?.HasErrors ?? null,
      status_attribute_string: returned?.StatusAttributeString ?? null,
      validation_errors: returned?.ValidationErrors ?? null,
      warnings: returned?.Warnings ?? null,
      verified: reasons.length === 0,
    };
    const after = await read();
    const preserved = canonical(snapshot(original, true, recoded)) ===
      canonical(snapshot(after, true, recoded));
    const codingMatches = planned.LineItems.every((line: Row) => {
      const now = after.LineItems.find((l: Row) =>
        l.LineItemID === line.LineItemID
      );
      return now &&
        trackingIdentity(line.Tracking) === trackingIdentity(now.Tracking) &&
        (line.AccountCode ?? null) === (now.AccountCode ?? null);
    });
    if (!preserved) reasons.push("READBACK_PRESERVATION_MISMATCH");
    if (!codingMatches) reasons.push("READBACK_CODING_MISMATCH");
    const verification = {
      verification_reasons: reasons,
      provider_response: providerResponse,
      readback_verification: {
        source: `fresh_xero_${kind}_get`,
        preserved,
        coding_matches: codingMatches,
        verified: preserved && codingMatches,
        scope:
          "Record API fields only, including IsReconciled on bank transactions; not bank statement lines or project links",
      },
    };
    // Xero's standard warning on records with payments allocated still
    // applies the change; readback, not the warning, decides.
    const onlyStandardWarning = reasons.every((r) =>
      r === "POST_WARNINGS" || r === "POST_WARNING_STATUS"
    );
    return done({
      id: record.id,
      state: reasons.length === 0
        ? "verified"
        : onlyStandardWarning && preserved && codingMatches
        ? "verified_with_provider_warning"
        : "verification_failed",
      ...verification,
      idempotency_key: key,
      summary,
      before: original,
      after,
      expected_snapshot_hash: await lineCorrectionHash(
        after,
        tenantId,
        kind,
        record.changes,
      ),
    });
  } catch (error) {
    const message = String((error as Error).message);
    const code = error instanceof SupplierBillError
      ? error.code
      : "PROVIDER_FAILURE";
    if (!submitted) {
      return done({ id: record.id, state: "rejected", code, error: message });
    }
    // A finished 4xx refusal plus an unchanged readback proves nothing was
    // written. Anything else stays unknown.
    if (before && DEFINITIVE_REFUSAL.test(message)) {
      try {
        const now = await read();
        if (canonical(snapshot(now)) === canonical(snapshot(before))) {
          return done({
            id: record.id,
            state: "refused_unchanged",
            idempotency_key: operationKey,
            code: "PROVIDER_REFUSED",
            provider_error: message,
          });
        }
      } catch {
        // Fall through to unknown.
      }
    }
    return done({
      id: record.id,
      state: "unknown",
      idempotency_key: operationKey,
      code,
      error:
        "Provider write or readback outcome uncertain. Read this record before any further correction; no automatic retry was attempted.",
    });
  } finally {
    runningTenants.delete(tenantId);
  }
}
