/**
 * Group work orders (owner, confirmed 21 Oct 2026).
 *
 * The pot is the sealed agreed labour on the job work order. A participant
 * who has submitted their own hours sees that total and their own share, and
 * no other person's hours, points or share. A non-participant never reads
 * the sealed price. A job is either a normal work-order claim or this split.
 *
 * DEFAULT, owner to confirm: break minutes come off finish minus start.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";
import {
  allocatePotCents,
  assertGroupWorkOrderInvoiceFence,
  clientSignGroupWorkOrder,
  draftClientLinkMessage,
  entryPointsMicro,
  findFenceProblem,
  GROUP_FENCE_RELEASED_INVOICE_STATUSES,
  GROUP_REVIEW_URL_SEED,
  type GroupCaller,
  groupHoursFromBody,
  GroupWorkOrderError,
  isGroupShareLine,
  PARTICIPANT_SHARE_KEYS,
  participantShareResponse,
  participantShareResponseIsClosed,
  promptGoogleReview,
  readGroupWorkOrderFeedback,
  readGroupWorkOrderMyShare,
  refuseClientLinkSend,
  resolveGroupShareInvoiceExtra,
  submitGroupWorkOrderFeedback,
  visibleShareRows,
} from "./group_work_order.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "10000000-0000-4000-8000-000000000001";
const OTHER_JOB = "10000000-0000-4000-8000-000000000002";
const WO = "20000000-0000-4000-8000-000000000001";
const OTHER_WO = "20000000-0000-4000-8000-000000000002";
const GROUP = "30000000-0000-4000-8000-000000000001";
const USER_A = "40000000-0000-4000-8000-00000000000a";
const USER_B = "40000000-0000-4000-8000-00000000000b";
const USER_C = "40000000-0000-4000-8000-00000000000c";
const SHARE_A = "50000000-0000-4000-8000-00000000000a";
const INV = "60000000-0000-4000-8000-000000000001";

type Row = Record<string, unknown>;

class Memory {
  tables = new Map<string, Row[]>();
  calls: { table: string; op: string }[] = [];

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  client() {
    const memory = this;
    return {
      from(table: string) {
        return new Query(memory, table);
      },
    };
  }
}

class Query {
  private filters: { op: "eq" | "in"; col: string; value: unknown }[] = [];
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: unknown = null;
  private one: "none" | "maybe" | "single" = "none";

  constructor(private memory: Memory, private table: string) {}

  select(): this {
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push({ op: "eq", col, value });
    return this;
  }
  in(col: string, value: unknown): this {
    this.filters.push({ op: "in", col, value });
    return this;
  }
  insert(row: unknown): this {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  upsert(rows: unknown): this {
    this.op = "upsert";
    this.payload = rows;
    return this;
  }
  update(row: unknown): this {
    this.op = "update";
    this.payload = row;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  maybeSingle(): this {
    this.one = "maybe";
    return this;
  }
  single(): this {
    this.one = "single";
    return this;
  }
  then(
    resolve: (
      value: { data: unknown; error: { message?: string } | null },
    ) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.op === "eq") return row[filter.col] === filter.value;
      return (filter.value as unknown[]).includes(row[filter.col]);
    });
  }

  private run(): { data: unknown; error: { message?: string } | null } {
    this.memory.calls.push({ table: this.table, op: this.op });
    const rows = this.memory.rows(this.table);
    if (this.op === "insert") {
      const created = {
        id: crypto.randomUUID(),
        ...(this.payload as Row),
      };
      rows.push(created);
      return { data: this.one === "none" ? [created] : created, error: null };
    }
    if (this.op === "upsert") {
      for (const incoming of this.payload as Row[]) {
        const at = rows.findIndex((row) =>
          row.group_id === incoming.group_id && row.user_id === incoming.user_id
        );
        if (at >= 0) rows[at] = { ...rows[at], ...incoming };
        else rows.push({ id: crypto.randomUUID(), ...incoming });
      }
      return { data: null, error: null };
    }
    if (this.op === "update") {
      for (const row of rows) {
        if (this.matches(row)) Object.assign(row, this.payload as Row);
      }
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      const kept = rows.filter((row) => !this.matches(row));
      rows.splice(0, rows.length, ...kept);
      return { data: null, error: null };
    }
    const found = rows.filter((row) => this.matches(row));
    if (this.one === "maybe") return { data: found[0] || null, error: null };
    if (this.one === "single") {
      return found[0]
        ? { data: found[0], error: null }
        : { data: null, error: { message: "none" } };
    }
    return { data: found, error: null };
  }
}

function trade(userId: string, staff = false): GroupCaller {
  return {
    userId,
    orgId: ORG,
    role: staff ? "ops_manager" : "crew",
    isStaff: staff,
  };
}

function seedSplit(memory: Memory, status = "client_signed") {
  memory.rows("group_work_orders").push({
    id: GROUP,
    org_id: ORG,
    job_id: JOB,
    work_order_id: WO,
    status,
    share_token: "tok-secret",
    client_signed_at: status === "client_signed"
      ? "2026-10-21T01:00:00Z"
      : null,
  });
  memory.rows("group_work_order_participants").push(
    { id: "p-a", group_id: GROUP, user_id: USER_A },
    { id: "p-b", group_id: GROUP, user_id: USER_B },
  );
  memory.rows("jobs").push({
    id: JOB,
    org_id: ORG,
    job_number: "SWF-1",
    client_name: "Client",
    site_address: "1 Example St",
    site_suburb: "Subiaco",
    type: "fencing",
    work_order_id: WO,
    status: "scheduled",
  });
  memory.rows("work_orders").push(
    {
      id: WO,
      org_id: ORG,
      job_id: JOB,
      kind: "job",
      status: "approved",
      agreed_labour_ex: 482.15,
      sealed_content_hash: "sealed",
    },
    {
      id: OTHER_WO,
      org_id: ORG,
      job_id: OTHER_JOB,
      kind: "job",
      status: "approved",
      agreed_labour_ex: 9999.99,
      sealed_content_hash: "other",
    },
  );
  memory.rows("trade_rates").push(
    {
      user_id: USER_A,
      org_id: ORG,
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: null,
    },
    {
      user_id: USER_B,
      org_id: ORG,
      hourly_rate: 20,
      effective_from: "2026-01-01",
      effective_to: null,
    },
  );
}

Deno.test("shares: unequal rates floor to cents and the larger remainder takes the leftover", () => {
  const split = allocatePotCents(10000, [
    { userId: USER_A, pointsMicro: 2n },
    { userId: USER_B, pointsMicro: 1n },
  ]);
  assertEquals(split, [
    { userId: USER_A, shareCents: 6667 },
    { userId: USER_B, shareCents: 3333 },
  ]);
  assertEquals(split.reduce((sum, row) => sum + row.shareCents, 0), 10000);
});

Deno.test("shares: equal points split evenly and a three-way tie pays the smallest user id", () => {
  assertEquals(
    allocatePotCents(10000, [
      { userId: USER_B, pointsMicro: 50n },
      { userId: USER_A, pointsMicro: 50n },
    ]),
    [
      { userId: USER_A, shareCents: 5000 },
      { userId: USER_B, shareCents: 5000 },
    ],
  );
  const three = allocatePotCents(100, [
    { userId: "c", pointsMicro: 1n },
    { userId: "a", pointsMicro: 1n },
    { userId: "b", pointsMicro: 1n },
  ]);
  assertEquals(three, [
    { userId: "a", shareCents: 34 },
    { userId: "b", shareCents: 33 },
    { userId: "c", shareCents: 33 },
  ]);
  assertEquals(three.reduce((sum, row) => sum + row.shareCents, 0), 100);
});

Deno.test("shares: a missing pot and a person with no points are refused", () => {
  const missingPot = assertThrows(
    () => allocatePotCents(0, [{ userId: USER_A, pointsMicro: 1n }]),
    GroupWorkOrderError,
  );
  assertEquals(missingPot.message.includes("agreed labour"), true);
  const error = assertThrows(
    () => allocatePotCents(100, [{ userId: USER_A, pointsMicro: 0n }]),
    GroupWorkOrderError,
  );
  assertEquals(error.code, "group_share_hours_missing");
  const only = allocatePotCents(100, [
    { userId: USER_A, pointsMicro: 0n },
    { userId: USER_B, pointsMicro: 4n },
  ]);
  assertEquals(only, [{ userId: USER_B, shareCents: 100 }]);
});

Deno.test("points follow rate times hours, in proportion", () => {
  assertEquals(entryPointsMicro(40, 2), 800_000n);
  assertEquals(entryPointsMicro(20, 2), 400_000n);
  assertEquals(entryPointsMicro(0, 2), 0n);
});

Deno.test("my-share response is the closed key set, and the pot is hidden until hours are in", () => {
  const before = participantShareResponse({
    groupId: GROUP,
    clientSigned: false,
    ownHours: 0,
    potEx: 482.15,
    myShareEx: 321.43,
  });
  assert(participantShareResponseIsClosed(before));
  assertEquals(before.pot_total, null);
  assertEquals(before.my_share, null);
  assertEquals(before.needs_hours, true);
  assertEquals(Object.keys(before).sort(), [...PARTICIPANT_SHARE_KEYS].sort());
  const after = participantShareResponse({
    groupId: GROUP,
    clientSigned: true,
    ownHours: 2,
    potEx: 482.15,
    myShareEx: 321.43,
  });
  assertEquals(after.pot_total, 482.15);
  assertEquals(after.my_share, 321.43);
  assertEquals(
    { ...after, points: 1 }.points !== undefined &&
      !participantShareResponseIsClosed({ ...after, points: 1 }),
    true,
  );
});

Deno.test("a trade sees only their own share row; staff see the split", () => {
  const rows = [
    { user_id: USER_A, job_id: JOB, share_ex: 321.43, pot_ex: 482.15 },
    { user_id: USER_B, job_id: JOB, share_ex: 160.72, pot_ex: 482.15 },
    { user_id: USER_C, job_id: OTHER_JOB, share_ex: 9999.99, pot_ex: 9999.99 },
  ];
  assertEquals(
    visibleShareRows(USER_A, false, rows).map((row) => row.user_id),
    [USER_A],
  );
  assertEquals(visibleShareRows(USER_A, true, rows).length, 3);
});

Deno.test("non-participant cannot read the sealed price, and a participant sees only their own share", async () => {
  const hidden = new Memory();
  seedSplit(hidden);
  hidden.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const refused = await assertRejects(
    () =>
      readGroupWorkOrderMyShare(hidden.client(), trade(USER_C), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(refused.status, 403);
  assertEquals(refused.message.includes("482"), false);
  assertEquals(
    hidden.calls.some((call) => call.table === "work_orders"),
    false,
  );

  const waiting = new Memory();
  seedSplit(waiting);
  const before = await readGroupWorkOrderMyShare(
    waiting.client(),
    trade(USER_A),
    { group_id: GROUP },
  );
  assert(participantShareResponseIsClosed(before));
  assertEquals(before.pot_total, null);
  assertEquals(before.my_share, null);
  assertEquals(
    waiting.calls.some((call) => call.table === "work_orders"),
    false,
  );

  const shown = new Memory();
  seedSplit(shown);
  shown.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const mine = await readGroupWorkOrderMyShare(shown.client(), trade(USER_A), {
    group_id: GROUP,
  });
  assert(participantShareResponseIsClosed(mine));
  assertEquals(mine.pot_total, 482.15);
  assertEquals(mine.my_share, 321.43);
  const text = JSON.stringify(mine);
  assertEquals(text.includes(USER_B), false);
  assertEquals(text.includes("160.72"), false);
  assertEquals(text.includes("9999.99"), false);
  assertEquals(text.includes("points"), false);
  const readOrders = shown.calls.filter((call) => call.table === "work_orders");
  assertEquals(readOrders.length, 1);
});

Deno.test("client sign-off gates the share, and the line is quantity 1 at the server share", async () => {
  const closed = new Memory();
  seedSplit(closed, "open");
  closed.rows("group_work_order_time_entries").push({
    group_id: GROUP,
    user_id: USER_A,
    work_date: "2026-10-20",
    hours: 2,
  });
  const unsigned = await assertRejects(
    () =>
      resolveGroupShareInvoiceExtra(closed.client(), {
        userId: USER_A,
        item: { type: "group share", group_id: GROUP, job_id: JOB },
      }),
    GroupWorkOrderError,
  );
  assertEquals(unsigned.code, "group_client_signoff_required");
  assertEquals(unsigned.status, 409);

  const billed = new Memory();
  seedSplit(billed);
  billed.rows("group_work_order_time_entries").push({
    group_id: GROUP,
    user_id: USER_A,
    work_date: "2026-10-20",
    hours: 2,
  });
  billed.rows("group_work_order_shares").push({
    id: SHARE_A,
    group_id: GROUP,
    user_id: USER_A,
    hours: 2,
    points: 80,
    share_ex: 40,
    pot_ex: 482.15,
  });
  billed.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: SHARE_A,
    trade_invoice_id: INV,
    line_type: "group share",
  });
  billed.rows("trade_invoices").push({
    id: INV,
    status: "pending_acknowledgment",
    user_id: USER_A,
  });
  const mismatch = await assertRejects(
    () =>
      resolveGroupShareInvoiceExtra(billed.client(), {
        userId: USER_A,
        item: { type: "group share", group_id: GROUP, quantity: 1, rate: 99 },
      }),
    GroupWorkOrderError,
  );
  assertEquals(mismatch.code, "group_share_amount_mismatch");
  const line = await resolveGroupShareInvoiceExtra(billed.client(), {
    userId: USER_A,
    item: { type: "group share", group_id: GROUP },
  });
  assertEquals(line?.quantity, 1);
  assertEquals(line?.unit_rate, 40);
  assertEquals(line?.line_total_ex, 40);
  assertEquals(line?.total_hours, 0);
  assertEquals(line?.source_work_order_id, null);
  assertEquals(line?.group_share_id, SHARE_A);
});

Deno.test("the claim fence is mutual, travel is not a claim, and another person's share is not mine", () => {
  const share = {
    job_id: JOB,
    line_type: "group share",
    group_share_id: SHARE_A,
  };
  const hours = { job_id: JOB, line_type: "labour" };
  const travel = {
    job_id: JOB,
    line_type: "travel",
    source_work_order_id: "crew-wo",
  };
  assertEquals(
    findFenceProblem(USER_A, [share], [hours])?.code,
    "group_share_blocked_by_work_order_claim",
  );
  assertEquals(
    findFenceProblem(USER_A, [hours], [{ ...share, user_id: USER_B }])?.code,
    "work_order_claim_blocked_by_group_share",
  );
  assertEquals(
    findFenceProblem(USER_A, [share, hours], [])?.code,
    "group_share_mixed_with_hours",
  );
  assertEquals(
    findFenceProblem(USER_A, [share], [{ ...share, user_id: USER_B }]),
    null,
  );
  assertEquals(
    findFenceProblem(USER_A, [share], [{ ...share, user_id: USER_A }])?.code,
    "group_share_already_invoiced",
  );
  assertEquals(findFenceProblem(USER_A, [share], [travel]), null);
  assertEquals(
    isGroupShareLine({
      job_id: JOB,
      source_work_order_id: "x",
      line_type: "labour",
    }),
    false,
  );
});

Deno.test("invoice fence reads live claims and ignores a released draft", async () => {
  const memory = new Memory();
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    line_type: "labour",
    source_work_order_id: null,
    group_share_id: null,
    trade_invoice_id: INV,
  });
  memory.rows("trade_invoices").push({
    id: INV,
    status: "draft",
    user_id: USER_B,
  });
  await assertGroupWorkOrderInvoiceFence(memory.client(), {
    userId: USER_A,
    lines: [{ job_id: JOB, line_type: "group share", group_share_id: SHARE_A }],
  });
  memory.rows("trade_invoices")[0].status = "pending_acknowledgment";
  const blocked = await assertRejects(
    () =>
      assertGroupWorkOrderInvoiceFence(memory.client(), {
        userId: USER_A,
        lines: [{
          job_id: JOB,
          line_type: "group share",
          group_share_id: SHARE_A,
        }],
      }),
    GroupWorkOrderError,
  );
  assertEquals(blocked.code, "group_share_blocked_by_work_order_claim");
});

Deno.test("DEFAULT: break comes off finish minus start", () => {
  const entry = groupHoursFromBody({
    work_date: "2026-10-21",
    start_time: "08:00",
    finish_time: "12:00",
    break_minutes: 30,
  }, "2026-10-21");
  assertEquals(entry.hours, 3.5);
  assertEquals(entry.break_minutes, 30);
});

Deno.test("sending the client link is refused and nothing is addressed to a sender", () => {
  const refused = assertThrows(
    () => refuseClientLinkSend({ send: true }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "client_message_disabled");
  assertEquals(refused.status, 409);
  refuseClientLinkSend({ send: false });
  const draft = draftClientLinkMessage({
    firstName: "Alex",
    site: "Subiaco",
    link: "https://example.test/sign",
  });
  assert(draft.includes("The installers do not see what you write."));
  assert(draft.includes("https://example.test/sign"));
  assertEquals(GROUP_REVIEW_URL_SEED, GOOGLE_REVIEW_URL);
});

Deno.test("feedback is office-only, and a good rating names the configured review link", async () => {
  const refused = await assertRejects(
    () =>
      readGroupWorkOrderFeedback({} as never, trade(USER_A), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(refused.status, 403);
  assertEquals(promptGoogleReview([4, 4, 4, 4, 4], 4), true);
  assertEquals(promptGoogleReview([4, 4, 3, 4, 4], 4), false);

  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_settings").push({
    id: 1,
    google_review_url: "https://review.example/configured",
    review_prompt_min_rating: 4,
  });
  const good = await submitGroupWorkOrderFeedback(memory.client(), {
    share_token: "tok-secret",
    sales_process: 5,
    communication: 5,
    cleanliness: 5,
    punctuality: 5,
    crew: 5,
  });
  assertEquals(good.prompt_google_review, true);
  assertEquals(good.google_review_url, "https://review.example/configured");
  assertEquals(JSON.stringify(good).includes(GOOGLE_REVIEW_URL), false);
  const jobs = memory.rows("jobs");
  assertEquals(jobs[0].status, "scheduled");
});

Deno.test("client sign records the signature and does not complete the job", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  const signed = await clientSignGroupWorkOrder(memory.client(), {
    share_token: "tok-secret",
    signer_name: "Alex Client",
    signed_via: "share_link",
  });
  assertEquals(signed.client_signed, true);
  assertEquals(memory.rows("jobs")[0].status, "scheduled");
  assertEquals(memory.rows("group_work_orders")[0].status, "client_signed");
  const again = await clientSignGroupWorkOrder(memory.client(), {
    share_token: "tok-secret",
    signer_name: "Alex Client",
  });
  assertEquals(again.already_signed, true);
});

Deno.test("ops-api wires the share, the fence, and the trade and public doors", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const setBody = (name: string) => {
    const start = source.indexOf(`const ${name} = new Set([`);
    assert(start > 0);
    return source.slice(start, source.indexOf("])", start));
  };
  const profile = setBody("OPS_API_PROFILE_SCOPED_JWT_ACTIONS");
  for (
    const action of [
      "create_group_work_order",
      "join_group_work_order",
      "sign_group_work_order",
      "submit_group_work_order_hours",
      "group_work_order_my_share",
      "group_work_order_preview_client_link",
    ]
  ) {
    assert(profile.includes(`'${action}'`));
    assertEquals(source.split(`case '${action}':`).length - 1, 2);
  }
  assertEquals(profile.includes("group_work_order_feedback"), false);
  assertEquals(profile.includes("group_work_order_office"), false);
  const pub = setBody("OPS_API_STATIC_KEY_COMPATIBLE_ACTIONS");
  for (
    const action of [
      "group_work_order_public",
      "group_work_order_client_sign",
      "group_work_order_submit_feedback",
    ]
  ) {
    assert(pub.includes(`'${action}'`));
  }
  assert(source.includes("resolveGroupShareInvoiceExtra"));
  assert(source.includes("assertGroupWorkOrderInvoiceFence"));
  assert(source.includes("group_share_id: dbLine.group_share_id || null"));
  assert(
    source.includes(
      "const RELEASED_INVOICE_STATUSES: readonly string[] = ['draft', 'failed', 'ops-reject']",
    ),
  );
  assertEquals([...GROUP_FENCE_RELEASED_INVOICE_STATUSES], [
    "draft",
    "failed",
    "ops-reject",
  ]);
  const moduleSource = await Deno.readTextFile(
    new URL("./group_work_order.ts", import.meta.url),
  );
  assert(moduleSource.includes("DEFAULT, owner to confirm"));
  assertEquals(moduleSource.includes("send_review_request"), false);
  assertEquals(moduleSource.includes("complete_my_job"), false);
  assertEquals(moduleSource.includes("send_sms"), false);
});
