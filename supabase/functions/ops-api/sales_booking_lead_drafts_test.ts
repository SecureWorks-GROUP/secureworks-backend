// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BOOKING_LEAD_DRAFT_FLAG,
  type BookingLeadDraftDeps,
  createBookingLeadDraftDeps,
  ensureBookingLeadDrafts,
} from "./sales_booking_lead_drafts.ts";

type Job = {
  id: string;
  status: string;
  ghl_contact_id: string | null;
  ghl_opportunity_id: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * A fake of the database the production wiring talks to: feature_flags,
 * jobs, and an ensure_booking_draft_job that keeps the RPC's contract
 * (one open job per contact returns existing; otherwise inserts a draft).
 */
function fakeDb(
  opts: { flag?: boolean | null; jobs?: Job[]; failJobsRead?: boolean },
) {
  const jobs: Job[] = [...(opts.jobs ?? [])];
  const rpcCalls: Array<Record<string, unknown>> = [];
  let flagReads = 0;
  let jobReads = 0;
  const terminal = [
    "cancelled",
    "archived",
    "lost",
    "closed",
    "complete",
    "completed",
  ];
  const client = {
    from(table: string) {
      const q: Record<string, unknown> = { table };
      const builder = {
        select() {
          return builder;
        },
        eq(_c: string, v: unknown) {
          q.eq = v;
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          flagReads++;
          if (opts.flag === null || opts.flag === undefined) {
            return Promise.resolve({ data: [], error: null });
          }
          return Promise.resolve({
            data: [{ enabled: opts.flag, updated_at: "2026-10-02T00:00:00Z" }],
            error: null,
          });
        },
        in(column: string, ids: string[]) {
          jobReads++;
          if (opts.failJobsRead) {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          const key = column as "ghl_contact_id" | "ghl_opportunity_id";
          return Promise.resolve({
            data: jobs.filter((j) => j[key] && ids.includes(j[key]!)).map((
              j,
            ) => ({
              ghl_opportunity_id: j.ghl_opportunity_id,
              ghl_contact_id: j.ghl_contact_id,
              status: j.status,
            })),
            error: null,
          });
        },
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, ...args });
      const contact = String(args.p_ghl_contact_id);
      const open = jobs.filter((j) =>
        j.ghl_contact_id === contact && !terminal.includes(j.status)
      );
      if (open.length === 1) {
        return Promise.resolve({
          data: { outcome: "existing", job_id: open[0].id },
          error: null,
        });
      }
      if (open.length > 1) {
        return Promise.resolve({
          data: { outcome: "ambiguous", job_id: null },
          error: null,
        });
      }
      const id = `draft-${jobs.length + 1}`;
      jobs.push({
        id,
        status: "draft",
        ghl_contact_id: contact,
        ghl_opportunity_id: null,
        metadata: {
          booking_intake_draft: true,
          client: args.p_client,
          type: args.p_type,
        },
      });
      return Promise.resolve({
        data: { outcome: "created", job_id: id },
        error: null,
      });
    },
  };
  return { client, jobs, rpcCalls, counts: () => ({ flagReads, jobReads }) };
}

const lead = (
  opp: string,
  contact: string | null,
  extra: Record<string, string> = {},
) => ({
  opportunity_id: opp,
  contact_id: contact,
  display_name: extra.name ?? "Pat Lee",
  suburb: extra.suburb ?? "Morley",
});

Deno.test("a lead with no job gets exactly one draft job", async () => {
  const db = fakeDb({ flag: true });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "fencing",
    [lead("opp-1", "contact-0001")],
  );
  assertEquals(summary?.created, 1);
  assertEquals(db.jobs.length, 1);
  assertEquals(db.jobs[0].status, "draft");
  assertEquals(db.rpcCalls, [{
    name: "ensure_booking_draft_job",
    p_ghl_contact_id: "contact-0001",
    p_type: "fencing",
    p_client: { client_name: "Pat Lee", site_suburb: "Morley" },
  }]);
  assertEquals(summary?.created_job_ids, ["draft-1"]);
});

Deno.test("a second read does not duplicate the draft", async () => {
  const db = fakeDb({ flag: true });
  const deps = createBookingLeadDraftDeps(db.client);
  await ensureBookingLeadDrafts(deps, "patio", [lead("opp-1", "contact-0001")]);
  const second = await ensureBookingLeadDrafts(deps, "patio", [
    lead("opp-1", "contact-0001"),
  ]);
  assertEquals(db.jobs.length, 1);
  assertEquals(second?.created, 0);
  assertEquals(second?.skipped_has_job, 1);
  assertEquals(db.rpcCalls.length, 1);
});

Deno.test("two opportunities for one contact mint one draft", async () => {
  const db = fakeDb({ flag: true });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "fencing",
    [lead("opp-1", "contact-0001"), lead("opp-2", "contact-0001")],
  );
  assertEquals(summary?.created, 1);
  assertEquals(db.jobs.length, 1);
});

