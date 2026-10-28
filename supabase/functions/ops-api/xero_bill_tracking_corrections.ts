// Narrow posted-bill correction door. No approval, payment, tax or account edits.
// Xero has no transactional compare-and-swap: fresh reads detect, not prevent,
// external concurrent changes. Keep this separate from the draft-only writer.
import {
  type GetTokenFn,
  SupplierBillError,
  type XeroGetFn,
  type XeroPostFn,
} from "./xero_accpay_books.ts";

type Row = Record<string, any>;
export type TrackingCorrectionDeps = {
  getToken: GetTokenFn;
  xeroGet: XeroGetFn;
  xeroPost: XeroPostFn;
  authorized: boolean;
  nowMs?: () => number;
};
export const BILL_TRACKING_WORK_BUDGET_MS = 80_000;
const runningTenants = new Set<string>(); // Isolate-local only, not a distributed lock.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireValue(
  ok: unknown,
  message: string,
  code = "TRACKING_CORRECTION_INVALID",
): asserts ok {
  if (!ok) throw new SupplierBillError(message, 409, code);
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) =>
      JSON.stringify(k) + ":" + canonical(value[k])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
// Ignore response metadata only. All invoice data, including payment allocations,
// remains in the verification snapshot. Unexpected provider shape changes stop us.
function snapshot(invoice: Row, omitTracking = false): Row {
  const copy = structuredClone(invoice);
  for (
    const key of [
      "UpdatedDateUTC",
      "UpdatedDateUTCString",
      "HasErrors",
      "StatusAttributeString",
      "ValidationErrors",
      "Warnings",
    ]
  ) delete copy[key];
  if (omitTracking) {
    for (const line of copy.LineItems || []) delete line.Tracking;
  }
  return copy;
}
export async function billTrackingSnapshotHash(
  invoice: Row,
  tenantId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonical({ tenantId, invoice: snapshot(invoice) }),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function validateInvoice(inv: Row, id: string) {
  requireValue(
    inv?.InvoiceID === id && inv.Type === "ACCPAY",
    "Exact ACCPAY invoice required",
  );
  requireValue(
    ["AUTHORISED", "PAID"].includes(inv.Status),
    "Only AUTHORISED or PAID bills are supported",
  );
  requireValue(
    ["Inclusive", "Exclusive", "NoTax"].includes(inv.LineAmountTypes),
    "Explicit tax basis required",
  );
  requireValue(
    Array.isArray(inv.LineItems) && inv.LineItems.length > 0,
    "Raw Xero lines required",
  );
  // Resending LineItems recalculates totals. Do not discard a persisted
  // rounding adjustment; supporting it requires a separately verified payload.
  requireValue(
    inv.RoundingAmount == null || inv.RoundingAmount === 0,
    "Bills with nonzero or unsupported rounding adjustments require manual review",
    "ROUNDING_UNSUPPORTED",
  );
  const ids = inv.LineItems.map((l: Row) => l.LineItemID);
  requireValue(
    ids.every((id: any) => typeof id === "string" && uuid.test(id)) &&
      new Set(ids).size === ids.length,
    "Every line requires a unique immutable LineItemID",
  );
}
function trackingIdentity(items: any): string {
  return canonical(
    (items || []).map((t: Row) => ({
      category: t.TrackingCategoryID,
      option: t.TrackingOptionID,
      name: t.Name,
      value: t.Option,
    })).sort((a: Row, b: Row) =>
      String(a.category).localeCompare(String(b.category))
    ),
  );
}
function planInvoice(inv: Row, changes: Row[], categories: Row[]): Row {
  const planned = structuredClone(inv);
  const used = new Set<string>();
  for (const change of changes) {
    requireValue(
      Object.keys(change).every((k) =>
        ["line_item_id", "tracking_category_id", "tracking_option_id"].includes(
          k,
        )
      ),
      "Only tracking ID changes are permitted",
    );
    requireValue(
      [
        change.line_item_id,
        change.tracking_category_id,
        change.tracking_option_id,
      ].every((v) => typeof v === "string" && uuid.test(v)),
      "Tracking and line UUIDs required",
    );
    const pair = change.line_item_id + ":" + change.tracking_category_id;
    requireValue(!used.has(pair), "Duplicate line/category change");
    used.add(pair);
    const category = categories.find((c) =>
      c.TrackingCategoryID === change.tracking_category_id &&
      c.Status === "ACTIVE"
    );
    const option = category?.Options?.find((o: Row) =>
      o.TrackingOptionID === change.tracking_option_id && o.Status === "ACTIVE"
    );
    requireValue(
      category && option,
      "Target category and option must be active in this tenant",
    );
    const line = planned.LineItems.find((l: Row) =>
      l.LineItemID === change.line_item_id
    );
    requireValue(line, "LineItemID not on this invoice");
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
  return planned;
}
function writePayload(planned: Row): Row {
  const fields = [
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
  return {
    InvoiceID: planned.InvoiceID,
    Type: "ACCPAY",
    LineAmountTypes: planned.LineAmountTypes,
    LineItems: planned.LineItems.map((line: Row) =>
      Object.fromEntries(
        fields.filter((k) => Object.hasOwn(line, k)).map((k) => [k, line[k]]),
      )
    ),
  };
}
export async function correctSupplierBillTracking(
  client: any,
  body: Row,
  deps: TrackingCorrectionDeps,
) {
  // Start before token acquisition: authentication/provider-read latency counts.
  // This limits starting NEW work, not the duration of an in-flight provider call.
  const nowMs = deps.nowMs ?? (() => performance.now());
  const startedAt = nowMs();
  const exhausted = () => nowMs() - startedAt >= BILL_TRACKING_WORK_BUDGET_MS;
  let stoppedReason: string | undefined;
  requireValue(
    deps.authorized === true,
    "Owner/admin or dedicated server authorization required",
    "FORBIDDEN",
  );
  requireValue(
    body?.mode === "preview" || body?.mode === "apply",
    "mode must be preview or apply",
  );
  requireValue(
    Object.keys(body).every((k) =>
      ["action", "mode", "confirm", "tenant_id", "bills"].includes(k)
    ),
    "Unsupported correction request field",
  );
  requireValue(
    typeof body.tenant_id === "string" && uuid.test(body.tenant_id),
    "Expected tenant_id required",
  );
  requireValue(
    Array.isArray(body.bills) && body.bills.length > 0 &&
      body.bills.length <= 10,
    "Batch requires 1–10 bills",
  );
  requireValue(
    new Set(body.bills.map((b: Row) => b.xero_invoice_id)).size ===
      body.bills.length,
    "Duplicate invoice in batch",
  );
  for (const bill of body.bills) {
    requireValue(
      Object.keys(bill).every((k) =>
        ["xero_invoice_id", "expected_snapshot_hash", "changes"].includes(k)
      ),
      "Unsupported bill request field",
    );
    requireValue(
      typeof bill.xero_invoice_id === "string" &&
        uuid.test(bill.xero_invoice_id),
      "Invoice UUID required",
    );
    requireValue(
      Array.isArray(bill.changes) &&
        bill.changes.length >= (body.mode === "preview" ? 0 : 1) &&
        bill.changes.length <= 100,
      "Require 0–100 preview changes or 1–100 apply changes per bill",
    );
    if (body.mode === "apply") {
      requireValue(
        /^[a-f0-9]{64}$/.test(bill.expected_snapshot_hash || ""),
        "Preview snapshot hash required",
      );
    }
  }
  if (body.mode === "apply") {
    requireValue(body.confirm === true, "Explicit confirm:true required");
  }
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
  const results: Row[] = [];
  try {
    const read = async (id: string) => {
      const response = await deps.xeroGet(
        `/Invoices/${encodeURIComponent(id)}`,
        accessToken,
        tenantId,
        { unitdp: "4" },
      );
      requireValue(
        response?.Invoices?.length === 1,
        "Exact single invoice response required",
      );
      const inv = response.Invoices[0];
      validateInvoice(inv, id);
      return inv;
    };
    for (const bill of body.bills) {
      if (exhausted()) {
        stoppedReason = "WORK_BUDGET_EXHAUSTED";
        break;
      }
      let submitted = false;
      let operationKey: string | undefined;
      try {
        const before = await read(bill.xero_invoice_id);
        const hash = await billTrackingSnapshotHash(before, tenantId);
        if (body.mode === "apply") {
          requireValue(
            hash === bill.expected_snapshot_hash,
            "Invoice changed since preview",
            "SNAPSHOT_CONFLICT",
          );
        }
        const categoryResponse = await deps.xeroGet(
          "/TrackingCategories",
          accessToken,
          tenantId,
          { includeArchived: "false" },
        );
        requireValue(
          Array.isArray(categoryResponse?.TrackingCategories),
          "Tracking categories unavailable",
        );
        const planned = planInvoice(
          before,
          bill.changes,
          categoryResponse.TrackingCategories,
        );
        if (body.mode === "preview") {
          results.push({
            xero_invoice_id: bill.xero_invoice_id,
            state: "preview",
            expected_snapshot_hash: hash,
            before,
            planned,
          });
          continue;
        }
        // Close the category-read gap. This still is not provider-side CAS.
        requireValue(
          await billTrackingSnapshotHash(
            await read(bill.xero_invoice_id),
            tenantId,
          ) === hash,
          "Invoice changed during preflight",
          "SNAPSHOT_CONFLICT",
        );
        if (canonical(snapshot(before)) === canonical(snapshot(planned))) {
          results.push({
            xero_invoice_id: bill.xero_invoice_id,
            state: "unchanged",
            expected_snapshot_hash: hash,
          });
          continue;
        }
        // Recheck after all asynchronous preflight work, immediately before
        // submission. Finish readback for a submitted bill even if time expires.
        if (exhausted()) {
          stoppedReason = "WORK_BUDGET_EXHAUSTED";
          break;
        }
        const key = crypto.randomUUID();
        operationKey = key;
        submitted = true;
        const response = await deps.xeroPost(
          `/Invoices/${
            encodeURIComponent(bill.xero_invoice_id)
          }?summarizeErrors=false&unitdp=4`,
          accessToken,
          tenantId,
          { Invoices: [writePayload(planned)] },
          "POST",
          key,
        );
        const returned = response?.Invoices?.[0];
        const errors = !returned || response.Invoices.length !== 1 ||
          returned.InvoiceID !== bill.xero_invoice_id ||
          returned.HasErrors === true ||
          returned.StatusAttributeString === "ERROR" ||
          returned.ValidationErrors?.length || returned.Warnings?.length ||
          returned.StatusAttributeString === "WARNING";
        const after = await read(bill.xero_invoice_id);
        const preserved = canonical(snapshot(before, true)) ===
          canonical(snapshot(after, true));
        const trackingMatches = planned.LineItems.every((
          line: Row,
          i: number,
        ) =>
          trackingIdentity(line.Tracking) ===
            trackingIdentity(after.LineItems[i]?.Tracking)
        );
        if (errors || !preserved || !trackingMatches) {
          results.push({
            xero_invoice_id: bill.xero_invoice_id,
            state: "verification_failed",
            idempotency_key: key,
            before,
            after,
            provider_errors: returned?.ValidationErrors || [],
            preserved,
            tracking_matches: trackingMatches,
          });
          break;
        }
        results.push({
          xero_invoice_id: bill.xero_invoice_id,
          state: "verified",
          idempotency_key: key,
          before,
          after,
          expected_snapshot_hash: await billTrackingSnapshotHash(
            after,
            tenantId,
          ),
        });
      } catch (error) {
        results.push({
          xero_invoice_id: bill.xero_invoice_id,
          state: submitted ? "unknown" : "rejected",
          idempotency_key: operationKey,
          code: error instanceof SupplierBillError
            ? error.code
            : "PROVIDER_FAILURE",
          error: submitted
            ? "Provider write or readback outcome uncertain. Read this invoice before any further correction; no automatic retry was attempted."
            : String((error as Error).message),
        });
        break;
      }
    }
    return {
      ok: results.length === body.bills.length &&
        results.every((r) =>
          ["preview", "verified", "unchanged"].includes(r.state)
        ),
      mode: body.mode,
      tenant_id: tenantId,
      results,
      stopped_reason: stoppedReason,
      work_budget_ms: BILL_TRACKING_WORK_BUDGET_MS,
      not_attempted: body.bills.slice(results.length).map((b: Row) =>
        b.xero_invoice_id
      ),
      limitation:
        "Fresh checks are not transactional Xero CAS; lock is isolate-local. No bank reconciliation or financial recoding performed.",
    };
  } finally {
    runningTenants.delete(tenantId);
  }
}

export function canCorrectBillTracking(
  mode: string,
  user: { role?: string; orgId?: string } | null,
  serverSecret: boolean,
  orgId: string,
): boolean {
  return (mode === "api_key" && serverSecret === true) ||
    (mode === "jwt" && !!user && ["owner", "admin"].includes(user.role || "") &&
      user.orgId === orgId);
}
