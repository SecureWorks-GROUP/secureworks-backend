// Work-order claim check (Group work orders V16): tests on real records.
//
// Every row below is a production row read on 3 Nov 2026 from
// v_trade_charge_resolved (read only). Expected values are worked by hand from
// those records, never from this module's output:
//   SWF-261209  Henry SW-INV-H-261008-006 claims Work order $1153.00 less
//               Alyx $898 (net 255.00); Alyx SW-INV-A-261011-029 claims Work
//               order $1465.00 less Kim $240 (net 1225.00); Kim
//               SW-INV-KM-261003-019 bills 8h, 240.00. Khairo's commission
//               258.00 is not labour. Labour 255 + 1225 + 240 = 1720.00.
//               Largest claim 1465.00 (Alyx). 1720.00 - 1465.00 = 255.00.
//   SWF-261090  Henry claims $400.00 less Sonny $323 (net 77.00); Sonny claims
//               Work order $245.00 (net 245.00). Commission 96.00 not labour.
//               Labour 77 + 245 = 322.00. Largest 400.00. 322 - 400 = -78.00.
//   SWF-26091   Alyx claims $627.20 less Sonny 10h $350 (net 277.20); Sonny
//               bills 10h 350.00. Commission 193.70 and 196.00 not labour.
//               Labour 277.20 + 350.00 = 627.20 = the claim. No warning.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLAIM_CHECK_UNREADABLE_WARNING,
  type ClaimCheckLine,
  claimWarningForLine,
  computeWorkOrderClaimCheck,
  loadWorkOrderClaimCheck,
  parseWorkOrderClaim,
  withClaimWarnings,
} from "./work_order_claim_check.ts";

const HENRY = "c9a84f70-6d43-43f2-8a5b-3ec6ba9ade8b";
const ALYX = "2f00f91e-8b76-4856-8dec-ab6041f04e1d";
const KIM = "e0f93e18-f8b2-4548-80fc-9ff1a2782314";
const SONNY = "42b18424-9cc8-4b7d-b249-e36285014a57";
const KHAIRO = "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415";

const NAMES = new Map([
  [HENRY, "Henry"],
  [ALYX, "Alyx"],
  [KIM, "Kim Muiruri"],
  [SONNY, "Sonny Longstaff"],
  [KHAIRO, "Khairo"],
]);

const TAIL =
  "Named crew bill SecureWorks Group directly; office to check their invoices against this breakdown.";

// SWF-261209, v_trade_charge_resolved rows.
function swf261209(): ClaimCheckLine[] {
  return [
    {
      line_id: "19ca6478-d36f-43e7-a1d8-0d027c20b6dc",
      user_id: HENRY,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "255.00",
      description:
        `Work order $1153.00.\nLess labour: Alyx 1h x $898 = $898.00.\nTotal labour deducted $898.00.\nNet payable to holder $255.00.\n${TAIL}`,
    },
    {
      line_id: "ba9a8a1c-1b09-49c4-8315-0d6e29dca5cf",
      user_id: KHAIRO,
      invoice_status: "paid",
      cost_lane: "commission",
      amount_ex: "258.00",
      description: "Commission — SWF-261209 — Estelle Sioz",
    },
    {
      line_id: "e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b",
      user_id: KIM,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "240.00",
      description: "Fencing",
    },
    {
      line_id: "fe3ebe3a-5e46-4f75-94f2-9c308ee6ce69",
      user_id: ALYX,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "1225.00",
      description:
        `Work order $1465.00.\nLess labour: Kim 8h x $30 = $240.00.\nTotal labour deducted $240.00.\nNet payable to holder $1225.00.\n${TAIL}`,
    },
  ];
}

// SWF-261090.
function swf261090(): ClaimCheckLine[] {
  return [
    {
      line_id: "33edf483-562f-454a-a0b9-3bd7a6f301e6",
      user_id: HENRY,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "77.00",
      description:
        `Work order $400.00.\nLess labour: Sonny 1h x $323 = $323.00.\nTotal labour deducted $323.00.\nNet payable to holder $77.00.\n${TAIL}`,
    },
    {
      line_id: "5bc0e733-e5ee-4fc6-841c-0006fb6b095f",
      user_id: SONNY,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "245.00",
      description:
        `Work order $245.00.\nLess labour: none declared.\nTotal labour deducted $0.00.\nNet payable to holder $245.00.\n${TAIL}`,
    },
    {
      line_id: "6ac8687c-273c-4d6c-9e78-020f773ffbd0",
      user_id: KHAIRO,
      invoice_status: "paid",
      cost_lane: "commission",
      amount_ex: "96.00",
      description: "Commission — SWF-261090 — Karen Branley",
    },
  ];
}

