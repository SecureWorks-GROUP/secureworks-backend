import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canCorrectBillTracking,
  correctSupplierBillTracking,
} from "./xero_bill_tracking_corrections.ts";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function fixture(status = "PAID", type = "ACCPAY") {
  let bill: any = {
    InvoiceID: id(1),
    Type: type,
    Status: status,
    LineAmountTypes: "Inclusive",
    Total: 110,
    SubTotal: 100,
    TotalTax: 10,
    AmountPaid: 110,
    AmountDue: 0,
    Payments: [{ PaymentID: id(9), Amount: 110 }],
    Contact: { ContactID: id(8) },
    LineItems: [{
      LineItemID: id(2),
      Description: "Labour",
      Quantity: 1,
      UnitAmount: 110,
      LineAmount: 110,
      TaxAmount: 10,
      TaxType: "INPUT",
      AccountCode: "306",
      Tracking: [],
    }, {
      LineItemID: id(3),
      Description: "Terms",
      LineAmount: 0,
      Tracking: [],
    }],
  };
  let writes = 0;
  let captured: any;
  let fail = false;
  let corrupt = false;
  let categoryActive = true;
  const deps = {
    authorized: true,
    getToken: async () => ({ accessToken: "test", tenantId: id(10) }),
    xeroGet: async (
      path: string,
      _token?: string,
      _tenant?: string,
      _params?: Record<string, string>,
    ) =>
      path === "/TrackingCategories"
        ? {
          TrackingCategories: [{
            TrackingCategoryID: id(4),
            Name: "Business Unit",
            Status: categoryActive ? "ACTIVE" : "ARCHIVED",
            Options: [{
              TrackingOptionID: id(5),
              Name: "PATIOS",
              Status: "ACTIVE",
            }],
          }],
        }
        : { Invoices: [structuredClone(bill)] },
    xeroPost: async (_p: string, _a: string, _t: string, body: any) => {
      writes++;
      captured = body;
      if (fail) throw Error("timeout");
      bill.LineItems = body.Invoices[0].LineItems;
      if (corrupt) bill.Payments[0].Amount = 1;
      return { Invoices: [structuredClone(bill)] };
    },
  };
  const body: any = {
    mode: "preview",
    tenant_id: id(10),
    bills: [{
      xero_invoice_id: id(1),
      changes: [{
        line_item_id: id(2),
        tracking_category_id: id(4),
        tracking_option_id: id(5),
      }],
    }],
  };
  return {
    deps,
    body,
    get bill() {
      return bill;
    },
    get writes() {
      return writes;
    },
    get captured() {
      return captured;
    },
    timeout: () => fail = true,
    corrupt: () => corrupt = true,
    archive: () => categoryActive = false,
  };
}
async function applyInput(f: ReturnType<typeof fixture>) {
  const preview = await correctSupplierBillTracking(null, f.body, f.deps);
  return {
    ...f.body,
    mode: "apply",
    confirm: true,
    bills: [{
      ...f.body.bills[0],
      expected_snapshot_hash: preview.results[0].expected_snapshot_hash,
    }],
  };
}
Deno.test("preview writes nothing and paid/authorised tracking preserves all lines and money", async () => {
  for (const status of ["PAID", "AUTHORISED"]) {
    const f = fixture(status);
    const body = await applyInput(f);
    assertEquals(f.writes, 0);
    const result = await correctSupplierBillTracking(null, body, f.deps);
    assertEquals(result.ok, true);
    assertEquals(f.writes, 1);
    assertEquals(f.captured.Invoices[0].LineItems.length, 2);
    assertEquals(f.bill.Payments[0].Amount, 110);
    assertEquals(f.bill.LineItems[0].Tracking[0].Option, "PATIOS");
    assertEquals(f.captured.Invoices[0].Status, undefined);
  }
});
Deno.test("stale snapshot prevents write", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.bill.AmountDue = 1;
  const r = await correctSupplierBillTracking(null, body, f.deps);
  assertEquals(r.results[0].code, "SNAPSHOT_CONFLICT");
  assertEquals(f.writes, 0);
});
Deno.test("changed target and missing immutable IDs prevent write", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.archive();
  assertEquals(
    (await correctSupplierBillTracking(null, body, f.deps)).results[0].state,
    "rejected",
  );
  assertEquals(f.writes, 0);
  const g = fixture();
  delete g.bill.LineItems[1].LineItemID;
  assertEquals(
    (await correctSupplierBillTracking(null, g.body, g.deps)).ok,
    false,
  );
});
Deno.test("single-bill timeout has no retry and reports unknown", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.timeout();
  const r = await correctSupplierBillTracking(null, body, f.deps);
  assertEquals(r.results[0].state, "unknown");
  assertEquals(r.not_attempted, []);
  assertEquals(f.writes, 1);
});
Deno.test("readback payment change is failure even when tracking succeeded", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.corrupt();
  const r = await correctSupplierBillTracking(null, body, f.deps);
  assertEquals(r.results[0].state, "verification_failed");
  assertEquals(r.results[0].preserved, false);
});
Deno.test("explicit confirmation, tenant and trusted authorization mandatory", async () => {
  for (const field of ["confirm", "tenant_id", "authorized"]) {
    const f = fixture();
    const body = await applyInput(f);
    if (field === "authorized") f.deps.authorized = false;
    else body[field] = field === "confirm" ? false : id(50);
    await assertRejects(() => correctSupplierBillTracking(null, body, f.deps));
    assertEquals(f.writes, 0);
  }
});
Deno.test("paid customer invoice keeps its type, lines and payments while tracking changes", async () => {
  const f = fixture("PAID", "ACCREC");
  const body = await applyInput(f);
  const result = await correctSupplierBillTracking(null, body, f.deps);
  assertEquals(result.ok, true);
  assertEquals(f.writes, 1);
  assertEquals(f.captured.Invoices[0].Type, "ACCREC");
  assertEquals(f.captured.Invoices[0].LineItems.length, 2);
  assertEquals(f.bill.Payments[0].Amount, 110);
  assertEquals(f.bill.LineItems[0].Tracking[0].Option, "PATIOS");
});
Deno.test("credit notes and other invoice types stay outside the door", async () => {
  for (const type of ["ACCRECCREDIT", "ACCPAYCREDIT", "SPEND"]) {
    const f = fixture("PAID", type);
    const result = await correctSupplierBillTracking(null, f.body, f.deps);
    assertEquals(result.ok, false);
    assertEquals(result.results[0].code, "TRACKING_CORRECTION_INVALID");
    assertEquals(f.writes, 0);
  }
});
Deno.test("draft guard remains outside posted-bill door", async () => {
  const f = fixture("DRAFT");
  assertEquals(
    (await correctSupplierBillTracking(null, f.body, f.deps)).ok,
    false,
  );
  assertEquals(f.writes, 0);
});
Deno.test("account and amount request injection rejected", async () => {
  const f = fixture();
  f.body.bills[0].changes[0].AccountCode = "999";
  assertEquals(
    (await correctSupplierBillTracking(null, f.body, f.deps)).ok,
    false,
  );
  assertEquals(f.writes, 0);
});
Deno.test("owner/server gate rejects public, routine, trades, managers and cross-org users", () => {
  assertEquals(canCorrectBillTracking("api_key", null, true, id(1)), true);
  assertEquals(
    canCorrectBillTracking(
      "jwt",
      { role: "owner", orgId: id(1) },
      false,
      id(1),
    ),
    true,
  );
  for (const mode of ["none", "routine", "agent_read"]) {
    assertEquals(
      canCorrectBillTracking(
        mode,
        { role: "owner", orgId: id(1) },
        true,
        id(1),
      ),
      false,
    );
  }
  for (const role of ["trade", "ops_manager"]) {
    assertEquals(
      canCorrectBillTracking("jwt", { role, orgId: id(1) }, false, id(1)),
      false,
    );
  }
  assertEquals(
    canCorrectBillTracking(
      "jwt",
      { role: "admin", orgId: id(2) },
      false,
      id(1),
    ),
    false,
  );
  assertEquals(canCorrectBillTracking("api_key", null, false, id(1)), false);
});

