// ════════════════════════════════════════════════════════════
// BILLS TO PLACE: the bill's Xero job and who placed it (read only)
//
// Pure-Deno, no network. Drives listReconQueue over the in-memory fake, with a
// stand-in for the database's cfo_recorded_person (20261021173000) so the
// placed_by wiring can be pinned here. The rule itself lives only in SQL; the
// stand-in mirrors its true/false for these seeds and is not a second copy the
// handler uses.
// ════════════════════════════════════════════════════════════

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { listReconQueue } from "./materials_recon.ts";
import { makeFakeClient, ORG } from "./materials_recon_test_support.ts";

const B = "xinv-B";
const J = "5b000000-0000-4000-8000-0000000000a1";
const U = "00000000-0000-4000-8000-000000000001";
const qrow = (over: Record<string, unknown> = {}) => ({
  id: "q-" + (over.xero_invoice_id || B), org_id: ORG, xero_invoice_id: B,
  xero_contact_id: "c-1", contact_name: "SBX Supplier", invoice_number: "B-1",
  sub_total: 100, total: 110, invoice_date: "2026-10-01",
  suggested_job_id: null, suggested_job_number: null,
  suggestion_confidence: "low", suggestion_reason: "no_ref_no_po",
  status: "open", assigned_job_id: null, assigned_by: null, assigned_at: null, ...over,
});

// Test stand-in for the SQL rule: user:<uuid of a users row>, or a users row's
// email (case-insensitive, trimmed). Counts its calls.
function withRecordedPerson(
  client: any,
  users: Array<{ id: string; email: string }>,
  fail = false,
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      from: (t: string) => client.from(t),
      rpc: async (fn: string, args: { p_source: string; p_actor: string }) => {
        calls.push(args.p_actor);
        if (fail) return { data: null, error: { message: "stand-in read error" } };
        if (fn !== "cfo_recorded_person") return { data: null, error: { message: "unknown fn" } };
        const a = (args.p_actor || "").trim();
        const person = ["manual_queue", "manual_split"].includes(args.p_source) &&
          (/^user:[0-9a-f-]{36}$/i.test(a)
            ? users.some((u) => u.id === a.slice(5).toLowerCase())
            : a.indexOf("@") > 0 && users.some((u) => u.email.trim().toLowerCase() === a.toLowerCase()));
        return { data: person, error: null };
      },
    },
  };
}

const USERS = [{ id: U, email: "Staff.One@example.test" }];

Deno.test("queue fields: the bill's Xero job is linked, none or unknown, never guessed", async () => {
  const { client } = makeFakeClient({
    materials_reconciliation_queue: [
      qrow(),
      qrow({ xero_invoice_id: "xinv-N", invoice_number: "N-1" }),
      qrow({ xero_invoice_id: "xinv-M", invoice_number: "M-1" }),
      qrow({ xero_invoice_id: "xinv-O", invoice_number: "O-1" }),
    ],
    xero_invoices: [
      { org_id: ORG, xero_invoice_id: B, job_id: J },
      { org_id: ORG, xero_invoice_id: "xinv-N", job_id: null },
      { org_id: "00000000-0000-0000-0000-0000000000ff", xero_invoice_id: "xinv-O", job_id: J },
    ],
    jobs: [{ id: J, job_number: "SWX-0001" }],
  });
  const res: any = await listReconQueue(client, { orgId: ORG });
  const by = (id: string) => res.rows.find((r: any) => r.xero_invoice_id === id).xero_job;
  assertEquals(res.xero_jobs, "ok");
  assertEquals(by(B), { state: "linked", job_id: J, job_number: "SWX-0001" });
  assertEquals(by("xinv-N"), { state: "none", job_id: null, job_number: null });
  assertEquals(by("xinv-M"), { state: "unknown", job_id: null, job_number: null });
  assertEquals(by("xinv-O"), { state: "unknown", job_id: null, job_number: null });
});

