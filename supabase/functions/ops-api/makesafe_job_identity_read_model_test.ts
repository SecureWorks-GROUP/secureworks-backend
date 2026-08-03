// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  projectMakesafeJobIdentity,
} from "./makesafe_job_identity_read_model.ts";

Deno.test("typed identity exposes one WO group with distinct PO job grains", () => {
  const rows = ["PO-40001", "PO-40002", "PO-40003"].map((po) =>
    projectMakesafeJobIdentity({
      builder_claim_ref: "MLB-10001",
      builder_work_order_number: `MLB-10001${po}`,
      builder_po_number: po,
      requesting_company_slug: "mlb",
      family: "general_makesafe",
      authority: "typed_job_metadata",
    })
  );
  assertEquals(rows.map((row) => row.work_order_number), [
    "MLB-10001",
    "MLB-10001",
    "MLB-10001",
  ]);
  assertEquals(rows.map((row) => row.job_grain_key), [
    "MLB:PO-40001",
    "MLB:PO-40002",
    "MLB:PO-40003",
  ]);
  assertEquals(rows.every((row) => row.complete), true);
});

Deno.test("read model never parses a PO out of the legacy composite field", () => {
  const identity = projectMakesafeJobIdentity({
    builder_work_order_number: "MLB-10001PO-40001",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    authority: "typed_job_metadata",
  });
  assertEquals(identity.work_order_number, "MLB-10001PO-40001");
  assertEquals(identity.purchase_order_number, null);
  assertEquals(identity.job_grain_key, null);
  assertEquals(identity.complete, false);
});
