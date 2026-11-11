// deno-lint-ignore-file no-explicit-any no-import-prefix
// RQ-19.e: the owner's and the office's override of the deposit gate.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DepositGateOverrideError,
  overrideJobDepositGate,
  readJobDepositGate,
  revokeJobDepositGateOverride,
} from "./job_deposit_gate_override.ts";

const JOB = "11111111-2222-4333-8444-555555555555";
const OFFICE = { session: true, userId: "office-user", role: "ops_manager" };

// A fencing job with the owner paid and the neighbour not, unless told otherwise.
function fakeClient(opts: {
  paid?: boolean;
  type?: string;
  override?: any;
  overrideError?: boolean;
  rpcError?: string;
} = {}) {
  const rpcs: any[] = [];
  const tables: Record<string, any[]> = {
    jobs: [{ id: JOB, type: opts.type ?? "fencing", status: "awaiting_deposit", deposit_invoice_id: null }],
    makesafe_job_details: [],
    job_contacts: [
      { id: "a", contact_label: "A", is_primary: true, share_percentage: 50 },
      { id: "b", contact_label: "B", is_primary: false, share_percentage: 50 },
    ],
    xero_invoices: [
      { id: "a", xero_invoice_id: "a", invoice_type: "ACCREC", reference: "ZZTEST-1-DEP50", job_contact_id: "a", status: "PAID", amount_due: 0 },
      ...(opts.paid
        ? [{ id: "b", xero_invoice_id: "b", invoice_type: "ACCREC", reference: "ZZTEST-1-DEP50", job_contact_id: "b", status: "PAID", amount_due: 0 }]
        : []),
    ],
    job_deposit_gate_overrides: opts.override ? [opts.override] : [],
  };
  const client = {
    rpc(name: string, args: any) {
      rpcs.push({ name, args });
      if (name === "job_not_yet_accepted") return Promise.resolve({ data: false, error: null });
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: opts.rpcError } });
      return Promise.resolve({ data: { id: "override-new", job_id: args.p_job_id, reason: args.p_reason }, error: null });
    },
    from(table: string) {
      let start = 0, end = Infinity;
      const result = (single: boolean) => {
        if (table === "job_deposit_gate_overrides" && opts.overrideError) {
          return { data: null, error: { message: "read failed" } };
        }
        const rows = tables[table] ?? [];
        return { data: single ? rows[0] ?? null : rows.slice(start, end + 1), error: null };
      };
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        range: (a: number, b: number) => {
          start = a;
          end = b;
          return q;
        },
        maybeSingle: () => Promise.resolve(result(true)),
        then: (resolve: any, reject: any) => Promise.resolve(result(false)).then(resolve, reject),
      };
      return q;
    },
  };
  return { client, rpcs };
}

async function refusal(promise: Promise<unknown>) {
  return await assertRejects(() => promise, DepositGateOverrideError);
}

Deno.test("only a signed-in owner, admin or ops manager can override; never the ops key or crew", async () => {
  const f = fakeClient();
  const body = { job_id: JOB, reason: "Neighbour paying on site, owner agreed" };
  for (
    const person of [
      { session: false, userId: null, role: null }, // the ops key, an agent, a routine
      { session: false, userId: "office-user", role: "ops_manager" },
      { session: true, userId: "crew-user", role: "crew" },
      { session: true, userId: "lead-user", role: "lead_installer" },
      { session: true, userId: null, role: "admin" },
    ]
  ) {
    const err = await refusal(overrideJobDepositGate(f.client, body, person));
    assertEquals([err.status, err.code], [403, "deposit_gate_override_needs_person"]);
  }
  for (const person of [OFFICE, { session: true, userId: "boss", role: "admin" }, { session: true, userId: "o", role: "owner" }]) {
    const ok = await overrideJobDepositGate(fakeClient().client, body, person);
    assertEquals(ok.success, true);
  }
  assertEquals(f.rpcs.filter((r) => r.name === "grant_job_deposit_gate_override").length, 0);
});

Deno.test("a reason is required, and a job id must be a job's id", async () => {
  const f = fakeClient();
  let err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: " ok " }, OFFICE));
  assertEquals([err.status, err.code], [400, "deposit_gate_override_reason_required"]);
  err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB }, OFFICE));
  assertEquals(err.code, "deposit_gate_override_reason_required");
  err = await refusal(overrideJobDepositGate(f.client, { job_id: "SWF-1", reason: "Neighbour paying on site" }, OFFICE));
  assertEquals([err.status, err.code], [400, "job_id_required"]);
  assertEquals(f.rpcs.some((r) => r.name === "grant_job_deposit_gate_override"), false);
});