Deno.test("empty preview discovers immutable IDs without any write", async () => {
  const f = fixture();
  f.body.bills[0].changes = [];
  const result = await correctSupplierBillTracking(null, f.body, f.deps);
  assertEquals(result.ok, true);
  assertEquals(result.results[0].before.LineItems[0].LineItemID, id(2));
  assertEquals(result.results[0].expected_snapshot_hash.length, 64);
  assertEquals(f.writes, 0);
});
Deno.test("second tracking category is preserved", async () => {
  const f = fixture();
  const existing = {
    TrackingCategoryID: id(60),
    TrackingOptionID: id(61),
    Name: "Region",
    Option: "Perth",
  };
  f.bill.LineItems[0].Tracking = [existing];
  const body = await applyInput(f);
  assertEquals(
    (await correctSupplierBillTracking(null, body, f.deps)).ok,
    true,
  );
  assertEquals(f.bill.LineItems[0].Tracking[0], existing);
});
Deno.test("provider validation failure is not success despite HTTP-success-shaped response", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.deps.xeroPost = async () => ({
    Invoices: [{
      ...structuredClone(f.bill),
      HasErrors: true,
      StatusAttributeString: "ERROR",
      ValidationErrors: [{ Message: "Locked period" }],
    }],
  });
  const result = await correctSupplierBillTracking(null, body, f.deps);
  assertEquals(result.ok, false);
  assertEquals(result.results[0].state, "verification_failed");
  assertEquals(result.not_attempted, []);
});

