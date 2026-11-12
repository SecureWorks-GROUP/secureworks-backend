/**
 * Which scope_tool_defaults rows a supplier price may be compared against.
 *
 * Two readers compare recent supplier prices (material_price_ledger) with the
 * scoping tools' defaults and report a price drift: the daily digest's price
 * drift section (daily-digest, which offers "Update Default") and the ops AI's
 * check_supplier_pricing tool (ops-ai). Some rows in that table are not
 * material prices, so neither reader may compare them:
 *  - fencing_surcharge and fencing_panels: surcharges and panel widths;
 *  - staff_only: staff policy settings such as the commission percentage
 *    (20261102130500_scope_tool_defaults_staff_only_rows.sql). Read as a price,
 *    a percentage shows up as a supplier price drift with an offer to change it.
 *
 * Both readers leave these rows out of their query AND skip them when
 * comparing, so a row that reaches the loop some other way is still skipped.
 */

export const NON_SUPPLIER_PRICED_CATEGORIES: readonly string[] = [
  "fencing_surcharge",
  "fencing_panels",
  "staff_only",
];

/** PostgREST value for `.not('category', 'in', ...)`. */
export const NON_SUPPLIER_PRICED_CATEGORY_FILTER = `(${
  NON_SUPPLIER_PRICED_CATEGORIES.map((c) => `"${c}"`).join(",")
})`;

/** True when a scope_tool_defaults row may be compared with a supplier price. */
export function isSupplierPricedDefault(
  row: { category?: string | null } | null | undefined,
): boolean {
  if (!row) return false;
  return !NON_SUPPLIER_PRICED_CATEGORIES.includes(String(row.category ?? ""));
}
