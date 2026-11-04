// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertJobDepositsBeforeWork,
  isInstallationAssignment,
  JobStartDepositError,
} from "./job_start_deposits.ts";
import {
  prepareClockEventAssignment,
  updateAssignment,
  updateJobPhase,
  updateJobStatus,
  updateMyAssignment,
} from "./index.ts";

const owner = {
  id: "owner",
  contact_label: "A",
  is_primary: true,
  share_percentage: 50,
};
const neighbour = {
  id: "neighbour",
  contact_label: "B",
  is_primary: false,
  share_percentage: 50,
};
const deposit = (party: string, extra: any = {}) => ({
  id: party,
  xero_invoice_id: party,
  invoice_type: "ACCREC",
  reference: "SWF-260001-DEP50",
  job_contact_id: party,
  status: "PAID",
  amount_due: 0,
  ...extra,
});

function fixture(extra: any = {}) {
  const tables: any = {
    jobs: [{ id: "job", type: "fencing", deposit_invoice_id: null }],
    job_contacts: [owner, neighbour],
    xero_invoices: [deposit("owner"), deposit("neighbour")],
    job_assignments: [{
      id: "assignment",
      job_id: "job",
      user_id: "crew",
      status: "scheduled",
      assignment_type: "install",
    }],
    ...extra,
  };
  const writes: any[] = [];
  const reads: string[] = [];
  const errors = new Set<string>();
  const client = {
    from(table: string) {
      let id: unknown;
      let start = 0, end = Infinity;
      let write: any;
      const result = (single = false) => {
        reads.push(table);
        const source = tables[table] ?? [];
        const rows = id === undefined
          ? source
          : source.filter((r: any) => r.id === id);
        return {
          data: errors.has(table)
            ? null
            : single
            ? rows[0] ? { ...rows[0], ...write } : null
            : rows.slice(start, end + 1),
          error: errors.has(table) ? { message: "read failed" } : null,
        };
      };
      const q: any = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          if (column === "id") id = value;
          return q;
        },
        order: () => q,
        range: (a: number, b: number) => {
          start = a;
          end = b;
          return q;
        },
        maybeSingle: () => Promise.resolve(result(true)),
        single: () => Promise.resolve(result(true)),
        update: (value: any) => {
          write = value;
          writes.push({ table, value });
          return q;
        },
        insert: (value: any) => {
          writes.push({ table, value });
          return q;
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return q;
    },
  };
  return { client, writes, reads, errors, tables };
}

Deno.test("both paid deposits permit work; one missing party holds it", async () => {
  const f = fixture();
  await assertJobDepositsBeforeWork(f.client, "job");
  f.tables.xero_invoices.pop();
  const err = await assertRejects(
    () => assertJobDepositsBeforeWork(f.client, "job"),
    JobStartDepositError,
  );
  assertEquals(err.code, "job_deposits_unpaid");
  assertEquals(err.reasons, ["party_without_deposit:B"]);
  assertEquals(f.writes, []);
});

for (
  const [name, change] of [
    ["unpaid", { status: "AUTHORISED" }],
    ["draft", { status: "DRAFT" }],
    ["part paid", { amount_due: 1 }],
    ["voided", { status: "VOIDED" }],
    ["unknown amount", { amount_due: null }],
    ["invalid amount", { amount_due: "unknown" }],
  ] as const
) {
  Deno.test(`${name} neighbour deposit cannot permit work`, async () => {
    const f = fixture({
      xero_invoices: [deposit("owner"), deposit("neighbour", change)],
    });
    await assertRejects(
      () => assertJobDepositsBeforeWork(f.client, "job"),
      JobStartDepositError,
    );
    assertEquals(f.writes, []);
  });
}

for (
  const table of [
    "jobs",
    "job_contacts",
    "xero_invoices",
    "makesafe_job_details",
  ]
) {
  Deno.test(`unreadable ${table} fails closed before work`, async () => {
    const f = fixture();
    f.errors.add(table);
    const err = await assertRejects(
      () => assertJobDepositsBeforeWork(f.client, "job"),
      JobStartDepositError,
    );
    assertEquals(err.code, "job_deposits_unreadable");
    assertEquals(f.writes, []);
  });
}

Deno.test("removed and explicitly zero-share neighbours do not hold a paid owner", async () => {
  for (
    const changes of [{ removed_at: "2026-11-01" }, { status: "removed" }, {
      share_percentage: 0,
    }]
  ) {
    const f = fixture({
      job_contacts: [owner, { ...neighbour, ...changes }],
      xero_invoices: [deposit("owner")],
    });
    await assertJobDepositsBeforeWork(f.client, "job");
  }
});

Deno.test("no invoice is not paid; a null neighbour share still requires its deposit", async () => {
  for (
    const extra of [{ xero_invoices: [] }, {
      xero_invoices: [deposit("owner")],
      job_contacts: [owner, { ...neighbour, share_percentage: null }],
    }]
  ) {
    const f = fixture(extra);
    await assertRejects(
      () => assertJobDepositsBeforeWork(f.client, "job"),
      JobStartDepositError,
    );
  }
});

