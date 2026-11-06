import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import {
  presentInvoiceJobPickerRow,
  readInvoiceAnyJobPermission,
} from "./trade_invoice_job_picker.ts";

Deno.test("invoice picker permission uses the caller and tenant, and a read fault refuses", async () => {
  const filters: Record<string, unknown> = {};
  const q: any = {
    select() {
      return q;
    },
    eq(k: string, v: unknown) {
      filters[k] = v;
      return q;
    },
    maybeSingle() {
      return { data: { invoice_any_job: true }, error: null };
    },
  };
  equal(
    await readInvoiceAnyJobPermission({ from: () => q }, {
      id: "caller",
      orgId: "tenant",
    }),
    true,
  );
  equal(filters, { id: "caller", org_id: "tenant" });
  q.maybeSingle = () => ({ data: null, error: { message: "unreadable" } });
  await rejects(() =>
    readInvoiceAnyJobPermission({ from: () => q }, {
      id: "caller",
      orgId: "tenant",
    })
  );
});

Deno.test("invoice picker never returns prices, financial history, contact details or future fields", () => {
  equal(
    presentInvoiceJobPickerRow({
      id: "job",
      job_number: "SYN-1",
      type: "patio",
      pricing_json: { total: 1200 },
      metadata: { builder_work_order_value_ex_gst: 900 },
      notes: "$400 allowance",
      client_email: "client@example.test",
      client_phone: "private",
      trade_rates: [{ hourly_rate: 50 }],
      future_money: 999,
    }),
    {
      id: "job",
      job_number: "SYN-1",
      type: "patio",
      client_name: null,
      site_suburb: null,
      status: null,
      external_ref: null,
    },
  );
});