Deno.test("four-decimal unit prices survive all reads and POST with precision opt-in", async () => {
  const f = fixture();
  f.bill.LineItems[0].UnitAmount = 1.2345;
  const get = f.deps.xeroGet;
  const post = f.deps.xeroPost;
  let exactReads = 0;
  f.deps.xeroGet = async (path, token, tenant, params) => {
    if (path.startsWith("/Invoices/")) {
      assertEquals(params?.unitdp, "4");
      exactReads++;
    }
    return await get(path, token, tenant, params);
  };
  f.deps.xeroPost = async (path, token, tenant, body) => {
    assertEquals(
      new URL("https://test.invalid" + path).searchParams.get("unitdp"),
      "4",
    );
    assertEquals(body.Invoices[0].LineItems[0].UnitAmount, 1.2345);
    return await post(path, token, tenant, body);
  };
  const body = await applyInput(f);
  assertEquals(
    (await correctSupplierBillTracking(null, body, f.deps)).ok,
    true,
  );
  assertEquals(exactReads, 4);
  assertEquals(f.bill.LineItems[0].UnitAmount, 1.2345);
});
Deno.test("rounding adjustments reject before any provider write", async () => {
  for (const amount of [0.01, -0.01, "0.01"]) {
    const f = fixture();
    const body = await applyInput(f);
    f.bill.RoundingAmount = amount;
    const result = await correctSupplierBillTracking(null, body, f.deps);
    assertEquals(result.results[0].code, "ROUNDING_UNSUPPORTED");
    assertEquals(f.writes, 0);
  }
  const f = fixture();
  f.bill.RoundingAmount = 0;
  assertEquals(
    (await correctSupplierBillTracking(null, await applyInput(f), f.deps)).ok,
    true,
  );
});
Deno.test("invoice-level address block rejects before any provider write", async () => {
  const f = fixture("AUTHORISED", "ACCREC");
  f.bill.InvoiceAddresses = [{
    InvoiceAddressType: "TO",
    AddressLine1: "39 Resource Way",
    City: "Malaga",
  }];
  const result = await correctSupplierBillTracking(null, f.body, f.deps);
  assertEquals(result.results[0].code, "INVOICE_ADDRESS_UNSUPPORTED");
  assertEquals(f.writes, 0);
  const clean = fixture("AUTHORISED", "ACCREC");
  clean.bill.InvoiceAddresses = [];
  assertEquals(
    (await correctSupplierBillTracking(null, await applyInput(clean), clean.deps))
      .ok,
    true,
  );
});
Deno.test("provider update timestamps may change while financial readback remains strict", async () => {
  const f = fixture();
  f.bill.UpdatedDateUTC = "/Date(1000)/";
  f.bill.UpdatedDateUTCString = "2026-10-27T00:00:00Z";
  const body = await applyInput(f);
  const post = f.deps.xeroPost;
  f.deps.xeroPost = async (path, token, tenant, payload) => {
    const response = await post(path, token, tenant, payload);
    f.bill.UpdatedDateUTC = "/Date(2000)/";
    f.bill.UpdatedDateUTCString = "2026-10-28T00:00:00Z";
    return response;
  };
  assertEquals(
    (await correctSupplierBillTracking(null, body, f.deps)).ok,
    true,
  );
});