// SWF-26091 (clean).
function swf26091(): ClaimCheckLine[] {
  return [
    {
      line_id: "27ef2454-bf1c-4f2e-af4a-86944a526ca7",
      user_id: ALYX,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "277.20",
      description:
        `Work order $627.20.\nLess labour: Sonny 10h x $35 = $350.00.\nTotal labour deducted $350.00.\nNet payable to holder $277.20.\n${TAIL}`,
    },
    {
      line_id: "31533b09-be69-4df6-a2e4-fac48823abf3",
      user_id: SONNY,
      invoice_status: "paid",
      cost_lane: "labour",
      amount_ex: "350.00",
      description: "Helping alyx",
    },
    {
      line_id: "32307da4-91c2-40bd-954a-f77d679f543f",
      user_id: KHAIRO,
      invoice_status: "paid",
      cost_lane: "commission",
      amount_ex: "193.70",
      description: "Commission — SWF-26091 — Nadja  Kampfhenkel",
    },
    {
      line_id: "ddb3176d-d7e1-44c3-a3fa-9f3171ad1e12",
      user_id: KHAIRO,
      invoice_status: "paid",
      cost_lane: "commission",
      amount_ex: "196.00",
      description: "Commission — SWF-26091 — Nadja  Kampfhenkel",
    },
  ];
}

// ── The claim on a line ──────────────────────────────────────────────────────

Deno.test("reads the claimed total from each real claim line and nothing else", () => {
  assertEquals(parseWorkOrderClaim(swf261209()[0].description), 1153);
  assertEquals(parseWorkOrderClaim(swf261209()[3].description), 1465);
  assertEquals(parseWorkOrderClaim(swf261090()[1].description), 245);
  assertEquals(parseWorkOrderClaim(swf26091()[0].description), 627.2);
  assertEquals(parseWorkOrderClaim("Fencing"), null);
  assertEquals(parseWorkOrderClaim("Helping alyx"), null);
  assertEquals(
    parseWorkOrderClaim("Commission — SWF-261209 — Estelle Sioz"),
    null,
  );
  assertEquals(parseWorkOrderClaim(null), null);
});

// ── SWF-261209: nested leads, paid over the largest claim ────────────────────

Deno.test("SWF-261209: labour 1720.00 against largest claim 1465.00, two leads, warns", () => {
  const c = computeWorkOrderClaimCheck(swf261209(), NAMES)!;
  assertEquals(c.live_labour_ex, 1720);
  assertEquals(c.largest_claim_ex, 1465);
  assertEquals(c.claimant_count, 2);
  assertEquals(
    c.claimants.map((p) => [p.name, p.claim_ex]),
    [["Alyx", 1465], ["Henry", 1153]],
  );
  assertEquals(c.difference_ex, 255);
  assertEquals(c.warn, true);
  assertEquals(
    c.message,
    "Labour on this job $1,720.00 against the largest work-order claim $1,465.00, $255.00 more. " +
      "Two leads claimed a work order: Alyx $1,465.00, Henry $1,153.00. " +
      "Check who did the work before approving.",
  );
  assertEquals(c.claim_line_ids.sort(), [
    "19ca6478-d36f-43e7-a1d8-0d027c20b6dc",
    "fe3ebe3a-5e46-4f75-94f2-9c308ee6ce69",
  ]);
});

// ── SWF-261090: nested leads, paid under the largest claim ───────────────────

Deno.test("SWF-261090: labour 322.00 against largest claim 400.00, two leads, warns", () => {
  const c = computeWorkOrderClaimCheck(swf261090(), NAMES)!;
  assertEquals(c.live_labour_ex, 322);
  assertEquals(c.largest_claim_ex, 400);
  assertEquals(c.claimant_count, 2);
  assertEquals(c.difference_ex, -78);
  assertEquals(c.warn, true);
  assertEquals(
    c.message,
    "Labour on this job $322.00 against the largest work-order claim $400.00, $78.00 less. " +
      "Two leads claimed a work order: Henry $400.00, Sonny Longstaff $245.00. " +
      "Check who did the work before approving.",
  );
});

// ── SWF-26091: one lead, labour equals the claim ─────────────────────────────

Deno.test("SWF-26091: labour 627.20 equals the one claim 627.20, no warning", () => {
  const c = computeWorkOrderClaimCheck(swf26091(), NAMES)!;
  assertEquals(c.live_labour_ex, 627.2);
  assertEquals(c.largest_claim_ex, 627.2);
  assertEquals(c.claimant_count, 1);
  assertEquals(c.difference_ex, 0);
  assertEquals(c.warn, false);
  assertEquals(c.message, null);
});

