// W2-C (M-E1) — item-14 guard + honest-fallback recheck-queue integration tests.
//
// Exercises the live handlers (loader, substatus-advance guard, draft-invoice
// guard, recheck queue read, recheck enqueue cron) against a data-driven Supabase
// mock. The pure decision logic is covered separately in makesafe_portal_guard_test.ts.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertMakesafePortalVerifiedForAdvance,
  _assertMakesafePortalVerifiedForDraftInvoice,
  _createMakesafeDraftInvoiceForTest,
  _makesafePortalRecheckEnqueue,
  _makesafePortalRecheckQueue,
} from "./index.ts";

// ── Data-driven Supabase mock (supports eq / in / not-is-null / range / update /
//    insert / maybeSingle / thenable) — enough for the loader + scan + stamp paths.
type Tables = {
  makesafe_job_details?: any[];
  jobs?: any[];
  job_events?: any[];
};
function makeClient(tables: Tables) {
  const inserts: Array<{ table: string; row: any }> = [];
  const updates: Array<{ table: string; row: any; eqs: Record<string, any> }> =
    [];
  tables.makesafe_job_details = tables.makesafe_job_details || [];
  tables.jobs = tables.jobs || [];
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    const nots: Array<{ k: string; op: string; val: any }> = [];
    let rangeSlice: [number, number] | null = null;
    let op: "select" | "insert" | "update" = "select";
    let updateRow: any = null;
    let insertRow: any = null;
    const matchRows = () => {
      let rows = (tables[table as keyof Tables] || []).slice();
      for (const [k, v] of Object.entries(eqs)) {
        rows = rows.filter((r) => r[k] === v);
      }
      for (const [k, arr] of Object.entries(ins)) {
        rows = rows.filter((r) => arr.includes(r[k]));
      }
      for (const n of nots) {
        if (n.op === "is" && n.val === null) {
          rows = rows.filter((r) => r[n.k] != null);
        }
      }
      if (rangeSlice) rows = rows.slice(rangeSlice[0], rangeSlice[1] + 1);
      return rows;
    };
    const applyUpdate = () => {
      const rows = (tables[table as keyof Tables] || []).filter((r) =>
        Object.entries(eqs).every(([k, v]) => r[k] === v)
      );
      for (const r of rows) Object.assign(r, updateRow);
      updates.push({ table, row: updateRow, eqs: { ...eqs } });
      return { data: updateRow, error: null };
    };
    const resolve = () => {
      if (op === "insert") {
        inserts.push({ table, row: insertRow });
        return { data: insertRow, error: null };
      }
      if (op === "update") return applyUpdate();
      return { data: matchRows(), error: null };
    };
    const resolveSingle = () => {
      if (op === "update") return applyUpdate();
      const rows = matchRows();
      return { data: rows[0] ?? null, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: any) => {
        eqs[k] = v;
        return b;
      },
      in: (k: string, arr: any[]) => {
        ins[k] = arr;
        return b;
      },
      not: (k: string, o: string, val: any) => {
        nots.push({ k, op: o, val });
        return b;
      },
      range: (a: number, c: number) => {
        rangeSlice = [a, c];
        return b;
      },
      order: () => b,
      limit: () => b,
      ilike: () => b,
      update: (row: any) => {
        op = "update";
        updateRow = row;
        return b;
      },
      insert: (row: any) => {
        op = "insert";
        insertRow = row;
        return b;
      },
      maybeSingle: () => Promise.resolve(resolveSingle()),
      single: () => Promise.resolve(resolveSingle()),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
      catch: () => Promise.resolve(resolve()),
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    __inserts: inserts,
    __updates: updates,
  };
}

const PORTAL_LINK = {
  label: "Roof report link",
  url: "https://primeeco.tech/share/942b7548-3065-4ad5-9528-8cb04d655b1e",
  kind: "roof_report",
};

// ════════════════════ substatus-advance guard ════════════════════
Deno.test("advance guard: report card, unverified -> ready_to_invoice throws 409", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 1,
      portal_verified_at: null,
      portal_verified_cycle: null,
    }],
  });
  const err: any = await assertRejects(
    () =>
      _assertMakesafePortalVerifiedForAdvance(client, "j1", "ready_to_invoice"),
    Error,
    "portal-truth guard (item 14)",
  );
  assertEquals(err.status, 409);
});

Deno.test("advance guard: report card verified THIS cycle -> no throw", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 2,
      portal_verified_at: "2026-07-07T00:00:00Z",
      portal_verified_cycle: 2,
    }],
  });
  await _assertMakesafePortalVerifiedForAdvance(
    client,
    "j1",
    "ready_to_invoice",
  ); // resolves
});