Deno.test("elapsed budget before first bill prevents reads and writes", async () => {
  const f = fixture();
  let clock = 0;
  let reads = 0;
  const deps = {
    ...f.deps,
    nowMs: () => clock,
    getToken: async () => {
      clock = 80_000;
      return await f.deps.getToken();
    },
    xeroGet: async (...args: Parameters<typeof f.deps.xeroGet>) => {
      reads++;
      return await f.deps.xeroGet(...args);
    },
  };
  const result = await correctSupplierBillTracking(null, f.body, deps);
  assertEquals(result.stopped_reason, "WORK_BUDGET_EXHAUSTED");
  assertEquals(result.not_attempted, [id(1)]);
  assertEquals(reads, 0);
  assertEquals(f.writes, 0);
  assertEquals(result.ok, false);
});
Deno.test("preflight consuming budget cannot start a provider write", async () => {
  const f = fixture();
  const body = await applyInput(f);
  let clock = 0;
  let reads = 0;
  const deps = {
    ...f.deps,
    nowMs: () => clock,
    xeroGet: async (...args: Parameters<typeof f.deps.xeroGet>) => {
      const response = await f.deps.xeroGet(...args);
      if (args[0].startsWith("/Invoices/") && ++reads === 2) clock = 80_000;
      return response;
    },
  };
  const result = await correctSupplierBillTracking(null, body, deps);
  assertEquals(result.stopped_reason, "WORK_BUDGET_EXHAUSTED");
  assertEquals(result.not_attempted, [id(1)]);
  assertEquals(result.results, []);
  assertEquals(f.writes, 0);
});
Deno.test("in-flight single-bill write reaching budget completes verification", async () => {
  const f = fixture();
  const body = await applyInput(f);
  let clock = 0;
  const deps = {
    ...f.deps,
    nowMs: () => clock,
    xeroPost: async (...args: Parameters<typeof f.deps.xeroPost>) => {
      const response = await f.deps.xeroPost(...args);
      clock = 80_000;
      return response;
    },
  };
  const result = await correctSupplierBillTracking(null, body, deps);
  assertEquals(result.results[0].state, "verified");
  assertEquals(result.stopped_reason, undefined);
  assertEquals(result.not_attempted, []);
  assertEquals(f.writes, 1);
  assertEquals(result.ok, true);
});

Deno.test("preview binds exact changes, including empty discovery, before any write", async () => {
  for (const discovery of [false, true]) {
    const f = fixture();
    const original = structuredClone(f.body.bills[0].changes);
    if (discovery) f.body.bills[0].changes = [];
    const body = await applyInput(f);
    body.bills[0].changes = discovery
      ? original
      : [{ ...original[0], line_item_id: id(3) }];
    const result = await correctSupplierBillTracking(null, body, f.deps);
    assertEquals(result.results[0].code, "SNAPSHOT_CONFLICT");
    assertEquals(f.writes, 0);
  }
});
Deno.test("equivalent change ordering retains the reviewed authorization", async () => {
  const f = fixture();
  f.body.bills[0].changes.push({
    ...f.body.bills[0].changes[0],
    line_item_id: id(3),
  });
  const body = await applyInput(f);
  body.bills[0].changes.reverse();
  assertEquals(
    (await correctSupplierBillTracking(null, body, f.deps)).ok,
    true,
  );
});
Deno.test("multiple bills refuse before token acquisition or any provider activity", async () => {
  const f = fixture();
  f.body.bills.push({ ...f.body.bills[0], xero_invoice_id: id(20) });
  let tokenCalls = 0;
  await assertRejects(() =>
    correctSupplierBillTracking(null, f.body, {
      ...f.deps,
      getToken: async () => {
        tokenCalls++;
        return await f.deps.getToken();
      },
    })
  );
  assertEquals(tokenCalls, 0);
  assertEquals(f.writes, 0);
});
Deno.test("other tracking categories cannot be changed", async () => {
  const f = fixture();
  const get = f.deps.xeroGet;
  f.deps.xeroGet = async (...args) => {
    const result = await get(...args);
    if (args[0] === "/TrackingCategories") {
      result.TrackingCategories![0].Name = "Region";
    }
    return result;
  };
  assertEquals(
    (await correctSupplierBillTracking(null, f.body, f.deps)).ok,
    false,
  );
  assertEquals(f.writes, 0);
});