Deno.test("a lead that already has a job is untouched", async () => {
  const db = fakeDb({
    flag: true,
    jobs: [
      // Linked by opportunity, any status (even terminal).
      {
        id: "j1",
        status: "cancelled",
        ghl_contact_id: "contact-other",
        ghl_opportunity_id: "opp-1",
      },
      // Open job on the contact, including a form-webhook draft.
      {
        id: "j2",
        status: "draft",
        ghl_contact_id: "contact-0002",
        ghl_opportunity_id: null,
      },
      {
        id: "j3",
        status: "quoted",
        ghl_contact_id: "contact-0003",
        ghl_opportunity_id: "opp-x",
      },
    ],
  });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "fencing",
    [
      lead("opp-1", "contact-0001"),
      lead("opp-2", "contact-0002"),
      lead("opp-3", "contact-0003"),
    ],
  );
  assertEquals(summary?.skipped_has_job, 3);
  assertEquals(summary?.attempted, 0);
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(db.jobs.length, 3);
});

Deno.test("a contact whose only job is finished gets a draft for the new lead", async () => {
  const db = fakeDb({
    flag: true,
    jobs: [{
      id: "old",
      status: "complete",
      ghl_contact_id: "contact-0001",
      ghl_opportunity_id: "opp-old",
    }],
  });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "fencing",
    [lead("opp-new", "contact-0001")],
  );
  assertEquals(summary?.created, 1);
});

Deno.test("flag off or missing does nothing: no job read, no write, no summary", async () => {
  for (const flag of [false, null]) {
    const db = fakeDb({ flag });
    const summary = await ensureBookingLeadDrafts(
      createBookingLeadDraftDeps(db.client),
      "fencing",
      [lead("opp-1", "contact-0001")],
    );
    assertEquals(summary, null);
    assertEquals(db.rpcCalls.length, 0);
    assertEquals(db.counts().jobReads, 0);
    assertEquals(db.jobs.length, 0);
  }
});

Deno.test("an unreadable flag reads as off", async () => {
  const deps: BookingLeadDraftDeps = {
    readFlag: () => Promise.reject(new Error("down")),
    readLinkedJobs: () => {
      throw new Error("must not read");
    },
    ensureDraft: () => {
      throw new Error("must not write");
    },
    now: () => 0,
  };
  assertEquals(
    await ensureBookingLeadDrafts(deps, "fencing", [lead("o", "contact-0001")]),
    null,
  );
});

Deno.test("a failed linked-jobs read mints nothing", async () => {
  const db = fakeDb({ flag: true, failJobsRead: true });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "fencing",
    [lead("opp-1", "contact-0001")],
  );
  assertEquals(db.rpcCalls.length, 0);
  assertEquals(summary?.attempted, 0);
  assertEquals(typeof summary?.read_error, "string");
});

Deno.test("a lead with no contact is skipped; unnamed and suburb-less leads pass no display fields", async () => {
  const db = fakeDb({ flag: true });
  const summary = await ensureBookingLeadDrafts(
    createBookingLeadDraftDeps(db.client),
    "patio",
    [
      lead("opp-1", null),
      lead("opp-2", "contact-0002", { name: "Enquiry", suburb: "not given" }),
    ],
  );
  assertEquals(summary?.skipped_no_contact, 1);
  assertEquals(summary?.created, 1);
  assertEquals(db.rpcCalls[0].p_client, {});
  assertEquals(db.rpcCalls[0].p_type, "patio");
});

Deno.test("an RPC failure is counted, never thrown", async () => {
  const deps: BookingLeadDraftDeps = {
    readFlag: () => Promise.resolve(true),
    readLinkedJobs: () => Promise.resolve([]),
    ensureDraft: () =>
      Promise.reject(new Error("booking_draft_create_conflict")),
    now: () => 0,
  };
  const summary = await ensureBookingLeadDrafts(deps, "fencing", [
    lead("o", "contact-0001"),
  ]);
  assertEquals(summary?.failed, 1);
  assertEquals(summary?.created, 0);
});

Deno.test("the flag name is pinned", () => {
  assertEquals(BOOKING_LEAD_DRAFT_FLAG, "booking_lead_draft_job_v1");
});

// Surfaces where a lead draft must never read as work. Pinned at source
// (index.ts is too heavy to import here).
const read = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

Deno.test("trade search_all_jobs excludes draft jobs", async () => {
  const src = await read("./index.ts");
  const m = src.match(/export const _GLOBAL_SEARCH_STATUS_EXCLUDE = '([^']+)'/);
  assertEquals(
    m?.[1],
    '("deleted","duplicate","duplicated","void","voided","draft")',
  );
});

Deno.test("xero-sync contact-name auto-link never picks a draft job", async () => {
  const src = await read("../xero-sync/index.ts");
  const strategy2 = src.slice(
    src.indexOf(
      "// Strategy 2: Contact name matches a job client_name exactly",
    ),
  );
  assertEquals(
    strategy2.slice(0, 600).includes(
      `.not('status', 'in', '("cancelled","lost","draft")')`,
    ),
    true,
  );
});

Deno.test("reporting-api match_invoices name maps skip draft jobs", async () => {
  const src = await read("../reporting-api/index.ts");
  const body = src.slice(src.indexOf("async function matchInvoicesToJobs"));
  const loop = body.slice(
    body.indexOf("const nameMap"),
    body.indexOf("let matched = 0"),
  );
  assertEquals(loop.includes("if (job.status === 'draft') continue"), true);
  assertEquals(
    body.slice(0, 1500).includes("job_number, type, status')"),
    true,
  );
});

Deno.test("sales_booking_read returns lead_draft_jobs only when the flag summary exists", async () => {
  const src = await read("./index.ts");
  assertEquals(
    src.includes(
      "return json(leadDrafts ? { ...composed, lead_draft_jobs: leadDrafts } : composed)",
    ),
    true,
  );
});