// No real job has 2+ claimants AND labour equal to the largest claim (read 3
// Nov 2026: all 21 nested-claim jobs differ). This variant of SWF-26091 has
// Sonny bill his $350.00 as his own work order, as he did on SWF-261090, so
// the money still agrees (627.20) and only the second claimant should warn.
Deno.test("two leads claiming warns even when labour equals the largest claim (SWF-26091 variant)", () => {
  const rows = swf26091();
  rows[1].description =
    `Work order $350.00.\nLess labour: none declared.\nTotal labour deducted $0.00.\nNet payable to holder $350.00.\n${TAIL}`;
  const c = computeWorkOrderClaimCheck(rows, NAMES)!;
  assertEquals(c.live_labour_ex, 627.2);
  assertEquals(c.largest_claim_ex, 627.2);
  assertEquals(c.difference_ex, 0);
  assertEquals(c.claimant_count, 2);
  assertEquals(c.warn, true);
  assertEquals(
    c.message,
    "Labour on this job $627.20 against the largest work-order claim $627.20. " +
      "Two leads claimed a work order: Alyx $627.20, Sonny Longstaff $350.00. " +
      "Check who did the work before approving.",
  );
});

Deno.test("a job with no work-order claim has no check at all", () => {
  // SWF-26091 without Alyx's claim line: only Sonny's hours and commission.
  assertEquals(computeWorkOrderClaimCheck(swf26091().slice(1), NAMES), null);
});

// ── Live rows only ───────────────────────────────────────────────────────────

Deno.test("an ops-reject invoice is not live: SWF-261090 with Sonny's claim returned leaves Henry alone at 77.00 against 400.00", () => {
  const rows = swf261090();
  rows[1].invoice_status = "ops-reject";
  const c = computeWorkOrderClaimCheck(rows, NAMES)!;
  assertEquals(c.live_labour_ex, 77);
  assertEquals(c.largest_claim_ex, 400);
  assertEquals(c.claimant_count, 1);
  assertEquals(c.difference_ex, -323);
  assertEquals(c.warn, true);
  assertEquals(
    c.message,
    "Labour on this job $77.00 against the largest work-order claim $400.00, $323.00 less. " +
      "Check who did the work before approving.",
  );
});

Deno.test("a draft invoice is not live: SWF-261209 with Alyx's invoice still a draft", () => {
  const rows = swf261209();
  rows[3].invoice_status = "draft";
  const c = computeWorkOrderClaimCheck(rows, NAMES)!;
  // 255.00 + 240.00; Henry's 1153.00 is the only live claim.
  assertEquals(c.live_labour_ex, 495);
  assertEquals(c.largest_claim_ex, 1153);
  assertEquals(c.claimant_count, 1);
  assertEquals(c.difference_ex, -658);
});

// ── Unknown stays unknown ────────────────────────────────────────────────────

Deno.test("a labour line with no amount makes labour unknown, never 0, and still warns", () => {
  const rows = swf26091();
  rows[1].amount_ex = null;
  const c = computeWorkOrderClaimCheck(rows, NAMES)!;
  assertEquals(c.live_labour_ex, null);
  assertEquals(c.difference_ex, null);
  assertEquals(c.warn, true);
  assertEquals(
    c.message,
    "Labour on this job is not known on this read. The largest work-order claim is $627.20. " +
      "Check who did the work before approving.",
  );
});

Deno.test("a claimant whose name is not read is named as not known, not dropped", () => {
  const c = computeWorkOrderClaimCheck(swf261090(), new Map())!;
  assertEquals(c.claimant_count, 2);
  assertStringIncludes(
    c.message!,
    "Two leads claimed a work order: name not known $400.00, name not known $245.00.",
  );
});

// ── The line the office reviews ──────────────────────────────────────────────

Deno.test("only claim lines carry the warning; a failed read is said on the claim line", () => {
  const ok = {
    check: computeWorkOrderClaimCheck(swf261209(), NAMES),
    error: null,
  };
  const henry = {
    id: "19ca6478-d36f-43e7-a1d8-0d027c20b6dc",
    description: swf261209()[0].description,
    invoice_status: "paid",
  };
  const kim = {
    id: "e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b",
    description: "Fencing",
    invoice_status: "paid",
  };
  assertEquals(claimWarningForLine(ok, henry), ok.check!.message);
  assertEquals(claimWarningForLine(ok, kim), null);

  const clean = {
    check: computeWorkOrderClaimCheck(swf26091(), NAMES),
    error: null,
  };
  assertEquals(
    claimWarningForLine(clean, {
      id: "27ef2454-bf1c-4f2e-af4a-86944a526ca7",
      description: swf26091()[0].description,
      invoice_status: "paid",
    }),
    null,
  );

  const failed = { check: null, error: "labour_unreadable" };
  assertEquals(
    claimWarningForLine(failed, henry),
    CLAIM_CHECK_UNREADABLE_WARNING,
  );
  assertEquals(claimWarningForLine(failed, kim), null);
});

// ── The loader: one job's rows from the labour-lane view ─────────────────────