for (
  const example of [
    {
      name: "missing invoice",
      response: (_bill: any): any => ({}),
      reasons: ["POST_INVOICE_MISSING", "POST_INVOICE_COUNT_INVALID"],
      count: null,
      invoiceId: null,
    },
    {
      name: "wrong invoice",
      response: (bill: any) => ({ Invoices: [{ ...bill, InvoiceID: id(99) }] }),
      reasons: ["POST_INVOICE_ID_MISMATCH"],
      count: 1,
      invoiceId: id(99),
    },
    {
      name: "extra invoice",
      response: (bill: any) => ({ Invoices: [bill, bill] }),
      reasons: ["POST_INVOICE_COUNT_INVALID"],
      count: 2,
      invoiceId: id(1),
    },
    {
      name: "warning",
      response: (bill: any) => ({
        Invoices: [{
          ...bill,
          StatusAttributeString: "WARNING",
          Warnings: [{ Message: "Provider warning" }],
        }],
      }),
      reasons: ["POST_WARNINGS", "POST_WARNING_STATUS"],
      count: 1,
      invoiceId: id(1),
    },
    {
      name: "error",
      response: (bill: any) => ({
        Invoices: [{
          ...bill,
          HasErrors: true,
          StatusAttributeString: "ERROR",
          ValidationErrors: [{ Message: "Provider error" }],
        }],
      }),
      reasons: [
        "POST_HAS_ERRORS",
        "POST_ERROR_STATUS",
        "POST_VALIDATION_ERRORS",
      ],
      count: 1,
      invoiceId: id(1),
    },
  ]
) {
  Deno.test(`matching readback does not hide POST ${example.name} or retry`, async () => {
    const f = fixture();
    const body = await applyInput(f);
    const post = f.deps.xeroPost;
    f.deps.xeroPost = async (...args: Parameters<typeof post>) => {
      const response = await post(...args);
      return example.response(response.Invoices[0]);
    };
    const result = await correctSupplierBillTracking(null, body, f.deps);
    const receipt = result.results[0];
    assertEquals(result.ok, false);
    assertEquals(receipt.state, "verification_failed");
    assertEquals(receipt.verification_reasons, example.reasons);
    assertEquals(receipt.provider_response.invoice_count, example.count);
    assertEquals(receipt.provider_response.invoice_id, example.invoiceId);
    assertEquals(receipt.provider_response.verified, false);
    const returned = example.response(f.bill).Invoices?.[0];
    assertEquals(
      receipt.provider_response.has_errors,
      returned?.HasErrors ?? null,
    );
    assertEquals(
      receipt.provider_response.status_attribute_string,
      returned?.StatusAttributeString ?? null,
    );
    assertEquals(
      receipt.provider_response.validation_errors,
      returned?.ValidationErrors ?? null,
    );
    assertEquals(
      receipt.provider_response.warnings,
      returned?.Warnings ?? null,
    );
    assertEquals(receipt.readback_verification.verified, true);
    assertEquals(
      receipt.readback_verification.source,
      "fresh_xero_invoice_get",
    );
    assertEquals(receipt.preserved, true);
    assertEquals(receipt.tracking_matches, true);
    assertEquals(f.writes, 1);
  });
}

Deno.test("clean POST and matching readback report both evidence checks passed", async () => {
  const f = fixture();
  const result = await correctSupplierBillTracking(
    null,
    await applyInput(f),
    f.deps,
  );
  assertEquals(result.ok, true);
  assertEquals(result.results[0].state, "verified");
  assertEquals(result.results[0].verification_reasons, []);
  assertEquals(result.results[0].provider_response.verified, true);
  assertEquals(result.results[0].readback_verification.verified, true);
  assertEquals(f.writes, 1);
});