Deno.test("advance guard: report card verified in a PRIOR cycle -> throws (re-attend invalidated it)", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 2,
      portal_verified_at: "2026-07-07T00:00:00Z",
      portal_verified_cycle: 1,
    }],
  });
  await assertRejects(
    () =>
      _assertMakesafePortalVerifiedForAdvance(
        client,
        "j1",
        "admin_to_send_report",
      ),
    Error,
    "item 14",
  );
});

Deno.test("advance guard: unguarded pre-report substatus on a report card -> no throw", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 1,
      portal_verified_at: null,
      portal_verified_cycle: null,
    }],
  });
  await _assertMakesafePortalVerifiedForAdvance(
    client,
    "j1",
    "waiting_on_trade_report",
  ); // resolves
});

Deno.test("advance guard: NON-report card -> ready_to_invoice never gated", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: null,
      cycle_number: 1,
    }],
    jobs: [{ id: "j1", metadata: { makesafe_job_family: "general_makesafe" } }],
  });
  await _assertMakesafePortalVerifiedForAdvance(
    client,
    "j1",
    "ready_to_invoice",
  ); // resolves
});

Deno.test("advance guard: family-detected report card (report_type null) unverified -> throws", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: null,
      cycle_number: 1,
      portal_verified_at: null,
      portal_verified_cycle: null,
    }],
    jobs: [{ id: "j1", metadata: { makesafe_job_family: "roof_report" } }],
  });
  await assertRejects(
    () =>
      _assertMakesafePortalVerifiedForAdvance(client, "j1", "ready_to_invoice"),
    Error,
    "item 14",
  );
});

// ════════════════════ draft-invoice guard ════════════════════
Deno.test("draft-invoice guard: report card unverified -> throws 409 BEFORE any Xero read", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 1,
      portal_verified_at: null,
      portal_verified_cycle: null,
    }],
  });
  let xeroReached = false;
  const err: any = await assertRejects(
    () =>
      _createMakesafeDraftInvoiceForTest(client, {
        job_id: "j1",
        reference: "MLB-26122",
        contact_name: "MLB",
        line_items: [{
          description: "Roof report",
          quantity: 1,
          unit_price: 250,
        }],
      }, {
        fetchAllAccrecInvoices: () => {
          xeroReached = true;
          return Promise.resolve([]);
        },
      }),
    Error,
    "refusing to draft an invoice",
  );
  assertEquals(err.status, 409);
  assertEquals(
    xeroReached,
    false,
    "guard must short-circuit before touching Xero",
  );
});

Deno.test("draft-invoice guard: report card VERIFIED -> guard passes, proceeds to create", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: "roof_report",
      cycle_number: 1,
      portal_verified_at: "2026-07-07T00:00:00Z",
      portal_verified_cycle: 1,
    }],
  });
  let created = false;
  const res: any = await _createMakesafeDraftInvoiceForTest(client, {
    job_id: "j1",
    reference: "MLB-26122",
    contact_name: "MLB",
    line_items: [{ description: "Roof report", quantity: 1, unit_price: 250 }],
  }, {
    fetchAllAccrecInvoices: () => Promise.resolve([]),
    createInvoiceFn: () => {
      created = true;
      return Promise.resolve({
        xero_invoice_id: "x1",
        invoice_number: "INV-1",
        total: 250,
      });
    },
  });
  assert(created, "verified report card reaches invoice creation");
  assertEquals(res.success, true);
});

Deno.test("draft-invoice guard: NON-report make-safe -> not gated, proceeds normally", async () => {
  const client = makeClient({
    makesafe_job_details: [{
      job_id: "j1",
      report_type: null,
      cycle_number: 1,
    }],
    jobs: [{ id: "j1", metadata: {} }],
  });
  let created = false;
  await _createMakesafeDraftInvoiceForTest(client, {
    job_id: "j1",
    reference: "MLB-25999",
    contact_name: "MLB",
    line_items: [{ description: "Temp fence", quantity: 1, unit_price: 300 }],
  }, {
    fetchAllAccrecInvoices: () => Promise.resolve([]),
    createInvoiceFn: () => {
      created = true;
      return Promise.resolve({
        xero_invoice_id: "x2",
        invoice_number: "INV-2",
        total: 300,
      });
    },
  });
  assert(created, "non-report make-safe invoicing is unaffected by the guard");
});

Deno.test("draft-invoice guard: no job_id -> not gated (job-less draft)", async () => {
  const client = makeClient({});
  await _assertMakesafePortalVerifiedForDraftInvoice(client, null); // resolves
});

