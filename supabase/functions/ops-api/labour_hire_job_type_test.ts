// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Labour hire is its own job type (owner, 20 Nov 2026): numbered SWL-, booked
// to the Xero Business Unit "SW - LABOUR HIRE", and otherwise treated the way a
// miscellaneous job is treated. These tests pin the ops-api half: the tracking
// option, the invoice preflight's division, the revenue account, the invoice
// wording and the generic paths the type falls through to.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _accountCodeForJob,
  _buildRichDescription,
  _jobVertical,
  _preflightInvoiceCreation,
  _trackingCategoryForJob,
  _XERO_TRACKING_OPTIONS_WE_MAY_ADD,
} from "./index.ts";
import { decideTradeInvoiceMode } from "./trade_invoice_mode.ts";
import {
  getStagesForType,
} from "../_shared/stage-gate/job-state-machine.ts";

const LABOUR_HIRE = "SW - LABOUR HIRE";

Deno.test("labour hire: the job type and an SWL- number both book to SW - LABOUR HIRE", () => {
  // The type decides, whatever the number: the four older labour hire jobs
  // keep their SWM- numbers after they are retyped.
  assertEquals(_trackingCategoryForJob("SWM-261677", "labour_hire"), LABOUR_HIRE);
  assertEquals(_trackingCategoryForJob("SWL-261700", "labour_hire"), LABOUR_HIRE);
  assertEquals(_trackingCategoryForJob("", "labour_hire"), LABOUR_HIRE);
  assertEquals(_trackingCategoryForJob("SWP-261700", " Labour_Hire "), LABOUR_HIRE);
  // The number alone answers too, in any case. This is the form every trade
  // bill, purchase order and expense push uses: they pass no type.
  assertEquals(_trackingCategoryForJob("SWL-261700"), LABOUR_HIRE);
  assertEquals(_trackingCategoryForJob("swl-261700", null), LABOUR_HIRE);
  assertEquals(_trackingCategoryForJob("SWL261700"), LABOUR_HIRE);
  // A type rule still outranks the number, as it does for every other prefix.
  assertEquals(_trackingCategoryForJob("SWL-261700", "repair"), "SW - MAKESAFE");
  assertEquals(_trackingCategoryForJob("SWL-261700", "roofing"), "SW - PRIVATE ROOFING");
  assertEquals(_trackingCategoryForJob("SWL-261700", "granny_flat"), "");

  // CONTROLS: nothing else moves.
  assertEquals(_trackingCategoryForJob("SWM-261677", "miscellaneous"), "");
  assertEquals(_trackingCategoryForJob("SWM-261677"), "");
  assertEquals(_trackingCategoryForJob("SWM-261677", "labour hire"), "");
  assertEquals(_trackingCategoryForJob(" SWL-261700"), "");
  assertEquals(_trackingCategoryForJob("SW-261700"), "");
  assertEquals(_trackingCategoryForJob("SWR-261700"), "");
  assertEquals(_trackingCategoryForJob("SWMS-261700"), "SW - MAKESAFE");
  assertEquals(_trackingCategoryForJob("SWRESTO-261700"), "SW - RESTORATION");
  assertEquals(_trackingCategoryForJob("SWP-26100", "patio"), "SW - PATIOS");
  assertEquals(_trackingCategoryForJob("SWF-26100"), "SW - FENCING");
});

Deno.test("labour hire: the option may be added in Xero, and only the two named options may", () => {
  assertEquals([..._XERO_TRACKING_OPTIONS_WE_MAY_ADD], ["SW - RESTORATION", LABOUR_HIRE]);
});

Deno.test("labour hire: revenue keeps the default sales account, as a miscellaneous job does", () => {
  assertEquals(_accountCodeForJob("labour_hire"), "200");
  assertEquals(_accountCodeForJob("miscellaneous"), "200");
  // The account is read from the job type only, never from the number, so an
  // SWL- number cannot move it.
  assertEquals(_accountCodeForJob("Labour_Hire"), "200");
  // CONTROLS
  assertEquals(_accountCodeForJob("fencing"), "207");
  assertEquals(_accountCodeForJob("repair"), "210");
});

// A PostgREST-shaped fake: every chained filter returns the same builder, and
// the read resolves to the row for its table (null for a table with no row).
function fakeClient(rows: Record<string, any>) {
  return {
    from(table: string) {
      const result = { data: rows[table] ?? null, error: null };
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        single: async () =>
          rows[table] ? result : { data: null, error: { message: "no row" } },
        maybeSingle: async () => result,
      };
      return builder;
    },
  };
}

function job(overrides: Record<string, any>) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    job_number: "SWM-261677",
    type: "miscellaneous",
    status: "invoiced",
    client_name: "ZZTEST Builder Pty Ltd",
    client_email: null,
    client_phone: null,
    site_address: "1 Test St",
    site_suburb: "Testville",
    xero_contact_id: null,
    pricing_json: null,
    payment_terms: null,
    ...overrides,
  };
}

Deno.test("labour hire: the invoice preflight has a division and a tracking option", async () => {
  for (const jobNumber of ["SWM-261677", "SWL-261700"]) {
    const row = job({ type: "labour_hire", job_number: jobNumber });
    const pre = await _preflightInvoiceCreation(fakeClient({ jobs: row }), { job_id: row.id });
    assertEquals(pre.missing_dimensions, [], jobNumber);
    assertEquals(pre.ok, true);
    assertEquals(pre.context?.division, "labour_hire");
    assertEquals(pre.context?.tracking_option, LABOUR_HIRE);
    assertEquals(pre.context?.account_code, "200");
    // No quote and no sealed scope are soft warnings, never blockers.
    assert(pre.warnings.includes("quote_revision_id_missing"));
    assert(pre.warnings.includes("scope_revision_id_missing"));
  }
});

Deno.test("labour hire: a miscellaneous job still fails the preflight exactly as before", async () => {
  // The control that shows what the retype fixes: today's four jobs.
  const row = job({});
  const pre = await _preflightInvoiceCreation(fakeClient({ jobs: row }), { job_id: row.id });
  assertEquals(pre.ok, false);
  assertEquals(pre.missing_dimensions, ["division", "tracking_option_unresolvable"]);
});

Deno.test("labour hire: an invoice line says Labour Hire, never patio installation", () => {
  const text = _buildRichDescription(
    job({ type: "labour_hire", job_number: "SWL-261700" }),
    "Labour hire, week ending 20 Nov",
  );
  assert(text.includes("SWL-261700 | Labour Hire"), text);
  assert(!text.includes("Patio"), text);
  // CONTROL: every type without its own label keeps the old wording.
  assert(
    _buildRichDescription(job({}), "x").includes("SWM-261677 | Insulated Patio Installation"),
  );
});

Deno.test("labour hire: trades bill it by the hour and it takes the generic paths", () => {
  // Its vertical is its own type (not make-safe, not repair), so no division
  // manager inherits it and the trade invoice mode is hourly.
  assertEquals(_jobVertical({ type: "labour_hire", job_number: "SWL-261700" }), "labour_hire");
  assertEquals(_jobVertical({ type: "labour_hire", job_number: "SWM-261677" }), "labour_hire");
  assertEquals(
    decideTradeInvoiceMode({
      hasLiveGroupWorkOrder: false,
      tradeInvoiceType: "hourly",
      jobVertical: "labour_hire",
    }),
    { invoice_mode: "hourly", invoice_mode_reason: "other_job" },
  );
  // The same stage list a miscellaneous job gets (the shared default).
  assertEquals(getStagesForType("labour_hire"), getStagesForType("miscellaneous"));
});
