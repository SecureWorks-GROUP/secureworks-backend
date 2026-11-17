// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadCrewInvoiceJobWorkOrderRefusal } from "./crew_invoice_job_work_order.ts";

Deno.test("line hold replaces the invoice refusal; old-only and all-off keep their result", async () => {
  for (
    const [hold, old, expected] of [
      [true, true, null],
      [false, true, "job_work_order_required"],
      [false, false, null],
    ] as const
  ) {
    const client = {
      from(table: string) {
        let flag = "";
        const q: any = {
          select: () => q,
          eq: (key: string, value: string) => {
            if (key === "flag_name") flag = value;
            return q;
          },
          in: () => q,
          limit: () => q,
          then(resolve: any) {
            const data = table === "feature_flags"
              ? [{ enabled: flag === "trade_line_hold_v1" ? hold : old }]
              : table === "jobs"
              ? [{ id: "ZZTEST-JOB", status: "scheduled" }]
              : [];
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return q;
      },
    };
    const result = await loadCrewInvoiceJobWorkOrderRefusal(client, [{
      job_id: "ZZTEST-JOB",
      line_type: "labour",
    }]);
    assertEquals(result?.code ?? null, expected);
  }
});