// ════════════════════ recheck queue (read) ════════════════════
Deno.test("recheck queue: returns unverified report cards with portal links, shaped for capture", async () => {
  const client = makeClient({
    makesafe_job_details: [
      // eligible: report card, portal link, unverified
      {
        job_id: "j1",
        report_type: "roof_report",
        external_ref: "MLB-25911",
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
        external_links: [PORTAL_LINK],
        portal_verified_at: null,
        portal_verified_cycle: null,
        portal_recheck_requested_at: null,
        portal_recheck_count: 0,
      },
      // NOT eligible: verified this cycle
      {
        job_id: "j2",
        report_type: "assessment_report",
        external_ref: "MLB-25912",
        substatus: "admin_to_send_report",
        cycle_number: 1,
        external_links: [PORTAL_LINK],
        portal_verified_at: "2026-07-07T00:00:00Z",
        portal_verified_cycle: 1,
      },
      // NOT eligible: no portal link
      {
        job_id: "j3",
        report_type: "roof_report",
        external_ref: "MLB-25913",
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
        external_links: [],
        portal_verified_at: null,
        portal_verified_cycle: null,
      },
    ],
    jobs: [
      {
        id: "j1",
        job_number: "SWMS-1",
        status: "accepted",
        site_address: "1 St",
      },
      { id: "j2", job_number: "SWMS-2", status: "accepted" },
      { id: "j3", job_number: "SWMS-3", status: "accepted" },
    ],
  });
  const res: any = await _makesafePortalRecheckQueue(
    client,
    new URLSearchParams(),
  );
  assertEquals(res.count, 1);
  assertEquals(res.queue.length, 1);
  assertEquals(res.queue[0].job_id, "j1");
  assertEquals(res.queue[0].capture_links[0].ref, "MLB-25911");
  assertEquals(res.queue[0].capture_links[0].url, PORTAL_LINK.url);
  assertEquals(res.queue[0].capture_links[0].role, "roof_report");
});

Deno.test("recheck queue: a graf card at ready_to_invoice but unverified is surfaced", async () => {
  const client = makeClient({
    makesafe_job_details: [
      {
        job_id: "jg",
        report_type: "roof_report",
        external_ref: "MLB-26122",
        substatus: "ready_to_invoice",
        cycle_number: 1,
        external_links: [PORTAL_LINK],
        portal_verified_at: null,
        portal_verified_cycle: null,
      },
    ],
    jobs: [{ id: "jg", job_number: "SWMS-G", status: "accepted" }],
  });
  const res: any = await _makesafePortalRecheckQueue(
    client,
    new URLSearchParams(),
  );
  assertEquals(res.count, 1);
  assertEquals(res.queue[0].substatus, "ready_to_invoice");
});

// ════════════════════ recheck enqueue (cron marker) ════════════════════
Deno.test("recheck enqueue: stamps eligible cards; marker-only; idempotent within cadence window", async () => {
  const tables: Tables = {
    makesafe_job_details: [
      {
        job_id: "j1",
        report_type: "roof_report",
        external_ref: "MLB-25911",
        cycle_number: 1,
        external_links: [PORTAL_LINK],
        portal_verified_at: null,
        portal_verified_cycle: null,
        portal_recheck_requested_at: null,
        portal_recheck_count: 0,
      },
    ],
    jobs: [{ id: "j1", job_number: "SWMS-1", status: "accepted" }],
  };
  const client = makeClient(tables);

  const first: any = await _makesafePortalRecheckEnqueue(client, {
    min_interval_hours: 6,
  });
  assertEquals(first.enqueued, 1);
  assertEquals(first.skipped_recent, 0);
  // Marker written on the detail row; no substatus / invoice / send writes.
  const row = tables.makesafe_job_details![0];
  assert(typeof row.portal_recheck_requested_at === "string");
  assertEquals(row.portal_recheck_count, 1);
  assertEquals(row.substatus, undefined, "enqueue never touches substatus");
  assertEquals(
    client.__updates.every((u) => u.table === "makesafe_job_details"),
    true,
  );

  // Immediate re-run: still within the 6h window -> skipped, no double-stamp.
  const second: any = await _makesafePortalRecheckEnqueue(client, {
    min_interval_hours: 6,
  });
  assertEquals(second.enqueued, 0);
  assertEquals(second.skipped_recent, 1);
  assertEquals(
    tables.makesafe_job_details![0].portal_recheck_count,
    1,
    "no double increment within window",
  );
});

Deno.test("recheck enqueue: verified card is never enqueued", async () => {
  const tables: Tables = {
    makesafe_job_details: [
      {
        job_id: "j1",
        report_type: "roof_report",
        cycle_number: 1,
        external_links: [PORTAL_LINK],
        portal_verified_at: "2026-07-07T00:00:00Z",
        portal_verified_cycle: 1,
        portal_recheck_requested_at: null,
        portal_recheck_count: 0,
      },
    ],
    jobs: [{ id: "j1", status: "accepted" }],
  };
  const client = makeClient(tables);
  const res: any = await _makesafePortalRecheckEnqueue(client, {});
  assertEquals(res.enqueued, 0);
  assertEquals(res.eligible, 0);
});