Deno.test("queue fields: a failed Xero link read makes every row unknown and never fails the list", async () => {
  const { client } = makeFakeClient({
    materials_reconciliation_queue: [qrow()],
    xero_invoices: [{ org_id: ORG, xero_invoice_id: B, job_id: J }],
    jobs: [{ id: J, job_number: "SWX-0001" }],
  });
  const failing = {
    from: (t: string) => t === "xero_invoices"
      ? new Proxy(client.from(t), {
        get: (q: any, p) => p === "then"
          ? (res: any) => res({ data: null, error: { message: "boom" } })
          : (typeof q[p] === "function" ? (...a: unknown[]) => { q[p](...a); return failing.from(t); } : q[p]),
      })
      : client.from(t),
  };
  const res: any = await listReconQueue(failing, { orgId: ORG });
  assertEquals(res.ok, true);
  assertEquals(res.xero_jobs, "failed");
  assertEquals(res.rows[0].xero_job, { state: "unknown", job_id: null, job_number: null });
});

Deno.test("queue fields: placed_by is a recorded person on a placed row, otherwise null", async () => {
  const { client } = makeFakeClient({
    materials_reconciliation_queue: [
      qrow({ xero_invoice_id: "p1", status: "assigned", assigned_by: `user:${U}` }),
      qrow({ xero_invoice_id: "p2", status: "assigned", assigned_by: "  staff.one@EXAMPLE.test " }),
      qrow({ xero_invoice_id: "p3", status: "assigned", assigned_by: "ops-routine" }),
      qrow({ xero_invoice_id: "p4", status: "assigned", assigned_by: null }),
      qrow({ xero_invoice_id: "p4b", status: "assigned", assigned_by: "   " }),
      qrow({ xero_invoice_id: "p5", status: "open", assigned_by: `user:${U}` }),
      qrow({ xero_invoice_id: "p6a", status: "not_job_related", assigned_by: `user:${U}` }),
      qrow({ xero_invoice_id: "p6b", status: "split", assigned_by: `user:${U}` }),
      qrow({ xero_invoice_id: "p7a", status: "assigned", assigned_by: "user:00000000-0000-4000-8000-00000000dead" }),
      qrow({ xero_invoice_id: "p7b", status: "assigned", assigned_by: `person:${U}` }),
      qrow({ xero_invoice_id: "p7c", status: "assigned", assigned_by: "nobody@example.test" }),
    ],
  });
  const w = withRecordedPerson(client, USERS);
  const res: any = await listReconQueue(w.client, { orgId: ORG, status: "all" });
  const by = (id: string) => res.rows.find((r: any) => r.xero_invoice_id === id).placed_by;
  assertEquals(res.placed_by_read, "ok");
  assertEquals(by("p1"), `user:${U}`);
  assertEquals(by("p2"), "staff.one@EXAMPLE.test");
  for (const id of ["p3", "p4", "p4b", "p5", "p7a", "p7b", "p7c"]) assertEquals(by(id), null, id);
  assertEquals(by("p6a"), `user:${U}`);
  assertEquals(by("p6b"), `user:${U}`);
  // One call per distinct non-blank actor on placed rows; the open row and
  // the blank actors are never asked about.
  assertEquals(new Set(w.calls).size, w.calls.length);
  assertEquals(w.calls.includes(""), false);
  assertEquals(w.calls.length, 6);
});

Deno.test("queue fields: a failed placed-by read leaves every row null and says so", async () => {
  const { client } = makeFakeClient({
    materials_reconciliation_queue: [qrow({ status: "assigned", assigned_by: `user:${U}` })],
    xero_invoices: [{ org_id: ORG, xero_invoice_id: B, job_id: J }],
    jobs: [{ id: J, job_number: "SWX-0001" }],
  });
  const w = withRecordedPerson(client, USERS, true);
  const res: any = await listReconQueue(w.client, { orgId: ORG, status: "all" });
  assertEquals(res.ok, true);
  assertEquals(res.placed_by_read, "failed");
  assertEquals(res.rows[0].placed_by, null);
  assertEquals(res.rows[0].xero_job.state, "linked");
});

Deno.test("queue fields: a client with no rpc reads as failed, never as 'no person'", async () => {
  const { client } = makeFakeClient({
    materials_reconciliation_queue: [qrow({ status: "assigned", assigned_by: `user:${U}` })],
  });
  const res: any = await listReconQueue(client, { orgId: ORG, status: "all" });
  assertEquals(res.placed_by_read, "failed");
  assertEquals(res.rows[0].placed_by, null);
});
