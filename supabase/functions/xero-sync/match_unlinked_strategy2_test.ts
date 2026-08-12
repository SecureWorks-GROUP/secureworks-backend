// ════════════════════════════════════════════════════════════
// M1 REGRESSION — matchUnlinkedInvoices Strategy 2
//
// The 9.1k/day PostgREST 400 storm: Strategy 2 selected jobs.quoted_value
// (never existed). The caller only destructured `data`, so jobs was null
// every iteration and contact-name auto-link was 100% dead as silence.
//
// Guards:
//   1. select list must not include bare quoted_value
//   2. PostgREST error must not be treated as "no candidate jobs"
//   3. single match still auto-links; multi-match still flags
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-env --allow-read \
//     supabase/functions/xero-sync/match_unlinked_strategy2_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchUnlinkedInvoices, sealedSesXeroLinkRefusal } from "./index.ts";

type Call = {
  table: string;
  select?: string;
  filters: Array<{ op: string; args: unknown[] }>;
  update?: unknown;
  insert?: unknown;
};

function makeClient(opts: {
  unlinked?: any[];
  jobsByContact?: Record<string, { data: any[] | null; error: any | null }>;
}) {
  const calls: Call[] = [];
  const updates: Array<{ table: string; row: any; id?: string }> = [];
  const inserts: Array<{ table: string; row: any }> = [];

  function builder(table: string) {
    const call: Call = { table, filters: [] };
    let mode: "select" | "update" | "insert" = "select";
    let updateRow: any = null;
    let _insertRow: any = null;
    const eqFilters: Record<string, unknown> = {};

    const b: any = {
      select: (s: string) => {
        call.select = s;
        mode = "select";
        return b;
      },
      update: (row: any) => {
        mode = "update";
        updateRow = row;
        call.update = row;
        return b;
      },
      insert: (row: any) => {
        mode = "insert";
        _insertRow = row;
        call.insert = row;
        inserts.push({ table, row });
        return b;
      },
      eq: (k: string, v: unknown) => {
        call.filters.push({ op: "eq", args: [k, v] });
        eqFilters[k] = v;
        return b;
      },
      is: (k: string, v: unknown) => {
        call.filters.push({ op: "is", args: [k, v] });
        return b;
      },
      not: (...args: unknown[]) => {
        call.filters.push({ op: "not", args });
        return b;
      },
      ilike: (k: string, v: unknown) => {
        call.filters.push({ op: "ilike", args: [k, v] });
        eqFilters[k] = v;
        return b;
      },
      order: (...args: unknown[]) => {
        call.filters.push({ op: "order", args });
        return b;
      },
      limit: (...args: unknown[]) => {
        call.filters.push({ op: "limit", args });
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      catch: () => Promise.resolve(null),
      then: (resolve: any, reject?: any) => {
        calls.push(call);
        if (mode === "update") {
          updates.push({
            table,
            row: updateRow,
            id: eqFilters.id as string | undefined,
          });
          return Promise.resolve({ data: null, error: null }).then(
            resolve,
            reject,
          );
        }
        if (mode === "insert") {
          return Promise.resolve({ data: null, error: null }).then(
            resolve,
            reject,
          );
        }
        if (table === "xero_invoices") {
          return Promise.resolve({
            data: opts.unlinked ?? [],
            error: null,
          }).then(resolve, reject);
        }
        if (table === "jobs") {
          // Strategy 1 uses maybeSingle; Strategy 2 uses array thenable.
          // Contact-name path is identified by client_name ilike filter.
          const contact = call.filters.find((f) =>
            f.op === "ilike" && f.args[0] === "client_name"
          );
          if (contact) {
            const key = String(contact.args[1] ?? "").toLowerCase();
            const hit = opts.jobsByContact?.[key] ??
              opts.jobsByContact?.[String(contact.args[1])] ??
              { data: [], error: null };
            return Promise.resolve(hit).then(resolve, reject);
          }
          return Promise.resolve({ data: null, error: null }).then(
            resolve,
            reject,
          );
        }
        if (table === "ai_annotations") {
          return Promise.resolve({ data: [], error: null }).then(
            resolve,
            reject,
          );
        }
        return Promise.resolve({ data: null, error: null }).then(
          resolve,
          reject,
        );
      },
    };
    return b;
  }

  return {
    client: { from: (t: string) => builder(t) },
    calls,
    updates,
    inserts,
  };
}

const UNLINKED = [{
  id: "inv-row-1",
  xero_invoice_id: "xero-1",
  reference: null,
  contact_name: "Jane Client",
  total: 1200,
  invoice_number: "INV-1001",
  invoice_type: "ACCREC",
  status: "AUTHORISED",
}];

Deno.test("Strategy 2: job lookup select must not include bare quoted_value", async () => {
  const { client, calls } = makeClient({
    unlinked: UNLINKED,
    jobsByContact: {
      "Jane Client": {
        data: [{
          id: "job-1",
          job_number: "SWP-25001",
          client_name: "Jane Client",
        }],
        error: null,
      },
    },
  });

  await matchUnlinkedInvoices(client);

  const jobSelects = calls
    .filter((c) => c.table === "jobs" && c.select)
    .map((c) => c.select!);
  assert(jobSelects.length >= 1, "expected at least one jobs select");
  for (const sel of jobSelects) {
    // Bare quoted_value is the 42703 that killed Strategy 2.
    // Aliased form (quoted_value:something) would also be wrong here —
    // Strategy 2 never reads the value; only id/job_number/client_name matter.
    assert(
      !/(^|,\s*)quoted_value(\s*,|$)/.test(sel),
      `Strategy 2 must not select bare quoted_value; got: ${sel}`,
    );
    assert(
      sel.includes("id") && sel.includes("job_number") &&
        sel.includes("client_name"),
      `Strategy 2 must select id, job_number, client_name; got: ${sel}`,
    );
  }
});

Deno.test("Strategy 2: PostgREST error is visible and does not auto-link", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const { client, updates } = makeClient({
      unlinked: UNLINKED,
      jobsByContact: {
        "Jane Client": {
          data: null,
          error: {
            message: "column jobs.quoted_value does not exist",
            code: "42703",
          },
        },
      },
    });

    const result = await matchUnlinkedInvoices(client);

    assertEquals(result.matched, 0);
    assertEquals(
      updates.filter((u) => u.table === "xero_invoices").length,
      0,
      "must not write job_id when the lookup failed",
    );
    assert(
      errors.some((e) => e.includes("Strategy 2") && e.includes("INV-1001")),
      `expected a visible Strategy 2 error log; got: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = orig;
  }
});

Deno.test("Strategy 2: single client_name match auto-links the invoice", async () => {
  const { client, updates } = makeClient({
    unlinked: UNLINKED,
    jobsByContact: {
      "Jane Client": {
        data: [{
          id: "job-1",
          job_number: "SWP-25001",
          client_name: "Jane Client",
        }],
        error: null,
      },
    },
  });

  const result = await matchUnlinkedInvoices(client);
  assertEquals(result.matched, 1);
  const link = updates.find((u) =>
    u.table === "xero_invoices" && u.row?.job_id === "job-1"
  );
  assert(link, "expected xero_invoices update with job_id");
});

Deno.test("Strategy 2: multiple client_name matches flag, do not auto-link", async () => {
  const { client, updates, inserts } = makeClient({
    unlinked: UNLINKED,
    jobsByContact: {
      "Jane Client": {
        data: [
          { id: "job-1", job_number: "SWP-25001", client_name: "Jane Client" },
          { id: "job-2", job_number: "SWP-25002", client_name: "Jane Client" },
        ],
        error: null,
      },
    },
  });

  const result = await matchUnlinkedInvoices(client);
  assertEquals(result.matched, 0);
  assertEquals(result.flagged, 1);
  assertEquals(
    updates.filter((u) => u.table === "xero_invoices").length,
    0,
  );
  assert(
    inserts.some((i) =>
      i.table === "ai_annotations" &&
      i.row?.annotation_type === "unlinked_invoice"
    ),
    "expected unlinked_invoice annotation for multi-match",
  );
});

Deno.test("Strategy 2: genuine empty result is not an error (no false log)", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const { client, updates } = makeClient({
      unlinked: UNLINKED,
      jobsByContact: {
        "Jane Client": { data: [], error: null },
      },
    });

    const result = await matchUnlinkedInvoices(client);
    assertEquals(result.matched, 0);
    assertEquals(result.flagged, 0);
    assertEquals(updates.length, 0);
    assertEquals(
      errors.filter((e) => e.includes("Strategy 2")).length,
      0,
      "genuine miss must not log a Strategy 2 failure",
    );
  } finally {
    console.error = orig;
  }
});

Deno.test("Strategy 2: SWMS ACCREC match auto-links after seal removal", async () => {
  const { client, updates } = makeClient({
    unlinked: UNLINKED,
    jobsByContact: {
      "Jane Client": {
        data: [{
          id: "job-ses-1",
          job_number: "SWMS-261055",
          type: "makesafe",
          client_name: "Jane Client",
        }],
        error: null,
      },
    },
  });

  const result = await matchUnlinkedInvoices(client);
  const refusals = result.refusals ?? [];
  assertEquals(result.matched, 1);
  assertEquals(result.refused, 0);
  assertEquals(refusals, []);
  assertEquals(
    updates.filter((update) => update.table === "xero_invoices").length,
    1,
  );
});

Deno.test("ACCPAY remains outside the sealed SES sales-invoice link fence", async () => {
  const client = {
    from: () => {
      throw new Error("ACCPAY must not perform a sealed SES classification");
    },
  };
  const refusal = await sealedSesXeroLinkRefusal(
    client,
    {
      xero_invoice_id: "bill-1",
      invoice_number: "BILL-1001",
      invoice_type: "ACCPAY",
    },
    { id: "job-ses-1", job_number: "SWMS-261055", type: "makesafe" },
    "test ACCPAY link",
  );
  assertEquals(refusal, null);
});

Deno.test("legacy SWMS target classification is inert for unknown invoice types", async () => {
  const refusal = await sealedSesXeroLinkRefusal(
    {
      from: () => {
        throw new Error("direct SWMS classification must not need a lookup");
      },
    },
    {
      xero_invoice_id: "unknown-type-1",
      invoice_number: "INV-UNKNOWN",
      invoice_type: null,
    },
    { id: "job-ses-1", job_number: "SWMS-261055", type: "makesafe" },
    "test unknown invoice type link",
  );
  assertEquals(refusal, null);
});

Deno.test("explicit SES invoice bindings still refuse auto-linking", async () => {
  const refusal = await sealedSesXeroLinkRefusal(
    {},
    {
      xero_invoice_id: "ses-bound-1",
      invoice_number: "INV-SES",
      invoice_type: "ACCREC",
      invoice_obligation_revision_id:
        "20000000-0000-4000-8000-000000000002",
    },
    { id: "job-ses-1", job_number: "SWMS-261055", type: "makesafe" },
    "test SES-bound invoice link",
  );
  assertEquals(refusal?.code, "sealed_ses_release_required");
});