Deno.test("an override records who, why and what was unpaid, through the database writer", async () => {
  const f = fakeClient();
  const out = await overrideJobDepositGate(
    f.client,
    { job_id: JOB, reason: "  Neighbour paying on site, owner agreed  " },
    OFFICE,
  );
  const grant = f.rpcs.find((r) => r.name === "grant_job_deposit_gate_override");
  assertEquals(grant.args.p_job_id, JOB);
  assertEquals(grant.args.p_user_id, "office-user");
  assertEquals(grant.args.p_reason, "Neighbour paying on site, owner agreed");
  assertEquals(grant.args.p_unpaid_reasons[0], "job_deposits_unpaid");
  assertEquals(grant.args.p_unpaid_reasons.length > 1, true);
  assertEquals([out.success, out.override.id], [true, "override-new"]);
});

Deno.test("a job the gate does not hold, or already overridden, takes no override", async () => {
  let f = fakeClient({ paid: true });
  let err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: "Neighbour paying on site" }, OFFICE));
  assertEquals([err.status, err.code], [409, "deposit_gate_not_held"]);
  f = fakeClient({ type: "makesafe" });
  err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: "Neighbour paying on site" }, OFFICE));
  assertEquals(err.code, "deposit_gate_not_held");
  f = fakeClient({ override: { id: "old", job_id: JOB, reason: "Earlier override" } });
  err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: "Neighbour paying on site" }, OFFICE));
  assertEquals([err.status, err.code], [409, "deposit_gate_override_exists"]);
  f = fakeClient({ overrideError: true });
  err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: "Neighbour paying on site" }, OFFICE));
  assertEquals([err.status, err.code], [503, "deposit_gate_override_unreadable"]);
  assertEquals(f.rpcs.some((r) => r.name === "grant_job_deposit_gate_override"), false);
});

Deno.test("the database's own refusals come back as plain answers", async () => {
  const cases: [string, number, string][] = [
    ["DG403 deposit_gate_override_not_allowed", 403, "deposit_gate_override_not_allowed"],
    ["DG409 deposit_gate_override_exists", 409, "deposit_gate_override_exists"],
    ["DG404 deposit_gate_job_not_found", 404, "deposit_gate_job_not_found"],
    ["connection reset", 500, "deposit_gate_override_failed"],
  ];
  for (const [message, status, code] of cases) {
    const f = fakeClient({ rpcError: message });
    const err = await refusal(overrideJobDepositGate(f.client, { job_id: JOB, reason: "Neighbour paying on site" }, OFFICE));
    assertEquals([err.status, err.code], [status, code]);
    assertEquals(err.body.success, false);
  }
});

Deno.test("revoke: a person with a reason, through the database writer", async () => {
  const f = fakeClient({ override: { id: "old", job_id: JOB, reason: "Earlier override" } });
  let err = await refusal(revokeJobDepositGateOverride(f.client, { job_id: JOB, reason: "No longer" }, { session: false, userId: null, role: null }));
  assertEquals(err.status, 403);
  err = await refusal(revokeJobDepositGateOverride(f.client, { job_id: JOB, reason: " " }, OFFICE));
  assertEquals(err.code, "deposit_gate_revoke_reason_required");
  const out = await revokeJobDepositGateOverride(f.client, { job_id: JOB, reason: "Neighbour did not pay" }, OFFICE);
  assertEquals(out.success, true);
  assertEquals(f.rpcs.find((r) => r.name === "revoke_job_deposit_gate_override").args, {
    p_job_id: JOB,
    p_user_id: "office-user",
    p_reason: "Neighbour did not pay",
  });
  const missing = fakeClient({ rpcError: "DG409 deposit_gate_override_not_live" });
  err = await refusal(revokeJobDepositGateOverride(missing.client, { job_id: JOB, reason: "Neighbour did not pay" }, OFFICE));
  assertEquals([err.status, err.code], [409, "deposit_gate_override_not_live"]);
});

Deno.test("the read shows the gate and any override, and writes nothing", async () => {
  const f = fakeClient({ override: { id: "old", job_id: JOB, reason: "Earlier override" } });
  const read = await readJobDepositGate(f.client, new URLSearchParams({ job_id: JOB }));
  assertEquals([read.success, read.gate, read.override?.id], [true, "overridden", "old"]);
  assertEquals(f.rpcs.map((r) => r.name), ["job_not_yet_accepted"]);
  const err = await refusal(readJobDepositGate(f.client, new URLSearchParams()));
  assertEquals(err.code, "job_id_required");
});