Deno.test("non-deposit job types keep their start path without reading invoices", async () => {
  for (const type of ["makesafe", "insurance", "decking"]) {
    const f = fixture({ jobs: [{ id: "job", type }] });
    await assertJobDepositsBeforeWork(f.client, "job");
    assertEquals(f.reads, ["jobs"]);
  }
});

Deno.test("patio starts require the same paid deposit evidence", async () => {
  const f = fixture({
    jobs: [{ id: "job", type: "patio" }],
    xero_invoices: [],
  });
  await assertRejects(
    () => assertJobDepositsBeforeWork(f.client, "job"),
    JobStartDepositError,
  );
});

Deno.test("legacy patio repairs retain their repair start path", async () => {
  for (
    const extra of [
      {
        jobs: [{
          id: "job",
          type: "patio",
          metadata: { makesafe_job_family: "repair" },
        }],
      },
      {
        jobs: [{ id: "job", type: "patio" }],
        makesafe_job_details: [{ report_type: "repair" }],
      },
    ]
  ) {
    const f = fixture({ ...extra, xero_invoices: [] });
    await assertJobDepositsBeforeWork(f.client, "job");
    assertEquals(f.reads.includes("xero_invoices"), false);
  }
});

Deno.test("an unpaid deposit beyond the first invoice page is still checked", async () => {
  const f = fixture({
    xero_invoices: [
      ...Array.from(
        { length: 500 },
        (_, i) => ({
          ...deposit("owner"),
          id: String(i),
          reference: "SWF-260001-FIN",
        }),
      ),
      deposit("owner"),
      deposit("neighbour", { status: "AUTHORISED" }),
    ],
  });
  await assertRejects(
    () => assertJobDepositsBeforeWork(f.client, "job"),
    JobStartDepositError,
  );
  assertEquals(f.reads.filter((r) => r === "xero_invoices").length, 2);
});

Deno.test("scope visits and ghost watchers are outside installation work", () => {
  assertEquals(isInstallationAssignment({}), true);
  for (
    const row of [
      { assignment_type: "scope" },
      { assignment_type: "meeting" },
      { assignment_type: "delivery" },
      { is_ghost: true },
      { role: "observer" },
    ]
  ) {
    assertEquals(isInstallationAssignment(row), false);
  }
});

const starts: Array<[string, (client: any) => Promise<unknown>]> = [
  [
    "manual or automatic job status",
    (c) => updateJobStatus(c, { job_id: "job", status: "in_progress" }),
  ],
  [
    "office assignment status",
    (c) => updateAssignment(c, { id: "assignment", status: "in_progress" }),
  ],
  [
    "crew assignment status",
    (c) =>
      updateMyAssignment(
        c,
        { id: "assignment", status: "in_progress" },
        "crew",
      ),
  ],
  [
    "crew working phase",
    (c) => updateJobPhase(c, { id: "assignment", phase: "working" }, "crew"),
  ],
  [
    "crew clock on",
    (c) =>
      prepareClockEventAssignment(c, "assignment", "crew", null, "clock_on"),
  ],
  [
    "crew travel",
    (c) =>
      prepareClockEventAssignment(
        c,
        "assignment",
        "crew",
        null,
        "start_travel",
      ),
  ],
  [
    "crew arrived",
    (c) =>
      prepareClockEventAssignment(c, "assignment", "crew", null, "arrived"),
  ],
  [
    "crew resume",
    (c) => prepareClockEventAssignment(c, "assignment", "crew", null, "resume"),
  ],
];
for (const [name, run] of starts) {
  Deno.test(`${name} refuses an unpaid neighbour before any write`, async () => {
    const f = fixture({ xero_invoices: [deposit("owner")] });
    await assertRejects(() => run(f.client), JobStartDepositError);
    assertEquals(f.writes, []);
  });
}

Deno.test("crew can start after both deposits are paid", async () => {
  const f = fixture();
  const result = await updateMyAssignment(f.client, {
    id: "assignment",
    status: "in_progress",
  }, "crew");
  assertEquals(result.assignment.status, "in_progress");
  assertEquals(f.writes[0].table, "job_assignments");
  assertEquals(f.writes[0].value.status, "in_progress");
});

Deno.test("a scope appointment can clock on without install deposits", async () => {
  const f = fixture({
    job_assignments: [{
      id: "assignment",
      job_id: "job",
      user_id: "crew",
      assignment_type: "scope",
    }],
    xero_invoices: [],
  });
  const result = await prepareClockEventAssignment(
    f.client,
    "assignment",
    "crew",
    null,
    "clock_on",
  );
  assertEquals(result.duplicate, false);
  assertEquals(f.reads, ["job_assignments"]);
});
