// What never goes on supplier copy (the Dispatch template's exclusions):
// calculated concrete, tek screws, removal, labour, delivery fees. The one
// rule for the Dispatch v2 scope suggestion (dispatch_v2_emails.ts) and for a
// quote option sealed to go to a supplier (send-quote/quote_options.ts, and
// ops-api/dispatch_quote_options.ts): an option line the final fill would
// drop is refused at acceptance and held at the fill, never "on the order"
// while dropped.
const NOT_SUPPLIER_COPY_RE =
  /^concrete (bags|footings)|tek screw|removal|labour|delivery/i;

export function goesOnSupplierCopy(description: unknown): boolean {
  return !NOT_SUPPLIER_COPY_RE.test(String(description ?? "").trim());
}