function fakeClient(
  viewRows: any[] | null,
  opts: { viewError?: boolean; usersError?: boolean } = {},
) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  return {
    reads,
    from(table: string) {
      const read = { table, filters: [] as Array<[string, unknown]> };
      reads.push(read);
      const q: any = {
        select() {
          return q;
        },
        eq(col: string, val: unknown) {
          read.filters.push([col, val]);
          return q;
        },
        in(col: string, vals: unknown) {
          read.filters.push([col, vals]);
          return q;
        },
        then(resolve: (v: any) => void) {
          if (table === "v_trade_charge_resolved") {
            const jobId = read.filters.find(([c]) => c === "resolved_job_id")
              ?.[1];
            resolve(
              opts.viewError
                ? { data: null, error: { message: "boom" } }
                : { data: jobId === "job-261209" ? viewRows : [], error: null },
            );
          } else if (table === "users") {
            const ids = (read.filters.find(([c]) => c === "id")?.[1] ||
              []) as string[];
            resolve(
              opts.usersError ? { data: null, error: { message: "boom" } } : {
                data: ids.map((id) => ({ id, name: NAMES.get(id) })),
                error: null,
              },
            );
          } else {
            resolve({ data: null, error: { message: "unexpected table" } });
          }
        },
      };
      return q;
    },
  };
}

function asViewRows(lines: ClaimCheckLine[]) {
  return lines.map((l) => ({
    line_id: l.line_id,
    user_id: l.user_id,
    invoice_status: l.invoice_status,
    cost_lane: l.cost_lane,
    line_total_ex: l.amount_ex,
    description: l.description,
  }));
}

Deno.test("loader: SWF-261209 read from the view by resolved job, names from users", async () => {
  const client = fakeClient(asViewRows(swf261209()));
  const read = await loadWorkOrderClaimCheck(client, "job-261209");
  assertEquals(read.error, null);
  assertEquals(read.check!.live_labour_ex, 1720);
  assertEquals(read.check!.largest_claim_ex, 1465);
  assertStringIncludes(read.check!.message!, "Alyx $1,465.00, Henry $1,153.00");
});

Deno.test("loader: a failed view read is an error, never a clean job", async () => {
  const read = await loadWorkOrderClaimCheck(
    fakeClient(null, { viewError: true }),
    "job-261209",
  );
  assertEquals(read, { check: null, error: "labour_unreadable" });
});

Deno.test("loader: a failed names read still warns, with names not known", async () => {
  const read = await loadWorkOrderClaimCheck(
    fakeClient(asViewRows(swf261209()), { usersError: true }),
    "job-261209",
  );
  assertEquals(read.error, null);
  assertEquals(read.check!.warn, true);
  assertStringIncludes(read.check!.message!, "name not known $1,465.00");
});

Deno.test("loader: another job's rows are not this job's", async () => {
  const read = await loadWorkOrderClaimCheck(
    fakeClient(asViewRows(swf261209())),
    "job-other",
  );
  assertEquals(read, { check: null, error: null });
});

// ── The listed lines the office screen reads ─────────────────────────────────

Deno.test("withClaimWarnings: list rows keep every field; claim rows get the text, others null", () => {
  const read = {
    check: computeWorkOrderClaimCheck(swf261209(), NAMES),
    error: null,
  };
  const listed = swf261209().map((l) => ({
    id: l.line_id,
    description: l.description,
    line_total_ex: l.amount_ex,
    trade_invoices: { status: l.invoice_status },
    review_state: "none",
  }));
  const out = withClaimWarnings(listed, read);
  assertEquals(out.length, 4);
  for (const row of out) assertEquals(row.review_state, "none");
  const byId = new Map(out.map((r) => [r.id, r.work_order_claim_warning]));
  assert(
    byId.get("19ca6478-d36f-43e7-a1d8-0d027c20b6dc")!.startsWith(
      "Labour on this job $1,720.00",
    ),
  );
  assert(
    byId.get("fe3ebe3a-5e46-4f75-94f2-9c308ee6ce69")!.startsWith(
      "Labour on this job $1,720.00",
    ),
  );
  assertEquals(byId.get("e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b"), null);
  assertEquals(byId.get("ba9a8a1c-1b09-49c4-8315-0d6e29dca5cf"), null);
  // The pay amounts on the rows are untouched.
  assertEquals(out.map((r) => r.line_total_ex), [
    "255.00",
    "258.00",
    "240.00",
    "1225.00",
  ]);
});

Deno.test("the warning text carries no em dash", () => {
  for (const rows of [swf261209(), swf261090()]) {
    const c = computeWorkOrderClaimCheck(rows, NAMES)!;
    assert(!c.message!.includes("—"));
  }
  assert(!CLAIM_CHECK_UNREADABLE_WARNING.includes("—"));
});
